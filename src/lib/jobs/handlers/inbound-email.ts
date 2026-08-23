/**
 * Job handler for `process_inbound_email`.
 *
 * Extracted verbatim from the durable Inbox worker route. Processes one
 * inbound Resend email idempotently: fetches attachments, creates child
 * source records under advisory locks, splits economic events into
 * candidates, and finalizes atomically with a lease-fenced completion
 * update (`status = 'running' AND locked_by = workerId`).
 */
import { Resend } from "resend";
import { and, eq, sql } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { completeProcessingJob } from "@/lib/inbox/processing-job-lease";
import {
  inboxItems,
  ingestionEvents,
  reviewFindings,
  sourceRecordDocuments,
  sourceRecordVersions,
  sourceRecords,
  transactionCandidates,
  transactionCandidateSources,
  workflowEvents,
} from "@/db/schema/inbox";
import { isR2Configured } from "@/lib/storage";
import { ensureDocument } from "@/lib/documents/ensure-document";
import {
  enrichCandidateFromExtractedFacts,
  isCandidateEnrichmentFactComplete,
} from "@/lib/inbox/candidate-correction";
import { runDuplicateMatchingForSource } from "@/lib/inbox/duplicate-engine";
import {
  deriveEmailBodySourceFacts,
  factsCorroborateSameEconomicEvent,
} from "@/lib/inbox/email-body-source";
import { ensureDocumentMatchingExtraction } from "@/lib/inbox/email-attachment-extraction";
import { isPdfPasswordRequiredError } from "@/lib/pdf-unlock";
import { deriveEmailAttachmentSourceFacts } from "@/lib/inbox/email-attachment-source";
import type { DocumentSourceFacts } from "@/lib/inbox/email-attachment-source";
import { createLogger } from "@/lib/logger";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("api.internal.inbox-worker");

function documentType(filename: string, contentType: string) {
  const normalized = `${filename} ${contentType}`.toLowerCase();
  if (normalized.includes("receipt")) return "receipt" as const;
  if (normalized.includes("invoice")) return "invoice" as const;
  if (normalized.includes("bill")) return "bill" as const;
  return "other" as const;
}

interface ProcessedEmailChild {
  sourceRecordId: string;
  facts: DocumentSourceFacts;
  kind: "attachment" | "body";
  extractionError: string | null;
  attachmentId?: string;
  documentId?: string;
  documentDeduplicated?: boolean;
}

interface EmailCandidateUnit {
  primary: ProcessedEmailChild;
  corroborating: ProcessedEmailChild[];
}

function transactionTypeForDirection(direction: DocumentSourceFacts["direction"]) {
  if (direction === "outflow") return "pay_out" as const;
  if (direction === "inflow") return "pay_in" as const;
  if (direction === "neutral") return "transfer" as const;
  return "journal" as const;
}

