import { and, desc, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  integrationSources,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
  sourceRecordDocuments,
  sourceRecordVersions,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import {
  EMAIL_ATTACHMENT_EXTRACTION_VERSION,
  hasReusableEmailAttachmentExtraction,
} from "./email-attachment-extraction";
import { deriveDocumentSourceFacts, standaloneDocumentExternalId } from "./email-attachment-source";
import { runDuplicateMatchingForSource } from "./duplicate-engine";
import { isStandaloneTransactionBearing } from "./document-intake-policy";
import { enrichCandidateFromExtractedFacts } from "./candidate-correction";

const STANDALONE_DOCUMENT_PROVIDER = "document_upload";
const STANDALONE_DOCUMENT_SOURCE_ID = "document_upload:standalone";

export interface StandaloneDocumentIntakeContext {
  db: DbExecutor;
  orgId: string;
  userId: string;
}

export interface StandaloneDocumentIntakeInput {
  documentId: string;
  filename: string;
  contentType: string;
  documentType: string;
  fallbackDate?: string;
}

export type DocumentExtractionStatus = "cached" | "queued" | "unsupported";

const TRANSACTION_DOCUMENT_TYPES = new Set(["receipt", "bill", "invoice", "other"]);

function supportsMatchingExtraction(filename: string, contentType: string): boolean {
  const extension = filename.split(".").pop()?.toLowerCase();
  return (
    contentType === "application/pdf" ||
    contentType.startsWith("image/") ||
    extension === "pdf" ||
    ["jpg", "jpeg", "png", "gif", "webp"].includes(extension ?? "")
  );
}

function candidateTransactionType(
  direction: string,
): "pay_in" | "pay_out" | "journal" | "transfer" {
  if (direction === "inflow") return "pay_in";
  if (direction === "outflow") return "pay_out";
  if (direction === "neutral") return "transfer";
  return "journal";
}

async function ensureStandaloneIntegrationSource(db: DbExecutor, orgId: string) {
  const [existing] = await db
    .select()
    .from(integrationSources)
    .where(
      and(
        eq(integrationSources.organizationId, orgId),
        eq(integrationSources.provider, STANDALONE_DOCUMENT_PROVIDER),
        eq(integrationSources.externalSourceId, STANDALONE_DOCUMENT_SOURCE_ID),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(integrationSources)
    .values({
      organizationId: orgId,
      provider: STANDALONE_DOCUMENT_PROVIDER,
      channel: "upload",
      externalSourceId: STANDALONE_DOCUMENT_SOURCE_ID,
      name: "Standalone document upload",
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [concurrent] = await db
    .select()
    .from(integrationSources)
    .where(
      and(
        eq(integrationSources.organizationId, orgId),
        eq(integrationSources.provider, STANDALONE_DOCUMENT_PROVIDER),
        eq(integrationSources.externalSourceId, STANDALONE_DOCUMENT_SOURCE_ID),
      ),
    )
    .limit(1);
  if (!concurrent) throw new Error("Unable to initialize standalone document intake.");
  return concurrent;
}

async function ensureCandidateDocumentAttachment(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
  documentId: string,
) {
  const [existing] = await db
    .select({ id: documentAttachments.id })
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documentAttachments.documentId, documentId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        eq(documentAttachments.linkableId, candidateId),
      ),
    )
    .limit(1);
  if (existing) return;
  await db.insert(documentAttachments).values({
    organizationId: orgId,
    documentId,
    linkableType: "transaction_candidate",
    linkableId: candidateId,
  });
}

async function queueStandaloneDocumentExtraction(
  ctx: StandaloneDocumentIntakeContext,
  input: StandaloneDocumentIntakeInput,
  documentId: string,
  fallbackCurrency: string,
): Promise<string | null> {
  const dedupeKey = `standalone-document-extraction:v${EMAIL_ATTACHMENT_EXTRACTION_VERSION}:${documentId}`;
  const [created] = await ctx.db
    .insert(processingJobs)
    .values({
      organizationId: ctx.orgId,
      jobType: "process_standalone_document",
      dedupeKey,
      payload: {
        documentId,
        filename: input.filename,
        contentType: input.contentType,
        documentType: input.documentType,
        fallbackDate: input.fallbackDate ?? null,
        fallbackCurrency,
        userId: ctx.userId,
      },
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  if (created) return created.id;

  const [existing] = await ctx.db
    .select({
      id: processingJobs.id,
      status: processingJobs.status,
      attempts: processingJobs.attempts,
      maxAttempts: processingJobs.maxAttempts,
    })
    .from(processingJobs)
    .where(
      and(eq(processingJobs.organizationId, ctx.orgId), eq(processingJobs.dedupeKey, dedupeKey)),
    )
    .orderBy(desc(processingJobs.createdAt))
    .limit(1);
  if (!existing) return null;
  if (
    existing.status === "failed" ||
    (existing.status === "queued" && existing.attempts >= existing.maxAttempts)
  ) {
    const [requeued] = await ctx.db
      .update(processingJobs)
      .set({
        status: "queued",
        attempts: 0,
        runAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(processingJobs.id, existing.id),
          eq(processingJobs.organizationId, ctx.orgId),
          eq(processingJobs.status, existing.status),
        ),
      )
      .returning({ id: processingJobs.id });
    return requeued?.id ?? existing.id;
  }
  return existing.id;
}

/**
 * Turn a user-initiated standalone upload into one retry-safe Inbox candidate.
 *
 * Entity-scoped uploads deliberately bypass this service. The source identity
 * is the canonical document hash, while a separate source row preserves that
 * the same bytes arrived through the standalone upload channel.
 */
export async function intakeStandaloneDocument(
  ctx: StandaloneDocumentIntakeContext,
  input: StandaloneDocumentIntakeInput,
) {
  const { db, orgId, userId } = ctx;
  const [storedDocument] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.organizationId, orgId), eq(documents.id, input.documentId)))
    .limit(1);
  if (!storedDocument) throw new Error("Uploaded document was not found.");

  const [settings] = await db
    .select({ baseCurrency: organizationAccountingSettings.baseCurrency })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  const baseCurrency = settings?.baseCurrency?.toUpperCase() || "USD";
  const effectiveDocumentType =
    storedDocument.documentType === "other" ? input.documentType : storedDocument.documentType;

  const canonicalDocument = storedDocument;
  let extractionStatus: DocumentExtractionStatus;
  let processingJobId: string | null = null;
  if (hasReusableEmailAttachmentExtraction(storedDocument)) {
    extractionStatus = "cached";
  } else if (
    TRANSACTION_DOCUMENT_TYPES.has(effectiveDocumentType) &&
    supportsMatchingExtraction(input.filename, input.contentType)
  ) {
    processingJobId = await queueStandaloneDocumentExtraction(
      ctx,
      input,
      storedDocument.id,
      baseCurrency,
    );
    extractionStatus = "queued";
  } else {
    extractionStatus = "unsupported";
  }

  const externalId = standaloneDocumentExternalId(canonicalDocument);
  const fallbackDate = input.fallbackDate ?? new Date().toISOString().slice(0, 10);
  const facts = deriveDocumentSourceFacts({
    externalId,
    provider: STANDALONE_DOCUMENT_PROVIDER,
    filename: input.filename,
    documentType: effectiveDocumentType,
    document: canonicalDocument,
    fallbackDate,
    originalCurrency: baseCurrency,
    functionalCurrency: baseCurrency,
  });
  if (!isStandaloneTransactionBearing(effectiveDocumentType, facts)) {
    return {
      sourceRecord: null,
      candidate: null,
      inboxItem: null,
      document: canonicalDocument,
      extractionStatus,
      match: null,
      deduplicated: false,
      skipped: true,
      skipReason:
        extractionStatus === "queued"
          ? ("pending_matching_extraction" as const)
          : ("non_transaction_document" as const),
      processingJobId,
    };
  }

  const source = await ensureStandaloneIntegrationSource(db, orgId);
  const rawData = {
    intakeMode: "standalone",
    documentId: canonicalDocument.id,
    contentHash: canonicalDocument.contentHash,
    filename: input.filename,
    contentType: input.contentType,
    extractedFrom: facts.extractedFrom,
    extractionStatus,
    processingJobId,
  };

  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${"standalone-document:" + orgId + ":" + source.id + ":" + externalId},
        0::bigint
      )
    )
  `);
  const [existingSource] = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.organizationId, orgId),
        eq(sourceRecords.sourceId, source.id),
        eq(sourceRecords.externalId, externalId),
      ),
    )
    .orderBy(
      sql`case when ${sourceRecords.recordState} <> 'superseded' then 0 else 1 end`,
      desc(sourceRecords.updatedAt),
    )
    .limit(1);

  let sourceRecord = existingSource;
  if (!sourceRecord) {
    [sourceRecord] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        sourceId: source.id,
        recordType: "document_upload",
        externalId: facts.externalId,
        externalVersion: facts.externalVersion,
        providerStatus: extractionStatus === "cached" ? "processed" : "processing",
        transactionDate: facts.transactionDate,
        description: facts.description,
        amount: facts.amount,
        currency: facts.currency,
        economicEventClass: facts.economicEventClass,
        direction: facts.direction,
        originalAmount: facts.originalAmount,
        originalCurrency: facts.originalCurrency,
        functionalAmount: facts.functionalAmount,
        functionalCurrency: facts.functionalCurrency,
        effectiveDate: facts.effectiveDate,
        normalizedParty: facts.normalizedParty,
        normalizedReference: facts.normalizedReference,
        sourceAccountRef: facts.sourceAccountRef,
        matcherInputHash: facts.matcherInputHash,
        matcherVersion: facts.matcherVersion,
        rawData,
      })
      .onConflictDoNothing()
      .returning();
  }
  if (!sourceRecord) {
    [sourceRecord] = await db
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, orgId),
          eq(sourceRecords.sourceId, source.id),
          eq(sourceRecords.externalId, externalId),
        ),
      )
      .orderBy(
        sql`case when ${sourceRecords.recordState} <> 'superseded' then 0 else 1 end`,
        desc(sourceRecords.updatedAt),
      )
      .limit(1);
  }
  if (!sourceRecord) throw new Error("Standalone document source could not be persisted.");

  const providerStatus = extractionStatus === "cached" ? "processed" : "processing";
  const [updatedSourceRecord] = await db
    .update(sourceRecords)
    .set({
      externalVersion: facts.externalVersion,
      providerStatus,
      transactionDate: facts.transactionDate,
      description: facts.description,
      amount: facts.amount,
      currency: facts.currency,
      economicEventClass: facts.economicEventClass,
      direction: facts.direction,
      originalAmount: facts.originalAmount,
      originalCurrency: facts.originalCurrency,
      functionalAmount: facts.functionalAmount,
      functionalCurrency: facts.functionalCurrency,
      effectiveDate: facts.effectiveDate,
      normalizedParty: facts.normalizedParty,
      normalizedReference: facts.normalizedReference,
      sourceAccountRef: facts.sourceAccountRef,
      matcherInputHash: facts.matcherInputHash,
      matcherVersion: facts.matcherVersion,
      rawData,
      updatedAt: new Date(),
    })
    .where(and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, sourceRecord.id)))
    .returning();
  sourceRecord = updatedSourceRecord ?? sourceRecord;

  await db
    .insert(sourceRecordVersions)
    .values({
      organizationId: orgId,
      sourceRecordId: sourceRecord.id,
      externalVersion: facts.externalVersion,
      payloadHash: canonicalDocument.contentHash,
      providerStatus,
      rawData,
    })
    .onConflictDoUpdate({
      target: [sourceRecordVersions.sourceRecordId, sourceRecordVersions.externalVersion],
      set: {
        payloadHash: canonicalDocument.contentHash,
        providerStatus,
        rawData,
      },
    });
  await db
    .insert(sourceRecordDocuments)
    .values({
      organizationId: orgId,
      sourceRecordId: sourceRecord.id,
      documentId: canonicalDocument.id,
      relationship: "primary_document",
    })
    .onConflictDoNothing();

  const [existingCandidate] = await db
    .select({
      candidate: transactionCandidates,
      inboxItem: inboxItems,
    })
    .from(transactionCandidates)
    .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.sourceRecordId, sourceRecord.id),
      ),
    )
    .orderBy(desc(transactionCandidates.updatedAt))
    .limit(1);
  if (existingCandidate) {
    await ensureCandidateDocumentAttachment(
      db,
      orgId,
      existingCandidate.candidate.id,
      canonicalDocument.id,
    );
    if (extractionStatus === "cached") {
      await enrichCandidateFromExtractedFacts({ db, orgId }, existingCandidate.candidate.id, [
        facts,
      ]);
    }
    const [currentCandidate] = await db
      .select({
        candidate: transactionCandidates,
        inboxItem: inboxItems,
      })
      .from(transactionCandidates)
      .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
      .where(
        and(
          eq(transactionCandidates.organizationId, orgId),
          eq(transactionCandidates.id, existingCandidate.candidate.id),
        ),
      )
      .limit(1);
    const match = await runDuplicateMatchingForSource(
      { db, orgId, userId },
      sourceRecord.id,
      "document_attached",
    );
    await db
      .insert(workflowEvents)
      .values({
        organizationId: orgId,
        inboxItemId: existingCandidate.inboxItem.id,
        entityType: "source_record",
        entityId: sourceRecord.id,
        action: "exact_replay_suppressed",
        actorType: "user",
        actorId: userId,
        idempotencyKey: `exact-replay:standalone-document:${sourceRecord.id}`,
        data: {
          replayType: "document_content_hash",
          documentId: canonicalDocument.id,
          contentHash: canonicalDocument.contentHash,
        },
      })
      .onConflictDoNothing();
    return {
      sourceRecord,
      candidate: currentCandidate?.candidate ?? existingCandidate.candidate,
      inboxItem: currentCandidate?.inboxItem ?? existingCandidate.inboxItem,
      document: canonicalDocument,
      extractionStatus,
      match,
      deduplicated: true,
      processingJobId,
    };
  }

  const transactionDate = facts.transactionDate ?? fallbackDate;
  const originalCurrency = facts.originalCurrency ?? baseCurrency;
  const functionalAmount =
    originalCurrency === baseCurrency ? (facts.functionalAmount ?? facts.originalAmount) : null;
  const [candidate] = await db
    .insert(transactionCandidates)
    .values({
      organizationId: orgId,
      sourceRecordId: sourceRecord.id,
      candidateType: "document_transaction",
      transactionDate,
      transactionType: candidateTransactionType(facts.direction),
      memo: facts.description,
      referenceNumber: facts.normalizedReference,
      originalCurrency,
      functionalCurrency: baseCurrency,
      exchangeRate: "1",
      originalTotal: facts.originalAmount,
      functionalTotal: functionalAmount,
      submittedBy: userId,
    })
    .returning();
  await db.insert(transactionCandidateSources).values({
    organizationId: orgId,
    candidateId: candidate.id,
    sourceRecordId: sourceRecord.id,
    relationship: "origin",
    isPrimary: true,
  });
  await ensureCandidateDocumentAttachment(db, orgId, candidate.id, canonicalDocument.id);
  const [inboxItem] = await db
    .insert(inboxItems)
    .values({
      organizationId: orgId,
      candidateId: candidate.id,
      sourceRecordId: sourceRecord.id,
      itemType: "classify_source_record",
      state: "needs_information",
      title: facts.description.slice(0, 255),
      submittedBy: userId,
    })
    .returning();
  await db.insert(reviewFindings).values({
    organizationId: orgId,
    inboxItemId: inboxItem.id,
    candidateId: candidate.id,
    ruleKey: "uncategorized",
    impact: "blocking",
    subjectType: "transaction_candidate",
    subjectId: candidate.id,
    fingerprint: `${candidate.id}:1:uncategorized`,
    message: "The uploaded document still needs accounting categories before it can be posted.",
    evidence: {
      source: STANDALONE_DOCUMENT_PROVIDER,
      documentId: canonicalDocument.id,
      extractionStatus,
    },
  });
  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: inboxItem.id,
    entityType: "inbox_item",
    entityId: inboxItem.id,
    action: "received",
    actorType: "user",
    actorId: userId,
    idempotencyKey: `standalone-document:${sourceRecord.id}:received`,
    data: {
      sourceRecordId: sourceRecord.id,
      documentId: canonicalDocument.id,
      extractionStatus,
    },
  });
  if (extractionStatus === "cached") {
    await enrichCandidateFromExtractedFacts({ db, orgId }, candidate.id, [facts]);
  }
  const [currentCandidate] = await db
    .select({
      candidate: transactionCandidates,
      inboxItem: inboxItems,
    })
    .from(transactionCandidates)
    .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, candidate.id),
      ),
    )
    .limit(1);
  const match = await runDuplicateMatchingForSource(
    { db, orgId, userId },
    sourceRecord.id,
    "document_attached",
  );

  return {
    sourceRecord,
    candidate: currentCandidate?.candidate ?? candidate,
    inboxItem: currentCandidate?.inboxItem ?? inboxItem,
    document: canonicalDocument,
    extractionStatus,
    match,
    deduplicated: false,
    processingJobId,
  };
}
