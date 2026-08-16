import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { dimensions } from "@/db/schema/dimensions";
import { documents } from "@/db/schema/documents";
import {
  inboxItems,
  ledgerSourceLinks,
  organizationAccountingSettings,
  reviewFindings,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import {
  correctInboxCandidate,
  enrichCandidateFromExtractedFacts,
  selectCandidateEnrichmentFacts,
} from "@/lib/inbox/candidate-correction";
import type { DocumentSourceFacts } from "@/lib/inbox/email-attachment-source";
import { approveInboxItem } from "@/lib/inbox/service";

describe("ingested candidate enrichment and correction", () => {
  it("keeps extracted evidence unposted until a reviewer assigns a balanced entry", async () => {
    const suffix = randomUUID();
    const orgId = `candidate-correction-org-${suffix}`;
    const userId = `candidate-correction-user-${suffix}`;
    await db.insert(user).values({
      id: userId,
      name: "Candidate Correction Owner",
      email: `${suffix}@candidate-correction.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Candidate Correction Organization",
      slug: `candidate-correction-${suffix}`,
    });
    await db.insert(member).values({
      id: `candidate-correction-member-${suffix}`,
      userId,
      organizationId: orgId,
      role: "owner",
    });
    const [bank, expense] = await db
      .insert(accounts)
      .values([
        {
          organizationId: orgId,
          accountNumber: "10100",
          name: "Operating Bank",
          accountType: "asset",
          subtype: "checking",
        },
        {
          organizationId: orgId,
          accountNumber: "61100",
          name: "Office Supplies",
          accountType: "expense",
          subtype: "office_supplies",
        },
      ])
      .returning();
    const [department, location] = await db
      .insert(dimensions)
      .values([
        {
          organizationId: orgId,
          dimensionType: "department",
          name: "Operations",
        },
        {
          organizationId: orgId,
          dimensionType: "location",
          name: "Main Office",
        },
      ])
      .returning();
    const [vendor] = await db
      .insert(parties)
      .values({
        organizationId: orgId,
        name: "Extracted Vendor",
        partyType: "vendor",
      })
      .returning();
    const [receipt] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "extracted-receipt.pdf",
        storagePath: `r2://test/${suffix}/extracted-receipt.pdf`,
        documentType: "receipt",
        fileType: "pdf",
        contentHash: suffix.replaceAll("-", "").padEnd(64, "0"),
      })
      .returning();
    await db.insert(organizationAccountingSettings).values({
      organizationId: orgId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });
    const [source] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        recordType: "document_upload",
        externalId: `document:${suffix}`,
        economicEventClass: "bill_payment",
        direction: "outflow",
      })
      .returning();
    const [corroboratingBodySource] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        recordType: "email_body",
        externalId: `email-body:${suffix}`,
        economicEventClass: "purchase",
        direction: "outflow",
        originalAmount: "85.5",
        originalCurrency: "USD",
        functionalAmount: "85.5",
        functionalCurrency: "USD",
        effectiveDate: "2026-07-23",
        normalizedParty: "extracted vendor",
        normalizedReference: "rcpt855",
      })
      .returning();
    const [candidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: orgId,
        sourceRecordId: source.id,
        candidateType: "document_transaction",
        transactionDate: "2026-07-24",
        transactionType: "journal",
        memo: "Uploaded document",
        originalCurrency: "USD",
        functionalCurrency: "USD",
        exchangeRate: "1",
        submittedBy: userId,
      })
      .returning();
    await db.insert(transactionCandidateSources).values([
      {
        organizationId: orgId,
        candidateId: candidate.id,
        sourceRecordId: source.id,
        relationship: "origin",
        isPrimary: true,
      },
      {
        organizationId: orgId,
        candidateId: candidate.id,
        sourceRecordId: corroboratingBodySource.id,
        relationship: "corroborating",
        isPrimary: false,
      },
    ]);
    await db.insert(sourceRecordDocuments).values({
      organizationId: orgId,
      sourceRecordId: source.id,
      documentId: receipt.id,
      relationship: "primary_document",
    });
    const [item] = await db
      .insert(inboxItems)
      .values({
        organizationId: orgId,
        candidateId: candidate.id,
        sourceRecordId: source.id,
        itemType: "classify_source_record",
        state: "processing",
        title: "Uploaded document",
        submittedBy: userId,
      })
      .returning();
    await db.insert(reviewFindings).values({
      organizationId: orgId,
      inboxItemId: item.id,
      candidateId: candidate.id,
      ruleKey: "uncategorized",
      impact: "blocking",
      subjectType: "transaction_candidate",
      subjectId: candidate.id,
      fingerprint: `${candidate.id}:1:uncategorized`,
      message: "Accounting categories are required.",
    });

    const facts: DocumentSourceFacts = {
      externalId: source.externalId!,
      externalVersion: "sha256:test",
      transactionDate: "2026-07-23",
      description: "Extracted Vendor office supplies",
      amount: "85.5",
      currency: "USD",
      economicEventClass: "purchase",
      direction: "outflow",
      originalAmount: "85.5",
      originalCurrency: "USD",
      functionalAmount: "85.5",
      functionalCurrency: "USD",
      effectiveDate: "2026-07-23",
      normalizedParty: "extracted vendor",
      normalizedReference: "RCPT-855",
      sourceAccountRef: null,
      matcherInputHash: "a".repeat(64),
      matcherVersion: 1,
      extractedFrom: ["inbox_extraction_cache"],
    };
    expect(selectCandidateEnrichmentFacts([facts])).toBe(facts);
    expect(selectCandidateEnrichmentFacts([facts, { ...facts, externalId: "second" }])).toBeNull();

    const enrichment = await withOrgContext(orgId, userId, "owner", (tx) =>
      enrichCandidateFromExtractedFacts({ db: tx, orgId }, candidate.id, [facts]),
    );
    expect(enrichment).toMatchObject({ enriched: true, revision: 2 });
    const placeholderLines = await db
      .select()
      .from(transactionCandidateLines)
      .where(eq(transactionCandidateLines.candidateId, candidate.id));
    expect(placeholderLines).toHaveLength(2);
    expect(placeholderLines.every(({ accountId }) => accountId === null)).toBe(true);
    expect(placeholderLines.map(({ originalDebit }) => originalDebit)).toContain("85.50000000");
    expect(placeholderLines.map(({ originalCredit }) => originalCredit)).toContain("85.50000000");
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, orgId)),
    ).toHaveLength(0);

    const correctionInput = {
      inboxItemId: item.id,
      expectedRevision: 2,
      expectedLockVersion: 2,
      transactionDate: "2026-07-23",
      transactionType: "pay_out" as const,
      economicEventClass: "bill_accrual" as const,
      memo: "Extracted Vendor office supplies",
      referenceNumber: "RCPT-855",
      partyId: vendor.id,
      originalCurrency: "USD",
      exchangeRate: "1",
      lines: [
        {
          accountId: expense.id,
          debit: "85.5",
          departmentId: department.id,
          locationId: location.id,
        },
        {
          accountId: bank.id,
          credit: "85.5",
          departmentId: department.id,
          locationId: location.id,
        },
      ],
    };
    await expect(
      withOrgContext(orgId, userId, "owner", (tx) =>
        correctInboxCandidate(
          { db: tx, orgId, userId, role: "owner" },
          {
            ...correctionInput,
            lines: [correctionInput.lines[0], { ...correctionInput.lines[1], credit: "84.5" }],
          },
        ),
      ),
    ).rejects.toThrow("equal debits and credits");
    const [unchanged] = await db
      .select({ revision: transactionCandidates.revision })
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, candidate.id));
    expect(unchanged.revision).toBe(2);

    const corrected = await withOrgContext(orgId, userId, "owner", (tx) =>
      correctInboxCandidate({ db: tx, orgId, userId, role: "owner" }, correctionInput),
    );
    expect(corrected).toMatchObject({ candidateRevision: 3, findingCount: 0 });
    const [ready] = await db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(ready).toMatchObject({
      state: "ready_for_review",
      candidateRevision: 3,
      lockVersion: 3,
    });
    const correctedLines = await db
      .select()
      .from(transactionCandidateLines)
      .where(eq(transactionCandidateLines.candidateId, candidate.id));
    expect(correctedLines).toHaveLength(2);
    expect(correctedLines.map(({ accountId }) => accountId).sort()).toEqual(
      [bank.id, expense.id].sort(),
    );
    const [updatedSource] = await db
      .select()
      .from(sourceRecords)
      .where(and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, source.id)));
    expect(updatedSource).toMatchObject({
      normalizedParty: "extracted vendor",
      normalizedReference: "rcpt855",
      economicEventClass: "bill_accrual",
      direction: "outflow",
      originalCurrency: "USD",
    });
    expect(updatedSource.matcherInputHash).toHaveLength(64);
    const [correctionAudit] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, orgId),
          eq(workflowEvents.entityId, candidate.id),
          eq(workflowEvents.action, "candidate_corrected"),
        ),
      );
    expect(correctionAudit.data).toMatchObject({
      economicEventClassBefore: "bill_payment",
      economicEventClassAfter: "bill_accrual",
      economicEventChanged: true,
    });
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, orgId)),
    ).toHaveLength(0);

    const approved = await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: item.id,
          expectedRevision: 3,
          expectedLockVersion: 3,
        },
      ),
    );
    expect(approved.approvalOutcome).toBe("approved");
    if (approved.approvalOutcome !== "approved") {
      throw new Error(approved.message);
    }
    const [posted] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, approved.journalHeaderId));
    expect(posted).toMatchObject({
      status: "posted",
      totalAmount: "85.50000000",
      partyId: vendor.id,
      referenceNumber: "RCPT-855",
    });
    const postedSourceLinks = await db
      .select({
        sourceRecordId: ledgerSourceLinks.sourceRecordId,
        relationship: ledgerSourceLinks.relationship,
      })
      .from(ledgerSourceLinks)
      .where(eq(ledgerSourceLinks.journalHeaderId, posted.id));
    expect(postedSourceLinks).toEqual(
      expect.arrayContaining([
        { sourceRecordId: source.id, relationship: "origin" },
        {
          sourceRecordId: corroboratingBodySource.id,
          relationship: "supporting",
        },
      ]),
    );
  });
});