export async function processInboundEmailJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const { workerId } = ctx;
  const payload = job.payload as {
    emailId?: string;
    sourceRecordId?: string;
    inboxItemId?: string;
  };
  if (!payload.emailId || !payload.sourceRecordId || !payload.inboxItemId) {
    throw new Error("Inbound email job payload is incomplete.");
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  if (!isR2Configured()) throw new Error("Document storage is not configured.");

  // Worker paths hold system context: no interactive session exists, and the
  // job row itself is the authorization record. Each DB phase runs in its own
  // short org-context transaction; the Resend fetches happen between them.
  const orgTx = <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
    withOrgContext(job.organizationId, "system", "admin", fn);

  const [emailItemContext] = await orgTx((tx) =>
    tx
      .select({
        inboxItem: inboxItems,
        candidate: transactionCandidates,
      })
      .from(inboxItems)
      .innerJoin(transactionCandidates, eq(inboxItems.candidateId, transactionCandidates.id))
      .where(
        and(
          eq(inboxItems.organizationId, job.organizationId),
          eq(inboxItems.id, payload.inboxItemId!),
        ),
      )
      .limit(1),
  );
  const [parentEmailSource] = await orgTx((tx) =>
    tx
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, job.organizationId),
          eq(sourceRecords.id, payload.sourceRecordId!),
        ),
      )
      .limit(1),
  );
  if (!emailItemContext || !parentEmailSource) {
    throw new Error("Inbound email source, candidate, or Inbox item was not found.");
  }
  const emailContext = {
    ...emailItemContext,
    sourceRecord: parentEmailSource,
  };
  const integrationSourceId = parentEmailSource.sourceId;
  if (!integrationSourceId) {
    throw new Error("Inbound email source is not associated with an integration source.");
  }

  const resend = new Resend(apiKey);
  const emailResponse = await resend.emails.receiving.get(payload.emailId);
  if (emailResponse.error || !emailResponse.data) {
    throw new Error(emailResponse.error?.message ?? "Resend email could not be retrieved.");
  }
  const processedAttachments: {
    attachmentId: string;
    childSourceRecordId: string;
    documentId: string;
    documentDeduplicated: boolean;
    extractionStatus: "cached_or_extracted" | "needs_information";
  }[] = [];
  const processedChildren: ProcessedEmailChild[] = [];
  const failedAttachments: { filename: string; error: string }[] = [];
  for (const rawAttachment of emailResponse.data.attachments) {
    // Resend allows a null filename (inline parts, some forwarders). Name it
    // from the attachment id so downstream type/extension detection, dedupe,
    // and the failure log all still have something stable to work with.
    const attachment = {
      ...rawAttachment,
      filename: rawAttachment.filename ?? `attachment-${rawAttachment.id}`,
    };
    // Fetch each attachment independently: one unavailable attachment must
    // degrade to a skip (recorded below), not fail the whole email job.
    let buffer: Buffer;
    try {
      const attachmentResponse = await resend.emails.receiving.attachments.get({
        emailId: payload.emailId,
        id: attachment.id,
      });
      if (attachmentResponse.error || !attachmentResponse.data) {
        throw new Error(
          attachmentResponse.error?.message ?? `Attachment ${attachment.filename} failed.`,
        );
      }
      const download = await fetch(attachmentResponse.data.download_url);
      if (!download.ok) {
        throw new Error(`Attachment download failed with HTTP ${download.status}.`);
      }
      buffer = Buffer.from(await download.arrayBuffer());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failedAttachments.push({ filename: attachment.filename, error: msg });
      logger.warn("Inbound email attachment could not be fetched — skipping", {
        jobId: job.id,
        attachmentId: attachment.id,
        filename: attachment.filename,
        error: msg,
      });
      continue;
    }
    const classifiedDocumentType = documentType(attachment.filename, attachment.content_type);
    const ensured = await orgTx((tx) =>
      ensureDocument(tx, {
        organizationId: job.organizationId,
        filename: attachment.filename,
        contentType: attachment.content_type,
        fileBuffer: buffer,
        documentType: classifiedDocumentType,
        metadata: {
          ocrText: emailResponse.data.text ?? undefined,
        },
      }),
    );
    let canonicalDocument = ensured.document;
    let extractionError: string | null = null;
    try {
      canonicalDocument = await orgTx((tx) =>
        ensureDocumentMatchingExtraction(tx, {
          organizationId: job.organizationId,
          documentId: ensured.document.id,
          fileBuffer: buffer,
          mimeType: attachment.content_type,
          filename: attachment.filename,
          documentType: classifiedDocumentType,
          fallbackCurrency: emailContext.candidate.originalCurrency,
          fallbackDate: emailContext.candidate.transactionDate,
        }),
      );
    } catch (error) {
      extractionError = isPdfPasswordRequiredError(error)
        ? "This attachment is a password-protected PDF. Add the statement password on the matching bank account (Entities → Banks), then retry processing to extract it."
        : error instanceof Error
          ? error.message
          : String(error);
      logger.warn("Inbound email attachment fact extraction failed", {
        jobId: job.id,
        documentId: ensured.document.id,
        attachmentId: attachment.id,
        passwordRequired: isPdfPasswordRequiredError(error),
        error: extractionError,
      });
    }

    const facts = deriveEmailAttachmentSourceFacts({
      emailId: payload.emailId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      attachmentDocumentType: classifiedDocumentType,
      document: canonicalDocument,
      fallbackDate: emailContext.candidate.transactionDate,
      originalCurrency: emailContext.candidate.originalCurrency,
      functionalCurrency: emailContext.candidate.functionalCurrency,
    });
    const childNeedsInformation =
      Boolean(extractionError) || !isCandidateEnrichmentFactComplete(facts);
    const childRawData = {
      provider: "resend",
      parentEmailId: payload.emailId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      documentId: canonicalDocument.id,
      contentHash: canonicalDocument.contentHash,
      extractedFrom: facts.extractedFrom,
      extractionError,
    };
    const childSourceRecord = await orgTx(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${"email-attachment:" + job.organizationId + ":" + integrationSourceId + ":" + facts.externalId},
            0::bigint
          )
        )
      `);
      const [existing] = await tx
        .select()
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, job.organizationId),
            eq(sourceRecords.sourceId, integrationSourceId),
            eq(sourceRecords.externalId, facts.externalId),
          ),
        )
        .orderBy(
          sql`case when ${sourceRecords.recordState} <> 'superseded' then 0 else 1 end`,
          sql`${sourceRecords.updatedAt} desc`,
        )
        .limit(1);
      let child = existing;
      if (!child) {
        [child] = await tx
          .insert(sourceRecords)
          .values({
            organizationId: job.organizationId,
            sourceId: integrationSourceId,
            ingestionEventId: job.ingestionEventId,
            parentSourceRecordId: emailContext.sourceRecord.id,
            recordType: "email_attachment",
            externalId: facts.externalId,
            externalVersion: facts.externalVersion,
            providerStatus: childNeedsInformation ? "needs_information" : "processed",
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
            rawData: childRawData,
          })
          .onConflictDoNothing()
          .returning();
      }
      if (!child) {
        [child] = await tx
          .select()
          .from(sourceRecords)
          .where(
            and(
              eq(sourceRecords.organizationId, job.organizationId),
              eq(sourceRecords.sourceId, integrationSourceId),
              eq(sourceRecords.externalId, facts.externalId),
            ),
          )
          .orderBy(
            sql`case when ${sourceRecords.recordState} <> 'superseded' then 0 else 1 end`,
            sql`${sourceRecords.updatedAt} desc`,
          )
          .limit(1);
      }
      if (!child) throw new Error("Attachment source could not be created idempotently.");

      const [updated] = await tx
        .update(sourceRecords)
        .set({
          externalVersion: facts.externalVersion,
          providerStatus: childNeedsInformation ? "needs_information" : "processed",
          parentSourceRecordId: emailContext.sourceRecord.id,
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
          rawData: childRawData,
          updatedAt: new Date(),
        })
        .where(
          and(eq(sourceRecords.organizationId, job.organizationId), eq(sourceRecords.id, child.id)),
        )
        .returning();
      const currentChild = updated ?? child;

      await tx
        .insert(sourceRecordVersions)
        .values({
          organizationId: job.organizationId,
          sourceRecordId: currentChild.id,
          ingestionEventId: job.ingestionEventId,
          externalVersion: facts.externalVersion,
          payloadHash: canonicalDocument.contentHash,
          providerStatus: childNeedsInformation ? "needs_information" : "processed",
          rawData: childRawData,
        })
        .onConflictDoNothing();
      await tx
        .insert(sourceRecordDocuments)
        .values({
          organizationId: job.organizationId,
          sourceRecordId: currentChild.id,
          documentId: canonicalDocument.id,
          relationship: "primary_document",
        })
        .onConflictDoNothing();
      return currentChild;
    });

    processedChildren.push({
      sourceRecordId: childSourceRecord.id,
      facts,
      kind: "attachment",
      extractionError,
      attachmentId: attachment.id,
      documentId: canonicalDocument.id,
      documentDeduplicated: ensured.deduplicated,
    });
    processedAttachments.push({
      attachmentId: attachment.id,
      childSourceRecordId: childSourceRecord.id,
      documentId: canonicalDocument.id,
      documentDeduplicated: ensured.deduplicated,
      extractionStatus: childNeedsInformation ? "needs_information" : "cached_or_extracted",
    });
  }

  const bodyText = emailResponse.data.text?.trim() ?? "";
  const bodyHtml = emailResponse.data.html?.trim() ?? "";
  const bodyFacts = deriveEmailBodySourceFacts({
    emailId: payload.emailId,
    from: emailResponse.data.from,
    subject: emailResponse.data.subject,
    text: bodyText,
    html: bodyHtml,
    fallbackDate: emailContext.candidate.transactionDate,
    originalCurrency: emailContext.candidate.originalCurrency,
    functionalCurrency: emailContext.candidate.functionalCurrency,
  });
  const bodyHasContent = Boolean(bodyText || bodyHtml);
  const shouldCreateBodyChild =
    processedAttachments.length === 0 ||
    (bodyHasContent && isCandidateEnrichmentFactComplete(bodyFacts));
  if (shouldCreateBodyChild) {
    const bodyComplete = isCandidateEnrichmentFactComplete(bodyFacts);
    const bodyRawData = {
      provider: "resend",
      parentEmailId: payload.emailId,
      extractedFrom: bodyFacts.extractedFrom,
      subject: emailResponse.data.subject,
      from: emailResponse.data.from,
      text: bodyText || undefined,
      html: bodyText ? undefined : bodyHtml || undefined,
    };
    const bodySource = await orgTx(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${"email-body:" + job.organizationId + ":" + integrationSourceId + ":" + bodyFacts.externalId},
            0::bigint
          )
        )
      `);
      const [existing] = await tx
        .select()
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, job.organizationId),
            eq(sourceRecords.sourceId, integrationSourceId),
            eq(sourceRecords.externalId, bodyFacts.externalId),
          ),
        )
        .limit(1);
      const [created] = existing
        ? [existing]
        : await tx
            .insert(sourceRecords)
            .values({
              organizationId: job.organizationId,
              sourceId: integrationSourceId,
              ingestionEventId: job.ingestionEventId,
              parentSourceRecordId: emailContext.sourceRecord.id,
              recordType: "email_body",
              externalId: bodyFacts.externalId,
              externalVersion: bodyFacts.externalVersion,
              providerStatus: bodyComplete ? "processed" : "needs_information",
              transactionDate: bodyFacts.transactionDate,
              description: bodyFacts.description,
              amount: bodyFacts.amount,
              currency: bodyFacts.currency,
              economicEventClass: bodyFacts.economicEventClass,
              direction: bodyFacts.direction,
              originalAmount: bodyFacts.originalAmount,
              originalCurrency: bodyFacts.originalCurrency,
              functionalAmount: bodyFacts.functionalAmount,
              functionalCurrency: bodyFacts.functionalCurrency,
              effectiveDate: bodyFacts.effectiveDate,
              normalizedParty: bodyFacts.normalizedParty,
              normalizedReference: bodyFacts.normalizedReference,
              matcherInputHash: bodyFacts.matcherInputHash,
              matcherVersion: bodyFacts.matcherVersion,
              rawData: bodyRawData,
            })
            .onConflictDoNothing()
            .returning();
      if (!created) throw new Error("Email body source could not be created idempotently.");
      const [current] = await tx
        .update(sourceRecords)
        .set({
          externalVersion: bodyFacts.externalVersion,
          providerStatus: bodyComplete ? "processed" : "needs_information",
          parentSourceRecordId: emailContext.sourceRecord.id,
          transactionDate: bodyFacts.transactionDate,
          description: bodyFacts.description,
          amount: bodyFacts.amount,
          currency: bodyFacts.currency,
          economicEventClass: bodyFacts.economicEventClass,
          direction: bodyFacts.direction,
          originalAmount: bodyFacts.originalAmount,
          originalCurrency: bodyFacts.originalCurrency,
          functionalAmount: bodyFacts.functionalAmount,
          functionalCurrency: bodyFacts.functionalCurrency,
          effectiveDate: bodyFacts.effectiveDate,
          normalizedParty: bodyFacts.normalizedParty,
          normalizedReference: bodyFacts.normalizedReference,
          matcherInputHash: bodyFacts.matcherInputHash,
          matcherVersion: bodyFacts.matcherVersion,
          rawData: bodyRawData,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceRecords.organizationId, job.organizationId),
            eq(sourceRecords.id, created.id),
          ),
        )
        .returning();
      await tx
        .insert(sourceRecordVersions)
        .values({
          organizationId: job.organizationId,
          sourceRecordId: current.id,
          ingestionEventId: job.ingestionEventId,
          externalVersion: bodyFacts.externalVersion,
          payloadHash: bodyFacts.externalVersion.replace(/^sha256:/u, ""),
          providerStatus: bodyComplete ? "processed" : "needs_information",
          rawData: bodyRawData,
        })
        .onConflictDoNothing();
      return current;
    });
    processedChildren.push({
      sourceRecordId: bodySource.id,
      facts: bodyFacts,
      kind: "body",
      extractionError: null,
    });
  }

  const attachmentChildren = processedChildren.filter(({ kind }) => kind === "attachment");
  const candidateUnits: EmailCandidateUnit[] = attachmentChildren.map((primary) => ({
    primary,
    corroborating: [],
  }));
  const bodyChild = processedChildren.find(({ kind }) => kind === "body");
  if (bodyChild) {
    const corroboratedUnit = candidateUnits.find(({ primary }) =>
      factsCorroborateSameEconomicEvent(primary.facts, bodyChild.facts),
    );
    if (corroboratedUnit) {
      corroboratedUnit.corroborating.push(bodyChild);
    } else {
      candidateUnits.push({ primary: bodyChild, corroborating: [] });
    }
  }

  // If EVERY attachment failed to download and there's nothing else to
  // process, throw so the job retries (transient download failures recover).
  if (candidateUnits.length === 0 && failedAttachments.length > 0) {
    throw new Error(
      `All ${failedAttachments.length} attachment(s) failed to download: ${failedAttachments
        .map((f) => `${f.filename} (${f.error})`)
        .join("; ")}`,
    );
  }

  const finalized = await orgTx(async (tx) => {
    if (!(await completeProcessingJob(tx, job.id, workerId))) return false;

    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${"email-candidate-split:" + job.organizationId + ":" + payload.emailId},
          0::bigint
        )
      )
    `);
    const assignedCandidates: {
      candidateId: string;
      inboxItemId: string;
      primarySourceRecordId: string;
      complete: boolean;
      enrichment: string;
    }[] = [];
    for (const [index, unit] of candidateUnits.entries()) {
      const [alreadyAssigned] = await tx
        .select({
          candidate: transactionCandidates,
          inboxItem: inboxItems,
        })
        .from(transactionCandidateSources)
        .innerJoin(
          transactionCandidates,
          eq(transactionCandidateSources.candidateId, transactionCandidates.id),
        )
        .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
        .where(
          and(
            eq(transactionCandidateSources.organizationId, job.organizationId),
            eq(transactionCandidateSources.sourceRecordId, unit.primary.sourceRecordId),
            eq(transactionCandidateSources.isPrimary, true),
            eq(transactionCandidates.status, "current"),
          ),
        )
        .limit(1);

      let candidate = alreadyAssigned?.candidate;
      let inboxItem = alreadyAssigned?.inboxItem;
      if (!candidate || !inboxItem) {
        const canReuseContainer =
          index === 0 &&
          emailContext.candidate.status === "current" &&
          !assignedCandidates.some(({ candidateId }) => candidateId === emailContext.candidate.id);
        if (canReuseContainer) {
          candidate = emailContext.candidate;
          inboxItem = emailContext.inboxItem;
        } else {
          [candidate] = await tx
            .insert(transactionCandidates)
            .values({
              organizationId: job.organizationId,
              sourceRecordId: unit.primary.sourceRecordId,
              candidateType: "email_transaction",
              transactionDate:
                unit.primary.facts.transactionDate ??
                unit.primary.facts.effectiveDate ??
                emailContext.candidate.transactionDate,
              transactionType: transactionTypeForDirection(unit.primary.facts.direction),
              memo: unit.primary.facts.description,
              referenceNumber: unit.primary.facts.normalizedReference,
              originalCurrency:
                unit.primary.facts.originalCurrency ?? emailContext.candidate.originalCurrency,
              functionalCurrency: emailContext.candidate.functionalCurrency,
              exchangeRate: "1",
            })
            .returning();
          [inboxItem] = await tx
            .insert(inboxItems)
            .values({
              organizationId: job.organizationId,
              candidateId: candidate.id,
              sourceRecordId: unit.primary.sourceRecordId,
              itemType: "classify_source_record",
              state: "needs_information",
              title: unit.primary.facts.description.slice(0, 255),
            })
            .returning();
          await tx.insert(reviewFindings).values({
            organizationId: job.organizationId,
            inboxItemId: inboxItem.id,
            candidateId: candidate.id,
            ruleKey: "uncategorized",
            impact: "blocking",
            subjectType: "transaction_candidate",
            subjectId: candidate.id,
            fingerprint: `${candidate.id}:1:uncategorized`,
            message: "The inbound email transaction needs accounting categories.",
            evidence: {
              source: "resend",
              emailId: payload.emailId,
              childSourceRecordId: unit.primary.sourceRecordId,
            },
          });
        }
      }

      await tx
        .update(transactionCandidateSources)
        .set({ relationship: "supporting", isPrimary: false })
        .where(
          and(
            eq(transactionCandidateSources.organizationId, job.organizationId),
            eq(transactionCandidateSources.candidateId, candidate.id),
            eq(transactionCandidateSources.sourceRecordId, emailContext.sourceRecord.id),
          ),
        );
      await tx
        .insert(transactionCandidateSources)
        .values({
          organizationId: job.organizationId,
          candidateId: candidate.id,
          sourceRecordId: emailContext.sourceRecord.id,
          relationship: "supporting",
          isPrimary: false,
        })
        .onConflictDoNothing();
      await tx
        .insert(transactionCandidateSources)
        .values({
          organizationId: job.organizationId,
          candidateId: candidate.id,
          sourceRecordId: unit.primary.sourceRecordId,
          relationship: "origin",
          isPrimary: true,
        })
        .onConflictDoNothing();
      for (const corroborating of unit.corroborating) {
        await tx
          .insert(transactionCandidateSources)
          .values({
            organizationId: job.organizationId,
            candidateId: candidate.id,
            sourceRecordId: corroborating.sourceRecordId,
            relationship: "corroborating",
            isPrimary: false,
          })
          .onConflictDoNothing();
      }
      await tx
        .update(transactionCandidates)
        .set({
          sourceRecordId: unit.primary.sourceRecordId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactionCandidates.organizationId, job.organizationId),
            eq(transactionCandidates.id, candidate.id),
          ),
        );
      await tx
        .update(inboxItems)
        .set({
          sourceRecordId: unit.primary.sourceRecordId,
          state: "needs_information",
          updatedAt: new Date(),
        })
        .where(
          and(eq(inboxItems.organizationId, job.organizationId), eq(inboxItems.id, inboxItem.id)),
        );

      const complete =
        !unit.primary.extractionError && isCandidateEnrichmentFactComplete(unit.primary.facts);
      const enrichment = complete
        ? await enrichCandidateFromExtractedFacts(
            { db: tx, orgId: job.organizationId },
            candidate.id,
            [unit.primary.facts],
          )
        : { enriched: false, reason: "source_evidence_incomplete" as const };
      if (!complete) {
        await tx
          .insert(reviewFindings)
          .values({
            organizationId: job.organizationId,
            inboxItemId: inboxItem.id,
            candidateId: candidate.id,
            ruleKey: "source_evidence_incomplete",
            impact: "blocking",
            subjectType: "source_record",
            subjectId: unit.primary.sourceRecordId,
            fingerprint: `${candidate.id}:source-evidence-incomplete:${unit.primary.sourceRecordId}`,
            message:
              "This email evidence could not be classified into one complete economic event. Supply or correct the missing transaction details before posting.",
            evidence: {
              source: "resend",
              emailId: payload.emailId,
              childSourceRecordId: unit.primary.sourceRecordId,
              sourceKind: unit.primary.kind,
              extractionError: unit.primary.extractionError,
              missing: {
                amount: unit.primary.facts.originalAmount === null,
                currency: unit.primary.facts.originalCurrency === null,
                date: unit.primary.facts.effectiveDate === null,
                eventClass: unit.primary.facts.economicEventClass === "other",
                direction: unit.primary.facts.direction === "unknown",
              },
            },
          })
          .onConflictDoUpdate({
            target: [reviewFindings.organizationId, reviewFindings.fingerprint],
            set: {
              state: "open",
              lastSeenAt: new Date(),
              resolvedBy: null,
              resolvedAt: null,
              resolutionNote: null,
            },
          });
      }
      assignedCandidates.push({
        candidateId: candidate.id,
        inboxItemId: inboxItem.id,
        primarySourceRecordId: unit.primary.sourceRecordId,
        complete,
        enrichment: enrichment.enriched
          ? "facts_and_placeholder_lines"
          : (enrichment.reason ?? "not_enriched"),
      });
    }

    if (candidateUnits.length === 0) {
      await tx
        .insert(reviewFindings)
        .values({
          organizationId: job.organizationId,
          inboxItemId: emailContext.inboxItem.id,
          candidateId: emailContext.candidate.id,
          ruleKey: "source_evidence_incomplete",
          impact: "blocking",
          subjectType: "source_record",
          subjectId: emailContext.sourceRecord.id,
          fingerprint: `${emailContext.candidate.id}:source-evidence-incomplete:${emailContext.sourceRecord.id}`,
          message:
            "This email did not contain a classifiable transaction body or attachment. Supply the economic event details before posting.",
          evidence: {
            source: "resend",
            emailId: payload.emailId,
            attachmentCount: emailResponse.data!.attachments.length,
          },
        })
        .onConflictDoNothing();
    }
    const hasIncompleteEvidence =
      candidateUnits.length === 0 || assignedCandidates.some(({ complete }) => !complete);
    const parentProviderStatus = hasIncompleteEvidence ? "needs_information" : "processed";
    const processedRawData = {
      ...emailContext.sourceRecord.rawData,
      from: emailResponse.data!.from,
      to: emailResponse.data!.to,
      subject: emailResponse.data!.subject,
      messageId: emailResponse.data!.message_id,
      text: emailResponse.data!.text,
      html: emailResponse.data!.html,
      attachmentCount: emailResponse.data!.attachments.length,
      attachmentSources: processedAttachments,
      economicChildSourceIds: processedChildren.map(({ sourceRecordId }) => sourceRecordId),
      candidateIds: assignedCandidates.map(({ candidateId }) => candidateId),
    };
    await tx
      .update(sourceRecords)
      .set({
        providerStatus: parentProviderStatus,
        rawData: processedRawData,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceRecords.organizationId, job.organizationId),
          eq(sourceRecords.id, payload.sourceRecordId!),
        ),
      );
    await tx
      .insert(sourceRecordVersions)
      .values({
        organizationId: job.organizationId,
        sourceRecordId: emailContext.sourceRecord.id,
        ingestionEventId: job.ingestionEventId,
        externalVersion: `${emailContext.sourceRecord.externalVersion}:processed`,
        providerStatus: parentProviderStatus,
        rawData: processedRawData,
      })
      .onConflictDoNothing();
    if (candidateUnits.length === 0) {
      await tx
        .update(inboxItems)
        .set({
          state: "needs_information",
          lockVersion: sql`${inboxItems.lockVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inboxItems.organizationId, job.organizationId),
            eq(inboxItems.id, payload.inboxItemId!),
          ),
        );
    }
    for (const child of processedChildren) {
      await runDuplicateMatchingForSource(
        {
          db: tx,
          orgId: job.organizationId,
          userId: "system",
        },
        child.sourceRecordId,
        child.documentId ? "document_attached" : "source_updated",
      );
    }
    await tx
      .update(reviewFindings)
      .set({
        state: "resolved",
        resolvedAt: new Date(),
        resolutionNote: "Inbound email processing succeeded after retry.",
        lastSeenAt: new Date(),
      })
      .where(
        and(
          eq(reviewFindings.organizationId, job.organizationId),
          eq(reviewFindings.inboxItemId, payload.inboxItemId!),
          eq(reviewFindings.ruleKey, "source_processing_failed"),
          eq(reviewFindings.state, "open"),
        ),
      );
    if (job.ingestionEventId) {
      await tx
        .update(ingestionEvents)
        .set({ status: "processed", processedAt: new Date() })
        .where(eq(ingestionEvents.id, job.ingestionEventId));
    }
    await tx
      .insert(workflowEvents)
      .values({
        organizationId: job.organizationId,
        inboxItemId: payload.inboxItemId!,
        entityType: "inbox_item",
        entityId: payload.inboxItemId!,
        action: "source_processed",
        actorType: "system",
        idempotencyKey: `resend:${payload.emailId}:processed`,
        data: {
          attachmentCount: emailResponse.data!.attachments.length,
          attachmentSourceRecordIds: processedAttachments.map(
            ({ childSourceRecordId }) => childSourceRecordId,
          ),
          extractionFailureCount: processedAttachments.filter(
            ({ extractionStatus }) => extractionStatus === "needs_information",
          ).length,
          economicChildCount: processedChildren.length,
          candidateCount: assignedCandidates.length,
          candidateAssignments: assignedCandidates,
        },
      })
      .onConflictDoNothing();
    return true;
  });
  if (!finalized) {
    logger.warn("Inbox worker lease expired before completion; successor owns the job", {
      jobId: job.id,
      workerId,
    });
    return { processed: false, reason: "lease_lost", jobId: job.id };
  }
  return { processed: true, jobId: job.id };
}
