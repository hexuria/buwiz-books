import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withOrgContext } from "@/db";
import { member, organization, user } from "@/db/schema/auth";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  integrationSources,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecordVersions,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { hashDocumentContent } from "@/lib/documents/ensure-document";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import {
  deriveEmailAttachmentSourceFacts,
  emailAttachmentExternalId,
} from "@/lib/inbox/email-attachment-source";

async function createDocumentIntakeOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Document Intake Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Document Intake Organization",
    slug: `${prefix}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId,
    organizationId: orgId,
    role: "owner",
  });
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
  });
  return { orgId, userId, suffix };
}

describe("standalone document Inbox intake", () => {
  it("creates one exact duplicate case for email-first then standalone receipt upload", async () => {
    const fixture = await createDocumentIntakeOrganization("email-upload-dedup");
    const fileBuffer = Buffer.from(`receipt-bytes-${fixture.suffix}`);
    const contentHash = hashDocumentContent(fileBuffer);
    const [document] = await db
      .insert(documents)
      .values({
        organizationId: fixture.orgId,
        originalFilename: "workflow-receipt.pdf",
        storagePath: `r2://test/${fixture.suffix}/workflow-receipt.pdf`,
        documentType: "receipt",
        fileType: "pdf",
        mimeType: "application/pdf",
        contentHash,
        metadata: {
          inboxExtraction: {
            version: 1,
            cachedAt: "2026-07-24T00:00:00.000Z",
            result: {
              economicEventClass: "purchase",
              direction: "outflow",
              amount: "84.25",
              currency: "USD",
              date: "2026-07-23",
              party: "Workflow Vendor",
              reference: "RCPT-4242",
              description: "Team offsite supplies",
            },
          },
        },
        uploadedById: fixture.userId,
      })
      .returning();
    const [emailSource] = await db
      .insert(integrationSources)
      .values({
        organizationId: fixture.orgId,
        provider: "resend",
        channel: "email",
        externalSourceId: "resend:email",
        name: "Inbound email",
      })
      .returning();
    const [emailParent] = await db
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        sourceId: emailSource.id,
        recordType: "email",
        externalId: `email-${fixture.suffix}`,
        providerStatus: "processed",
        description: "Receipt from Workflow Vendor",
      })
      .returning();
    const [emailCandidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: fixture.orgId,
        sourceRecordId: emailParent.id,
        candidateType: "email_transaction",
        transactionDate: "2026-07-24",
        transactionType: "journal",
        memo: "Receipt from Workflow Vendor",
        originalCurrency: "USD",
        functionalCurrency: "USD",
        exchangeRate: "1",
      })
      .returning();
    await db.insert(transactionCandidateSources).values({
      organizationId: fixture.orgId,
      candidateId: emailCandidate.id,
      sourceRecordId: emailParent.id,
      relationship: "origin",
      isPrimary: true,
    });
    const [emailInbox] = await db
      .insert(inboxItems)
      .values({
        organizationId: fixture.orgId,
        candidateId: emailCandidate.id,
        sourceRecordId: emailParent.id,
        itemType: "classify_source_record",
        state: "needs_information",
        title: "Receipt from Workflow Vendor",
      })
      .returning();

    const emailFacts = deriveEmailAttachmentSourceFacts({
      emailId: `email-${fixture.suffix}`,
      attachmentId: `attachment-${fixture.suffix}`,
      filename: document.originalFilename,
      contentType: document.mimeType!,
      attachmentDocumentType: document.documentType,
      document,
      fallbackDate: "2026-07-24",
      originalCurrency: "USD",
      functionalCurrency: "USD",
    });
    const [emailAttachmentSource] = await db
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        sourceId: emailSource.id,
        parentSourceRecordId: emailParent.id,
        recordType: "email_attachment",
        externalId: emailAttachmentExternalId(
          `email-${fixture.suffix}`,
          `attachment-${fixture.suffix}`,
        ),
        externalVersion: emailFacts.externalVersion,
        providerStatus: "processed",
        transactionDate: emailFacts.transactionDate,
        description: emailFacts.description,
        amount: emailFacts.amount,
        currency: emailFacts.currency,
        economicEventClass: emailFacts.economicEventClass,
        direction: emailFacts.direction,
        originalAmount: emailFacts.originalAmount,
        originalCurrency: emailFacts.originalCurrency,
        functionalAmount: emailFacts.functionalAmount,
        functionalCurrency: emailFacts.functionalCurrency,
        effectiveDate: emailFacts.effectiveDate,
        normalizedParty: emailFacts.normalizedParty,
        normalizedReference: emailFacts.normalizedReference,
        matcherInputHash: emailFacts.matcherInputHash,
        matcherVersion: emailFacts.matcherVersion,
      })
      .returning();
    await db.insert(sourceRecordDocuments).values([
      {
        organizationId: fixture.orgId,
        sourceRecordId: emailParent.id,
        documentId: document.id,
        relationship: "email_attachment",
      },
      {
        organizationId: fixture.orgId,
        sourceRecordId: emailAttachmentSource.id,
        documentId: document.id,
        relationship: "primary_document",
      },
    ]);
    await db.insert(transactionCandidateSources).values({
      organizationId: fixture.orgId,
      candidateId: emailCandidate.id,
      sourceRecordId: emailAttachmentSource.id,
      relationship: "supporting",
      isPrimary: false,
    });

    const firstIntake = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(firstIntake).toMatchObject({
      deduplicated: false,
      extractionStatus: "cached",
    });
    expect(firstIntake.sourceRecord).not.toBeNull();
    expect(firstIntake.candidate).not.toBeNull();
    expect(firstIntake.inboxItem).not.toBeNull();

    const [duplicateCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.organizationId, fixture.orgId));
    expect(duplicateCase).toMatchObject({
      state: "open",
      matchClass: "duplicate",
      disposition: "blocking",
      score: "100.00",
    });
    expect(new Set([duplicateCase.leftSourceRecordId, duplicateCase.rightSourceRecordId])).toEqual(
      new Set([emailAttachmentSource.id, firstIntake.sourceRecord!.id]),
    );

    const possibleDuplicateFindings = await db
      .select({
        candidateId: reviewFindings.candidateId,
        state: reviewFindings.state,
        impact: reviewFindings.impact,
      })
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.orgId),
          eq(reviewFindings.ruleKey, "possible_duplicate"),
        ),
      );
    expect(possibleDuplicateFindings).toEqual(
      expect.arrayContaining([
        {
          candidateId: emailCandidate.id,
          state: "open",
          impact: "blocking",
        },
        {
          candidateId: firstIntake.candidate!.id,
          state: "open",
          impact: "blocking",
        },
      ]),
    );

    const secondIntake = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(secondIntake).toMatchObject({
      deduplicated: true,
      extractionStatus: "cached",
    });
    expect(secondIntake.sourceRecord!.id).toBe(firstIntake.sourceRecord!.id);
    expect(secondIntake.candidate!.id).toBe(firstIntake.candidate!.id);
    expect(secondIntake.inboxItem!.id).toBe(firstIntake.inboxItem!.id);

    expect(
      await db
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, fixture.orgId),
            eq(sourceRecords.recordType, "document_upload"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: transactionCandidates.id })
        .from(transactionCandidates)
        .where(eq(transactionCandidates.organizationId, fixture.orgId)),
    ).toHaveLength(2);
    expect(
      await db
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(eq(inboxItems.organizationId, fixture.orgId)),
    ).toHaveLength(2);
    expect(
      await db
        .select({ id: sourceMatchCandidates.id })
        .from(sourceMatchCandidates)
        .where(eq(sourceMatchCandidates.organizationId, fixture.orgId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: documentAttachments.id })
        .from(documentAttachments)
        .where(
          and(
            eq(documentAttachments.organizationId, fixture.orgId),
            eq(documentAttachments.linkableType, "transaction_candidate"),
            eq(documentAttachments.linkableId, firstIntake.candidate!.id),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, fixture.orgId)),
    ).toHaveLength(0);
    expect(emailInbox.state).toBe("needs_information");
  });

  it("does not create economic intake for standalone non-transaction documents", async () => {
    const fixture = await createDocumentIntakeOrganization("statement-intake-gate");
    const fileBuffer = Buffer.from(`statement-bytes-${fixture.suffix}`);
    const [document] = await db
      .insert(documents)
      .values({
        organizationId: fixture.orgId,
        originalFilename: "bank-statement.pdf",
        storagePath: `r2://test/${fixture.suffix}/bank-statement.pdf`,
        documentType: "statement",
        fileType: "pdf",
        mimeType: "application/pdf",
        contentHash: hashDocumentContent(fileBuffer),
        uploadedById: fixture.userId,
      })
      .returning();

    const result = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(result).toMatchObject({
      sourceRecord: null,
      candidate: null,
      inboxItem: null,
      extractionStatus: "unsupported",
      skipped: true,
      skipReason: "non_transaction_document",
    });
    expect(
      await db
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(eq(sourceRecords.organizationId, fixture.orgId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: transactionCandidates.id })
        .from(transactionCandidates)
        .where(eq(transactionCandidates.organizationId, fixture.orgId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(eq(inboxItems.organizationId, fixture.orgId)),
    ).toHaveLength(0);
  });

  it("queues unclassified PDF extraction without blocking on OCR or creating a zero-fact candidate", async () => {
    const fixture = await createDocumentIntakeOrganization("queued-document-intake");
    const [document] = await db
      .insert(documents)
      .values({
        organizationId: fixture.orgId,
        originalFilename: "uploaded-document.pdf",
        storagePath: `r2://test/${fixture.suffix}/uploaded-document.pdf`,
        documentType: "other",
        fileType: "pdf",
        mimeType: "application/pdf",
        contentHash: hashDocumentContent(Buffer.from(`unclassified-document-${fixture.suffix}`)),
        uploadedById: fixture.userId,
      })
      .returning();

    const result = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(result).toMatchObject({
      document: { id: document.id },
      sourceRecord: null,
      candidate: null,
      inboxItem: null,
      extractionStatus: "queued",
      skipped: true,
      skipReason: "pending_matching_extraction",
    });
    expect(result.processingJobId).toEqual(expect.any(String));
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, result.processingJobId!));
    expect(job).toMatchObject({
      organizationId: fixture.orgId,
      jobType: "process_standalone_document",
      status: "queued",
    });
    expect(
      await db
        .select({ id: transactionCandidates.id })
        .from(transactionCandidates)
        .where(eq(transactionCandidates.organizationId, fixture.orgId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(eq(inboxItems.organizationId, fixture.orgId)),
    ).toHaveLength(0);

    await db
      .update(processingJobs)
      .set({
        status: "queued",
        attempts: job.maxAttempts,
        lastError: "OCR credentials were unavailable",
      })
      .where(eq(processingJobs.id, job.id));
    const retried = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(retried.processingJobId).toBe(job.id);
    const [requeued] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(requeued).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
    });
  });

  it("enriches the existing source and version when matching facts become available later", async () => {
    const fixture = await createDocumentIntakeOrganization("document-intake-enrichment");
    const contentHash = hashDocumentContent(Buffer.from(`late-ocr-receipt-${fixture.suffix}`));
    const [document] = await db
      .insert(documents)
      .values({
        organizationId: fixture.orgId,
        originalFilename: "late-ocr-receipt.pdf",
        storagePath: `r2://test/${fixture.suffix}/late-ocr-receipt.pdf`,
        documentType: "receipt",
        fileType: "pdf",
        mimeType: "application/pdf",
        contentHash,
        uploadedById: fixture.userId,
      })
      .returning();

    const firstIntake = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(firstIntake).toMatchObject({
      deduplicated: false,
      extractionStatus: "queued",
    });
    expect(firstIntake.sourceRecord).toMatchObject({
      providerStatus: "processing",
      amount: null,
      normalizedParty: null,
    });
    expect(firstIntake.processingJobId).toEqual(expect.any(String));
    const [queuedExtraction] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, firstIntake.processingJobId!));
    expect(queuedExtraction).toMatchObject({
      organizationId: fixture.orgId,
      jobType: "process_standalone_document",
      status: "queued",
    });

    await db
      .update(documents)
      .set({
        metadata: {
          inboxExtraction: {
            version: 1,
            cachedAt: "2026-07-24T01:00:00.000Z",
            result: {
              economicEventClass: "purchase",
              direction: "outflow",
              amount: "18.50",
              currency: "USD",
              date: "2026-07-22",
              party: "Late OCR Market",
              reference: "LATE-18",
              description: "Office snacks",
            },
          },
        },
      })
      .where(and(eq(documents.organizationId, fixture.orgId), eq(documents.id, document.id)));

    const enrichedIntake = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      intakeStandaloneDocument(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        {
          documentId: document.id,
          filename: document.originalFilename,
          contentType: document.mimeType!,
          documentType: document.documentType,
          fallbackDate: "2026-07-24",
        },
      ),
    );
    expect(enrichedIntake).toMatchObject({
      deduplicated: true,
      extractionStatus: "cached",
    });
    expect(enrichedIntake.sourceRecord).toMatchObject({
      id: firstIntake.sourceRecord!.id,
      providerStatus: "processed",
      transactionDate: "2026-07-22",
      amount: "18.50000000",
      originalAmount: "18.50000000",
      economicEventClass: "purchase",
      direction: "outflow",
      normalizedParty: "late ocr market",
      normalizedReference: "late18",
    });
    expect(enrichedIntake.candidate!.id).toBe(firstIntake.candidate!.id);
    expect(enrichedIntake.candidate).toMatchObject({
      revision: 2,
      transactionDate: "2026-07-22",
      transactionType: "pay_out",
      originalTotal: "18.50000000",
    });
    expect(enrichedIntake.inboxItem!.id).toBe(firstIntake.inboxItem!.id);
    expect(enrichedIntake.inboxItem).toMatchObject({
      candidateRevision: 2,
      lockVersion: 2,
    });
    const enrichedLines = await db
      .select()
      .from(transactionCandidateLines)
      .where(eq(transactionCandidateLines.candidateId, enrichedIntake.candidate!.id));
    expect(enrichedLines).toHaveLength(2);
    expect(enrichedLines.every(({ accountId }) => accountId === null)).toBe(true);
    expect(enrichedLines.map(({ originalDebit }) => originalDebit).filter(Boolean)).toEqual([
      "18.50000000",
    ]);
    expect(enrichedLines.map(({ originalCredit }) => originalCredit).filter(Boolean)).toEqual([
      "18.50000000",
    ]);

    const [version] = await db
      .select()
      .from(sourceRecordVersions)
      .where(eq(sourceRecordVersions.sourceRecordId, firstIntake.sourceRecord!.id));
    expect(version).toMatchObject({
      externalVersion: `sha256:${contentHash}`,
      providerStatus: "processed",
      payloadHash: contentHash,
    });
    expect(version.rawData).toMatchObject({
      extractionStatus: "cached",
      documentId: document.id,
    });
    expect(
      await db
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(eq(sourceRecords.organizationId, fixture.orgId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: transactionCandidates.id })
        .from(transactionCandidates)
        .where(eq(transactionCandidates.organizationId, fixture.orgId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(eq(inboxItems.organizationId, fixture.orgId)),
    ).toHaveLength(1);
  });
});
