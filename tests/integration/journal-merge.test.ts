import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type postgres from "postgres";
import { accounts } from "../../src/db/schema/accounts";
import { organization } from "../../src/db/schema/auth";
import { documentAttachments, documents } from "../../src/db/schema/documents";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { invoices } from "../../src/db/schema/invoices";
import {
  effectiveJournalPredicate,
  journalHeaders,
  journalLines,
} from "../../src/db/schema/journals";
import { journalDuplicateMerges } from "../../src/db/schema/match-history";
import {
  integrationSources,
  ledgerSourceLinks,
  sourceRecordDocuments,
  sourceMatchCandidates,
  sourceRecords,
} from "../../src/db/schema/inbox";
import { reconciliations, statementLines } from "../../src/db/schema/reconciliations";
import { parties } from "../../src/db/schema/parties";
import { listEntityDocumentAttachments } from "../../src/lib/documents/list-attachments";
import {
  mergeDuplicateJournals,
  previewDuplicateJournalMerge,
  unmergeDuplicateJournals,
} from "../../src/lib/journal-merge";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("lossless journal unmerge reconciliation safety", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  async function createCurrencyPair(options: {
    canonicalFunctionalAmount: string;
    duplicateFunctionalAmount: string;
    canonicalOriginalAmount: string;
    duplicateOriginalAmount: string;
    transactionCurrency?: string;
  }) {
    const suffix = crypto.randomUUID();
    const orgId = `journal-fx-merge-${suffix}`;
    const canonicalJournalId = crypto.randomUUID();
    const duplicateJournalId = crypto.randomUUID();
    const assetAccountId = crypto.randomUUID();
    const expenseAccountId = crypto.randomUUID();
    const transactionCurrency = options.transactionCurrency ?? "EUR";

    await db.insert(organization).values({
      id: orgId,
      name: "Journal FX merge integration test",
      slug: `journal-fx-merge-${suffix}`,
    });
    await db.insert(accounts).values([
      {
        id: assetAccountId,
        organizationId: orgId,
        name: "Foreign cash",
        accountType: "asset",
        subtype: "bank_accounts",
      },
      {
        id: expenseAccountId,
        organizationId: orgId,
        name: "Foreign purchase",
        accountType: "expense",
      },
    ]);
    await db.insert(journalHeaders).values([
      {
        id: canonicalJournalId,
        organizationId: orgId,
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        status: "posted",
        totalAmount: options.canonicalFunctionalAmount,
        transactionCurrency,
        functionalCurrency: "USD",
      },
      {
        id: duplicateJournalId,
        organizationId: orgId,
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        status: "posted",
        totalAmount: options.duplicateFunctionalAmount,
        transactionCurrency,
        functionalCurrency: "USD",
      },
    ]);
    await db.insert(journalLines).values([
      {
        journalHeaderId: canonicalJournalId,
        accountId: expenseAccountId,
        debit: options.canonicalFunctionalAmount,
        originalDebit: options.canonicalOriginalAmount,
        originalCurrency: transactionCurrency,
        sortOrder: 0,
      },
      {
        journalHeaderId: canonicalJournalId,
        accountId: assetAccountId,
        credit: options.canonicalFunctionalAmount,
        originalCredit: options.canonicalOriginalAmount,
        originalCurrency: transactionCurrency,
        sortOrder: 1,
      },
      {
        journalHeaderId: duplicateJournalId,
        accountId: expenseAccountId,
        debit: options.duplicateFunctionalAmount,
        originalDebit: options.duplicateOriginalAmount,
        originalCurrency: transactionCurrency,
        sortOrder: 0,
      },
      {
        journalHeaderId: duplicateJournalId,
        accountId: assetAccountId,
        credit: options.duplicateFunctionalAmount,
        originalCredit: options.duplicateOriginalAmount,
        originalCurrency: transactionCurrency,
        sortOrder: 1,
      },
    ]);
    const [canonicalSource, duplicateSource] = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgId,
          recordType: "bank_transaction",
          externalId: `fx-bank-${suffix}`,
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: options.canonicalOriginalAmount,
          originalCurrency: transactionCurrency,
          functionalAmount: options.canonicalFunctionalAmount,
          functionalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
        {
          organizationId: orgId,
          recordType: "receipt",
          externalId: `fx-receipt-${suffix}`,
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: options.duplicateOriginalAmount,
          originalCurrency: transactionCurrency,
          functionalAmount: options.duplicateFunctionalAmount,
          functionalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
      ])
      .returning();
    await db.insert(ledgerSourceLinks).values([
      {
        organizationId: orgId,
        journalHeaderId: canonicalJournalId,
        sourceRecordId: canonicalSource.id,
        relationship: "origin",
      },
      {
        organizationId: orgId,
        journalHeaderId: duplicateJournalId,
        sourceRecordId: duplicateSource.id,
        relationship: "origin",
      },
    ]);

    return {
      suffix,
      orgId,
      canonicalJournalId,
      duplicateJournalId,
      canonicalSourceId: canonicalSource.id,
      duplicateSourceId: duplicateSource.id,
      assetAccountId,
      expenseAccountId,
    };
  }

  async function createDuplicateCase(
    orgId: string,
    firstSourceRecordId: string,
    secondSourceRecordId: string,
  ) {
    const [leftSourceRecordId, rightSourceRecordId] = [
      firstSourceRecordId,
      secondSourceRecordId,
    ].sort();
    const [duplicateCase] = await db
      .insert(sourceMatchCandidates)
      .values({
        organizationId: orgId,
        leftSourceRecordId,
        rightSourceRecordId,
        matchType: "exact",
        confidence: "1",
        matchClass: "duplicate",
        disposition: "blocking",
        score: "100",
        state: "open",
      })
      .returning();
    return duplicateCase;
  }

  async function createActiveMerge() {
    const suffix = crypto.randomUUID();
    const orgId = `journal-merge-${suffix}`;
    const userId = `reviewer-${suffix}`;
    const bankAccountId = crypto.randomUUID();
    const expenseAccountId = crypto.randomUUID();
    const financialAccountId = crypto.randomUUID();
    const reconciliationId = crypto.randomUUID();
    const canonicalJournalId = crypto.randomUUID();
    const duplicateJournalId = crypto.randomUUID();
    const canonicalSourceId = crypto.randomUUID();
    const duplicateSourceId = crypto.randomUUID();
    const canonicalDocumentId = crypto.randomUUID();
    const duplicateDocumentId = crypto.randomUUID();

    await db.insert(organization).values({
      id: orgId,
      name: "Journal merge integration test",
      slug: `journal-merge-${suffix}`,
    });
    await db.insert(accounts).values([
      {
        id: bankAccountId,
        organizationId: orgId,
        name: "Checking",
        accountType: "asset",
        subtype: "bank_accounts",
      },
      {
        id: expenseAccountId,
        organizationId: orgId,
        name: "Office expense",
        accountType: "expense",
      },
    ]);
    await db.insert(financialAccounts).values({
      id: financialAccountId,
      organizationId: orgId,
      accountName: "Checking",
      accountType: "checking",
      ledgerAccountId: bankAccountId,
    });
    await db.insert(reconciliations).values({
      id: reconciliationId,
      organizationId: orgId,
      bankAccountId: financialAccountId,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      statementBeginningBalance: "1000.00",
      statementEndingBalance: "900.00",
      status: "in_progress",
    });
    await db.insert(journalHeaders).values([
      {
        id: canonicalJournalId,
        organizationId: orgId,
        transactionDate: "2026-06-15",
        transactionType: "pay_out",
        status: "posted",
        totalAmount: "100.00",
        transactionCurrency: "USD",
        functionalCurrency: "USD",
      },
      {
        id: duplicateJournalId,
        organizationId: orgId,
        transactionDate: "2026-06-15",
        transactionType: "pay_out",
        status: "posted",
        totalAmount: "100.00",
        transactionCurrency: "USD",
        functionalCurrency: "USD",
      },
    ]);

    const insertedLines = await db
      .insert(journalLines)
      .values([
        {
          journalHeaderId: canonicalJournalId,
          accountId: expenseAccountId,
          debit: "100.00",
          sortOrder: 0,
        },
        {
          journalHeaderId: canonicalJournalId,
          accountId: bankAccountId,
          credit: "100.00",
          sortOrder: 1,
        },
        {
          journalHeaderId: duplicateJournalId,
          accountId: expenseAccountId,
          debit: "100.00",
          sortOrder: 0,
        },
        {
          journalHeaderId: duplicateJournalId,
          accountId: bankAccountId,
          credit: "100.00",
          sortOrder: 1,
        },
      ])
      .returning({
        id: journalLines.id,
        journalHeaderId: journalLines.journalHeaderId,
        accountId: journalLines.accountId,
      });
    await db.insert(sourceRecords).values([
      {
        id: canonicalSourceId,
        organizationId: orgId,
        recordType: "bank_transaction",
        externalId: `bank-canonical-${suffix}`,
        transactionDate: "2026-06-15",
        amount: "100.00",
        currency: "USD",
        economicEventClass: "purchase",
        direction: "outflow",
        originalAmount: "100.00",
        originalCurrency: "USD",
        functionalAmount: "100.00",
        functionalCurrency: "USD",
        effectiveDate: "2026-06-15",
      },
      {
        id: duplicateSourceId,
        organizationId: orgId,
        recordType: "receipt",
        externalId: `receipt-duplicate-${suffix}`,
        transactionDate: "2026-06-15",
        amount: "100.00",
        currency: "USD",
        economicEventClass: "purchase",
        direction: "outflow",
        originalAmount: "100.00",
        originalCurrency: "USD",
        functionalAmount: "100.00",
        functionalCurrency: "USD",
        effectiveDate: "2026-06-15",
      },
    ]);
    await db.insert(ledgerSourceLinks).values([
      {
        organizationId: orgId,
        journalHeaderId: canonicalJournalId,
        sourceRecordId: canonicalSourceId,
        relationship: "origin",
      },
      {
        organizationId: orgId,
        journalHeaderId: duplicateJournalId,
        sourceRecordId: duplicateSourceId,
        relationship: "origin",
      },
    ]);
    await db.insert(documents).values([
      {
        id: canonicalDocumentId,
        organizationId: orgId,
        originalFilename: "purchase-email.pdf",
        storagePath: `r2://test/${suffix}/purchase-email.pdf`,
        documentType: "other",
        fileType: "pdf",
        contentHash: createHash("sha256").update(`email-${suffix}`).digest("hex"),
      },
      {
        id: duplicateDocumentId,
        organizationId: orgId,
        originalFilename: "purchase-receipt.pdf",
        storagePath: `r2://test/${suffix}/purchase-receipt.pdf`,
        documentType: "receipt",
        fileType: "pdf",
        contentHash: createHash("sha256").update(`receipt-${suffix}`).digest("hex"),
      },
    ]);
    await db.insert(sourceRecordDocuments).values([
      {
        organizationId: orgId,
        sourceRecordId: canonicalSourceId,
        documentId: canonicalDocumentId,
        relationship: "email_attachment",
      },
      {
        organizationId: orgId,
        sourceRecordId: duplicateSourceId,
        documentId: duplicateDocumentId,
        relationship: "evidence",
      },
    ]);
    await db.insert(documentAttachments).values([
      {
        organizationId: orgId,
        documentId: canonicalDocumentId,
        linkableType: "journal_header",
        linkableId: canonicalJournalId,
      },
      {
        organizationId: orgId,
        documentId: duplicateDocumentId,
        linkableType: "journal_header",
        linkableId: duplicateJournalId,
      },
    ]);

    const merged = await mergeDuplicateJournals(
      { db, orgId, userId },
      {
        canonicalJournalId,
        duplicateJournalId,
        reason: "Same economic event",
        idempotencyKey: `merge-${suffix}`,
      },
    );

    const bankLineByHeader = new Map(
      insertedLines
        .filter((line: { accountId: string }) => line.accountId === bankAccountId)
        .map((line: { id: string; journalHeaderId: string }) => [line.journalHeaderId, line.id]),
    );

    return {
      orgId,
      userId,
      reconciliationId,
      canonicalJournalId,
      duplicateJournalId,
      canonicalSourceId,
      duplicateSourceId,
      canonicalDocumentId,
      duplicateDocumentId,
      canonicalBankLineId: bankLineByHeader.get(canonicalJournalId)!,
      duplicateBankLineId: bankLineByHeader.get(duplicateJournalId)!,
      mergeId: merged.mergeId,
      suffix,
    };
  }

  async function expectUnmergeBlockedByReconciliation(
    side: "canonical" | "duplicate",
  ): Promise<void> {
    const fixture = await createActiveMerge();
    const matchedJournalLineId =
      side === "canonical" ? fixture.canonicalBankLineId : fixture.duplicateBankLineId;

    await db.insert(statementLines).values({
      reconciliationId: fixture.reconciliationId,
      transactionDate: "2026-06-15",
      description: `${side} journal bank match`,
      amount: "-100.00",
      matchStatus: "matched",
      matchedJournalLineId,
    });

    await expect(
      unmergeDuplicateJournals(
        { db, orgId: fixture.orgId, userId: fixture.userId },
        {
          mergeId: fixture.mergeId,
          reason: "Transactions are separate",
          idempotencyKey: `unmerge-${side}-${fixture.suffix}`,
        },
      ),
    ).rejects.toThrow(
      "Cannot unmerge while either journal has reconciliation links. Unmatch the bank reconciliation first.",
    );

    const [mergeAfterFailure] = await db
      .select()
      .from(journalDuplicateMerges)
      .where(
        and(
          eq(journalDuplicateMerges.id, fixture.mergeId),
          eq(journalDuplicateMerges.organizationId, fixture.orgId),
        ),
      );
    const [duplicateAfterFailure] = await db
      .select({ duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.id, fixture.duplicateJournalId),
          eq(journalHeaders.organizationId, fixture.orgId),
        ),
      );

    expect(mergeAfterFailure).toMatchObject({
      state: "active",
      reversedAt: null,
      reversedBy: null,
      reversalReason: null,
      reversalIdempotencyKey: null,
    });
    expect(duplicateAfterFailure.duplicateOfHeaderId).toBe(fixture.canonicalJournalId);
  }

  it("rejects unmerge when the canonical journal has a reconciliation link", async () => {
    await expectUnmergeBlockedByReconciliation("canonical");
  });

  it("rejects unmerge when the duplicate journal has a reconciliation link", async () => {
    await expectUnmergeBlockedByReconciliation("duplicate");
  });

  it("suppresses only the effective duplicate and restores both journals losslessly on unmerge", async () => {
    const fixture = await createActiveMerge();
    const journalIds = [fixture.canonicalJournalId, fixture.duplicateJournalId];
    const sourceIds = [fixture.canonicalSourceId, fixture.duplicateSourceId];
    const documentIds = [fixture.canonicalDocumentId, fixture.duplicateDocumentId];

    const allHeadersAfterMerge = await db
      .select({
        id: journalHeaders.id,
        duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
      })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, fixture.orgId),
          inArray(journalHeaders.id, journalIds),
        ),
      );
    expect(allHeadersAfterMerge).toHaveLength(2);
    expect(
      allHeadersAfterMerge.find(({ id }: { id: string }) => id === fixture.duplicateJournalId),
    ).toMatchObject({ duplicateOfHeaderId: fixture.canonicalJournalId });

    const effectiveHeadersAfterMerge = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, fixture.orgId),
          inArray(journalHeaders.id, journalIds),
          effectiveJournalPredicate(),
        ),
      );
    expect(effectiveHeadersAfterMerge).toEqual([{ id: fixture.canonicalJournalId }]);

    const linesAfterMerge = await db
      .select({
        id: journalLines.id,
        journalHeaderId: journalLines.journalHeaderId,
      })
      .from(journalLines)
      .where(inArray(journalLines.journalHeaderId, journalIds));
    expect(linesAfterMerge).toHaveLength(4);
    expect(
      new Set(
        linesAfterMerge.map(({ journalHeaderId }: { journalHeaderId: string }) => journalHeaderId),
      ),
    ).toEqual(new Set(journalIds));

    const canonicalEvidence = await listEntityDocumentAttachments(db, fixture.orgId, {
      linkableType: "journal_header",
      linkableId: fixture.canonicalJournalId,
    });
    expect(canonicalEvidence.map(({ documentId }) => documentId).sort()).toEqual(
      [...documentIds].sort(),
    );
    expect(
      canonicalEvidence.find(({ documentId }) => documentId === fixture.duplicateDocumentId),
    ).toMatchObject({
      linkableId: fixture.duplicateJournalId,
      inheritedFromMergedJournal: true,
    });

    await unmergeDuplicateJournals(
      { db, orgId: fixture.orgId, userId: fixture.userId },
      {
        mergeId: fixture.mergeId,
        reason: "Follow-up evidence proved these are separate purchases",
        idempotencyKey: `unmerge-lossless-${fixture.suffix}`,
      },
    );

    const allHeadersAfterUnmerge = await db
      .select({
        id: journalHeaders.id,
        duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
      })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, fixture.orgId),
          inArray(journalHeaders.id, journalIds),
        ),
      );
    expect(allHeadersAfterUnmerge).toHaveLength(2);
    expect(
      allHeadersAfterUnmerge.every(
        ({ duplicateOfHeaderId }: { duplicateOfHeaderId: string | null }) =>
          duplicateOfHeaderId === null,
      ),
    ).toBe(true);

    const effectiveHeadersAfterUnmerge = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, fixture.orgId),
          inArray(journalHeaders.id, journalIds),
          effectiveJournalPredicate(),
        ),
      );
    expect(effectiveHeadersAfterUnmerge.map(({ id }: { id: string }) => id).sort()).toEqual(
      [...journalIds].sort(),
    );

    const linesAfterUnmerge = await db
      .select({
        id: journalLines.id,
        journalHeaderId: journalLines.journalHeaderId,
      })
      .from(journalLines)
      .where(inArray(journalLines.journalHeaderId, journalIds));
    expect(linesAfterUnmerge).toEqual(expect.arrayContaining(linesAfterMerge));

    const sourceLinksAfterUnmerge = await db
      .select({
        journalHeaderId: ledgerSourceLinks.journalHeaderId,
        sourceRecordId: ledgerSourceLinks.sourceRecordId,
        relationship: ledgerSourceLinks.relationship,
      })
      .from(ledgerSourceLinks)
      .where(
        and(
          eq(ledgerSourceLinks.organizationId, fixture.orgId),
          inArray(ledgerSourceLinks.sourceRecordId, sourceIds),
        ),
      );
    expect(sourceLinksAfterUnmerge).toEqual(
      expect.arrayContaining([
        {
          journalHeaderId: fixture.canonicalJournalId,
          sourceRecordId: fixture.canonicalSourceId,
          relationship: "origin",
        },
        {
          journalHeaderId: fixture.duplicateJournalId,
          sourceRecordId: fixture.duplicateSourceId,
          relationship: "origin",
        },
      ]),
    );

    const sourceDocumentsAfterUnmerge = await db
      .select({
        sourceRecordId: sourceRecordDocuments.sourceRecordId,
        documentId: sourceRecordDocuments.documentId,
      })
      .from(sourceRecordDocuments)
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, fixture.orgId),
          inArray(sourceRecordDocuments.sourceRecordId, sourceIds),
        ),
      );
    expect(sourceDocumentsAfterUnmerge).toHaveLength(2);
    expect(
      sourceDocumentsAfterUnmerge
        .map(({ documentId }: { documentId: string }) => documentId)
        .sort(),
    ).toEqual([...documentIds].sort());

    const journalDocumentsAfterUnmerge = await db
      .select({
        documentId: documentAttachments.documentId,
        linkableId: documentAttachments.linkableId,
      })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, fixture.orgId),
          eq(documentAttachments.linkableType, "journal_header"),
          inArray(documentAttachments.linkableId, journalIds),
        ),
      );
    expect(journalDocumentsAfterUnmerge).toEqual(
      expect.arrayContaining([
        {
          documentId: fixture.canonicalDocumentId,
          linkableId: fixture.canonicalJournalId,
        },
        {
          documentId: fixture.duplicateDocumentId,
          linkableId: fixture.duplicateJournalId,
        },
      ]),
    );

    const [mergeAfterUnmerge] = await db
      .select()
      .from(journalDuplicateMerges)
      .where(eq(journalDuplicateMerges.id, fixture.mergeId));
    expect(mergeAfterUnmerge).toMatchObject({
      state: "reversed",
      reversalReason: "Follow-up evidence proved these are separate purchases",
      reversedBy: fixture.userId,
    });
  });

  it("merges equal original foreign-currency amounts despite different functional FX totals", async () => {
    const fixture = await createCurrencyPair({
      canonicalFunctionalAmount: "110.00",
      duplicateFunctionalAmount: "112.00",
      canonicalOriginalAmount: "100.00",
      duplicateOriginalAmount: "100.00",
    });
    const duplicateCase = await createDuplicateCase(
      fixture.orgId,
      fixture.canonicalSourceId,
      fixture.duplicateSourceId,
    );

    const preview = await previewDuplicateJournalMerge(
      { db, orgId: fixture.orgId },
      {
        canonicalJournalId: fixture.canonicalJournalId,
        duplicateJournalId: fixture.duplicateJournalId,
      },
    );
    expect(preview.eligible).toBe(true);
    expect(preview.canonical.totalAmount).toBe("110.00000000");
    expect(preview.duplicate.totalAmount).toBe("112.00000000");
    expect(preview.canonical.originalDebitTotal).toBe("100.00000000");
    expect(preview.duplicate.originalDebitTotal).toBe("100.00000000");

    await mergeDuplicateJournals(
      {
        db,
        orgId: fixture.orgId,
        userId: `reviewer-${fixture.suffix}`,
      },
      {
        canonicalJournalId: fixture.canonicalJournalId,
        duplicateJournalId: fixture.duplicateJournalId,
        duplicateCaseId: duplicateCase.id,
        reason: "Same EUR purchase represented at different FX rates",
        idempotencyKey: `merge-fx-${fixture.suffix}`,
      },
    );

    const [suppressed] = await db
      .select({ duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId })
      .from(journalHeaders)
      .where(eq(journalHeaders.id, fixture.duplicateJournalId));
    expect(suppressed.duplicateOfHeaderId).toBe(fixture.canonicalJournalId);
  });

  it("rejects different original foreign-currency amounts even when functional totals match", async () => {
    const fixture = await createCurrencyPair({
      canonicalFunctionalAmount: "110.00",
      duplicateFunctionalAmount: "110.00",
      canonicalOriginalAmount: "100.00",
      duplicateOriginalAmount: "101.00",
    });

    const preview = await previewDuplicateJournalMerge(
      { db, orgId: fixture.orgId },
      {
        canonicalJournalId: fixture.canonicalJournalId,
        duplicateJournalId: fixture.duplicateJournalId,
      },
    );
    expect(preview.eligible).toBe(false);
    expect(preview.checks.find((check) => check.key === "amount")?.passed).toBe(false);
  });

  it("rejects absent, cross-organization, and wrong-pair duplicate case associations identically", async () => {
    const fixture = await createCurrencyPair({
      canonicalFunctionalAmount: "110.00",
      duplicateFunctionalAmount: "110.00",
      canonicalOriginalAmount: "100.00",
      duplicateOriginalAmount: "100.00",
    });
    const thirdJournalId = crypto.randomUUID();
    const thirdSourceId = crypto.randomUUID();
    await db.insert(journalHeaders).values({
      id: thirdJournalId,
      organizationId: fixture.orgId,
      transactionDate: "2026-07-24",
      transactionType: "pay_out",
      status: "posted",
      totalAmount: "110.00",
      transactionCurrency: "EUR",
      functionalCurrency: "USD",
    });
    await db.insert(journalLines).values([
      {
        journalHeaderId: thirdJournalId,
        accountId: fixture.expenseAccountId,
        debit: "110.00",
        originalDebit: "100.00",
        originalCurrency: "EUR",
        sortOrder: 0,
      },
      {
        journalHeaderId: thirdJournalId,
        accountId: fixture.assetAccountId,
        credit: "110.00",
        originalCredit: "100.00",
        originalCurrency: "EUR",
        sortOrder: 1,
      },
    ]);
    await db.insert(sourceRecords).values({
      id: thirdSourceId,
      organizationId: fixture.orgId,
      recordType: "receipt",
      externalId: `third-source-${fixture.suffix}`,
      economicEventClass: "purchase",
      direction: "outflow",
      originalAmount: "100.00",
      originalCurrency: "EUR",
      functionalAmount: "110.00",
      functionalCurrency: "USD",
      effectiveDate: "2026-07-24",
    });
    await db.insert(ledgerSourceLinks).values({
      organizationId: fixture.orgId,
      journalHeaderId: thirdJournalId,
      sourceRecordId: thirdSourceId,
      relationship: "origin",
    });
    const wrongPairCase = await createDuplicateCase(
      fixture.orgId,
      fixture.canonicalSourceId,
      thirdSourceId,
    );

    const foreignFixture = await createCurrencyPair({
      canonicalFunctionalAmount: "110.00",
      duplicateFunctionalAmount: "110.00",
      canonicalOriginalAmount: "100.00",
      duplicateOriginalAmount: "100.00",
    });
    const crossOrganizationCase = await createDuplicateCase(
      foreignFixture.orgId,
      foreignFixture.canonicalSourceId,
      foreignFixture.duplicateSourceId,
    );
    const caseIds = [crypto.randomUUID(), crossOrganizationCase.id, wrongPairCase.id];
    const errorMessages: string[] = [];
    for (const [index, duplicateCaseId] of caseIds.entries()) {
      try {
        await mergeDuplicateJournals(
          {
            db,
            orgId: fixture.orgId,
            userId: `reviewer-${fixture.suffix}`,
          },
          {
            canonicalJournalId: fixture.canonicalJournalId,
            duplicateJournalId: fixture.duplicateJournalId,
            duplicateCaseId,
            reason: "Attempt invalid duplicate case association",
            idempotencyKey: `invalid-case-${index}-${fixture.suffix}`,
          },
        );
        throw new Error("Expected merge to reject an invalid duplicate case.");
      } catch (error) {
        errorMessages.push(error instanceof Error ? error.message : String(error));
      }
    }

    expect(errorMessages).toEqual([
      "Duplicate case does not match the selected journals.",
      "Duplicate case does not match the selected journals.",
      "Duplicate case does not match the selected journals.",
    ]);
    const [duplicate] = await db
      .select({ duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId })
      .from(journalHeaders)
      .where(eq(journalHeaders.id, fixture.duplicateJournalId));
    expect(duplicate.duplicateOfHeaderId).toBeNull();
  });

  it("does not merge distinct provider captures against the same invoice", async () => {
    const suffix = crypto.randomUUID();
    const orgId = `journal-payment-identity-${suffix}`;
    const invoiceId = crypto.randomUUID();
    const canonicalJournalId = crypto.randomUUID();
    const duplicateJournalId = crypto.randomUUID();
    const bankAccountId = crypto.randomUUID();
    const receivableAccountId = crypto.randomUUID();
    const customerId = crypto.randomUUID();

    await db.insert(organization).values({
      id: orgId,
      name: "Payment identity merge test",
      slug: `journal-payment-identity-${suffix}`,
    });
    await db.insert(accounts).values([
      {
        id: bankAccountId,
        organizationId: orgId,
        name: "Payment clearing",
        accountType: "asset",
        subtype: "asset_clearing",
      },
      {
        id: receivableAccountId,
        organizationId: orgId,
        name: "Accounts receivable",
        accountType: "asset",
        subtype: "account_receivable",
      },
    ]);
    await db.insert(parties).values({
      id: customerId,
      organizationId: orgId,
      name: "Installment customer",
      partyType: "customer",
    });
    await db.insert(invoices).values({
      id: invoiceId,
      organizationId: orgId,
      invoiceNumber: "INV-INSTALLMENT-4242",
      customerId,
      issueDate: "2026-07-01",
      dueDate: "2026-07-31",
      status: "partial",
      subtotal: "200.00",
      total: "200.00",
      amountPaid: "100.00",
      balanceDue: "100.00",
    });
    await db.insert(journalHeaders).values([
      {
        id: canonicalJournalId,
        organizationId: orgId,
        transactionDate: "2026-07-24",
        transactionType: "pay_in",
        source: "payment",
        status: "posted",
        totalAmount: "100.00",
        transactionCurrency: "USD",
        functionalCurrency: "USD",
        sourceDocumentType: "invoice",
        sourceDocumentId: invoiceId,
        referenceNumber: "INV-INSTALLMENT-4242",
      },
      {
        id: duplicateJournalId,
        organizationId: orgId,
        transactionDate: "2026-07-24",
        transactionType: "pay_in",
        source: "payment",
        status: "posted",
        totalAmount: "100.00",
        transactionCurrency: "USD",
        functionalCurrency: "USD",
        sourceDocumentType: "invoice",
        sourceDocumentId: invoiceId,
        referenceNumber: "INV-INSTALLMENT-4242",
      },
    ]);
    await db.insert(journalLines).values([
      {
        journalHeaderId: canonicalJournalId,
        accountId: bankAccountId,
        debit: "100.00",
        sortOrder: 0,
      },
      {
        journalHeaderId: canonicalJournalId,
        accountId: receivableAccountId,
        credit: "100.00",
        sortOrder: 1,
      },
      {
        journalHeaderId: duplicateJournalId,
        accountId: bankAccountId,
        debit: "100.00",
        sortOrder: 0,
      },
      {
        journalHeaderId: duplicateJournalId,
        accountId: receivableAccountId,
        credit: "100.00",
        sortOrder: 1,
      },
    ]);
    const [stripeSource] = await db
      .insert(integrationSources)
      .values({
        organizationId: orgId,
        provider: "stripe",
        channel: "revenue",
        externalSourceId: `stripe-captures-${suffix}`,
        name: "Stripe captures",
      })
      .returning();
    const [captureA, captureB] = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgId,
          sourceId: stripeSource.id,
          recordType: "invoice_payment",
          externalId: "pi_capture_1001",
          economicEventClass: "invoice_payment",
          direction: "inflow",
          originalAmount: "100.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
          normalizedReference: "picapture1001",
        },
        {
          organizationId: orgId,
          sourceId: stripeSource.id,
          recordType: "invoice_payment",
          externalId: "pi_capture_1002",
          economicEventClass: "invoice_payment",
          direction: "inflow",
          originalAmount: "100.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
          normalizedReference: "picapture1002",
        },
      ])
      .returning();
    const [emailContainerA, emailContainerB] = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgId,
          sourceId: stripeSource.id,
          recordType: "email",
          externalId: "email_capture_1001",
          economicEventClass: "other",
          direction: "unknown",
        },
        {
          organizationId: orgId,
          sourceId: stripeSource.id,
          recordType: "email",
          externalId: "email_capture_1002",
          economicEventClass: "other",
          direction: "unknown",
        },
      ])
      .returning();
    await db.insert(ledgerSourceLinks).values([
      {
        organizationId: orgId,
        journalHeaderId: canonicalJournalId,
        sourceRecordId: emailContainerA.id,
        relationship: "origin",
      },
      {
        organizationId: orgId,
        journalHeaderId: duplicateJournalId,
        sourceRecordId: emailContainerB.id,
        relationship: "origin",
      },
      {
        organizationId: orgId,
        journalHeaderId: canonicalJournalId,
        sourceRecordId: captureA.id,
        relationship: "supporting",
      },
      {
        organizationId: orgId,
        journalHeaderId: duplicateJournalId,
        sourceRecordId: captureB.id,
        relationship: "supporting",
      },
    ]);

    const preview = await previewDuplicateJournalMerge(
      { db, orgId },
      { canonicalJournalId, duplicateJournalId },
    );
    expect(preview.checks.find((check) => check.key === "domain")?.passed).toBe(true);
    expect(preview.canonical.economicEventClasses).toEqual(["invoice_payment"]);
    expect(preview.canonical.operationalOrigins).toEqual([
      expect.objectContaining({ sourceRecordId: captureA.id }),
    ]);
    expect(preview.checks.find((check) => check.key === "payment_identity")?.passed).toBe(false);
    expect(preview.canonical.paymentIdentityTokens).not.toContain("reference:invinstallment4242");

    await expect(
      mergeDuplicateJournals(
        { db, orgId, userId: `reviewer-${suffix}` },
        {
          canonicalJournalId,
          duplicateJournalId,
          reason: "Same invoice and amount",
          idempotencyKey: `merge-distinct-captures-${suffix}`,
        },
      ),
    ).rejects.toThrow("distinct captures and installments must remain separate");
  });
});
