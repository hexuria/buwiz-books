/**
 * Integration tests for computeFinalizeBalances — the cleared/uncleared finalize math
 * against a real Postgres, with matched, unmatched, and outstanding activity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { reconciliations, statementLines } from "../../src/db/schema/reconciliations";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { computeFinalizeBalances } from "../../src/lib/reconciliation-finalize";
import type postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("computeFinalizeBalances", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG = crypto.randomUUID();
  const LEDGER_ACCT = crypto.randomUUID();
  const CONTRA = crypto.randomUUID();
  const BANK_FA = crypto.randomUUID();
  const RECON = crypto.randomUUID();

  /** Post a bank-account journal line; returns the bank-side journal line id. */
  async function postBankTxn(
    date: string,
    amount: string,
    side: "debit" | "credit",
    duplicateOfHeaderId?: string,
  ) {
    const [h] = await db
      .insert(journalHeaders)
      .values({
        organizationId: ORG,
        transactionDate: date,
        transactionType: "journal",
        status: "posted",
        duplicateOfHeaderId,
      })
      .returning();
    const [bankLine] = await db
      .insert(journalLines)
      .values({
        journalHeaderId: h.id,
        accountId: LEDGER_ACCT,
        debit: side === "debit" ? amount : null,
        credit: side === "credit" ? amount : null,
        sortOrder: 0,
      })
      .returning();
    await db.insert(journalLines).values({
      journalHeaderId: h.id,
      accountId: CONTRA,
      debit: side === "credit" ? amount : null,
      credit: side === "debit" ? amount : null,
      sortOrder: 1,
    });
    return { headerId: h.id as string, lineId: bankLine.id as string };
  }

  async function addStatementLine(opts: {
    date: string;
    amount: string;
    matchedTo?: string;
    matchStatus: "matched" | "unmatched" | "ignored" | "created";
  }) {
    await db.insert(statementLines).values({
      reconciliationId: RECON,
      transactionDate: opts.date,
      description: "stmt line",
      amount: opts.amount,
      matchStatus: opts.matchStatus,
      matchedJournalLineId: opts.matchedTo ?? null,
    });
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(accounts).values([
      {
        id: LEDGER_ACCT,
        organizationId: ORG,
        name: "Checking (GL)",
        accountType: "asset",
        subtype: "bank_accounts",
      },
      { id: CONTRA, organizationId: ORG, name: "Sales", accountType: "revenue" },
    ]);
    await db.insert(financialAccounts).values({
      id: BANK_FA,
      organizationId: ORG,
      accountName: "Checking",
      accountType: "checking",
      ledgerAccountId: LEDGER_ACCT,
    });
    await db.insert(reconciliations).values({
      id: RECON,
      organizationId: ORG,
      bankAccountId: BANK_FA,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      statementBeginningBalance: "1000.00",
      statementEndingBalance: "1500.00",
      status: "in_progress",
    });

    // Cleared: two deposits (300 + 200), both matched to statement lines.
    const dep1 = await postBankTxn("2026-03-05", "300.00", "debit");
    const dep2 = await postBankTxn("2026-03-12", "200.00", "debit");
    // Retained duplicate rows must not affect ledger/finalization math.
    await postBankTxn("2026-03-05", "300.00", "debit", dep1.headerId);
    await addStatementLine({
      date: "2026-03-05",
      amount: "300.00",
      matchedTo: dep1.lineId,
      matchStatus: "matched",
    });
    await addStatementLine({
      date: "2026-03-12",
      amount: "200.00",
      matchedTo: dep2.lineId,
      matchStatus: "matched",
    });

    // Outstanding check: in the GL, NOT on the statement (no statement line).
    await postBankTxn("2026-03-28", "150.00", "credit");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("gates on cleared balance and surfaces the outstanding check as a timing difference", async () => {
    const r = await computeFinalizeBalances(db, {
      orgId: ORG,
      reconciliationId: RECON,
      ledgerAccountId: LEDGER_ACCT,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      statementBeginningBalance: 1000,
      statementEndingBalance: 1500,
    });
    // Cleared: 1000 + 300 + 200 = 1500 → matches the statement, gate passes.
    expect(r.clearedBalance).toBe(1500);
    expect(r.clearedDifference).toBe(0);
    // The 150 outstanding check is a timing difference, NOT a blocker.
    expect(r.unclearedTotal).toBe(-150);
    // Legacy all-GL math would have computed 1350 and BLOCKED this correct reconciliation.
    expect(r.ledgerBalance).toBe(1350);
    expect(r.unmatchedStatementLines).toBe(0);
  });

  it("an unmatched statement line moves the gate difference (blocks finalize)", async () => {
    // A 75 statement deposit that nobody matched.
    await addStatementLine({ date: "2026-03-20", amount: "75.00", matchStatus: "unmatched" });

    const r = await computeFinalizeBalances(db, {
      orgId: ORG,
      reconciliationId: RECON,
      ledgerAccountId: LEDGER_ACCT,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      statementBeginningBalance: 1000,
      statementEndingBalance: 1575, // statement now ends 75 higher
    });
    // Cleared balance unchanged (1500) → difference 75 blocks the gate, and the
    // unmatched line count tells the user why.
    expect(r.clearedBalance).toBe(1500);
    expect(r.clearedDifference).toBe(75);
    expect(r.unmatchedStatementLines).toBe(1);
  });
});
