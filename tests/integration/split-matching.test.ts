// ============================================================================
// One-to-many (split) clearing.
//
// The load-bearing test is the FINALIZE MATH one: a reconciliation whose
// lines clear through the join table must balance exactly as if they had
// cleared through the 1:1 column. Getting that wrong would block finalization
// on correct books — which is why split apply was gated behind this file.
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  reconciliations,
  statementLineMatches,
  statementLines,
} from "../../src/db/schema/reconciliations";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { computeFinalizeBalances } from "../../src/lib/reconciliation-finalize";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("split matching", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  /**
   * A statement shows ONE -100 withdrawal that actually settles two ledger
   * payments of -60 and -40. Opening 1000 → closing 900.
   */
  async function seedSplitScenario() {
    const orgId = crypto.randomUUID();

    const [ledgerAccount] = await db
      .insert(accounts)
      .values({
        organizationId: orgId,
        name: "Checking",
        accountNumber: `1100-${crypto.randomUUID().slice(0, 4)}`,
        accountType: "asset" as const,
        subtype: "bank_accounts" as const,
      })
      .returning();

    // Every posted journal below needs a second side. Reconciliation only ever
    // reads the bank account's lines, so the contra account exists purely to
    // keep the fixtures valid double-entry rather than single-sided stubs.
    const [contraAccount] = await db
      .insert(accounts)
      .values({
        organizationId: orgId,
        name: "Payout Contra",
        accountNumber: `6000-${crypto.randomUUID().slice(0, 4)}`,
        accountType: "expense" as const,
        subtype: "general_operations" as const,
      })
      .returning();

    const [bank] = await db
      .insert(financialAccounts)
      .values({
        organizationId: orgId,
        accountName: "Checking",
        accountType: "checking" as const,
        ledgerAccountId: ledgerAccount.id,
        isManual: true,
      })
      .returning();

    const [recon] = await db
      .insert(reconciliations)
      .values({
        organizationId: orgId,
        bankAccountId: bank.id,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        statementBeginningBalance: "1000.00",
        statementEndingBalance: "900.00",
      })
      .returning();

    const [line] = await db
      .insert(statementLines)
      .values({
        reconciliationId: recon.id,
        transactionDate: "2026-01-10",
        description: "COMBINED PAYOUT",
        amount: "-100.00",
        matchStatus: "unmatched" as const,
        source: "ocr" as const,
      })
      .returning();

    const journalLineIds: string[] = [];
    for (const amount of ["60.00", "40.00"]) {
      // One transaction per journal. A balance check on posted journals is a
      // deferred constraint, so it runs at COMMIT — with both sides written, it
      // sees a balanced journal. Inserting the lines with bare `db.insert`
      // would autocommit each statement and check the first line on its own.
      const jlId = await db.transaction(async (tx: any) => {
        const [header] = await tx
          .insert(journalHeaders)
          .values({
            organizationId: orgId,
            transactionDate: "2026-01-09",
            transactionType: "pay_out" as const,
            status: "posted" as const,
            transactionNumber: `TXN-${crypto.randomUUID().slice(0, 8)}`,
          })
          .returning();
        const [jl] = await tx
          .insert(journalLines)
          .values({
            organizationId: orgId,
            journalHeaderId: header.id,
            accountId: ledgerAccount.id,
            // Money leaving the bank account credits it.
            credit: amount,
            debit: "0",
            lineDescription: `Payout ${amount}`,
          })
          .returning();
        // The matching debit. Only the credit line is returned, because that is
        // the one reconciliation matches against.
        await tx.insert(journalLines).values({
          organizationId: orgId,
          journalHeaderId: header.id,
          accountId: contraAccount.id,
          credit: "0",
          debit: amount,
          lineDescription: `Payout ${amount} contra`,
        });
        return jl.id;
      });
      journalLineIds.push(jlId);
    }

    return { orgId, recon, ledgerAccountId: ledgerAccount.id, line, journalLineIds };
  }

  const balancesFor = (s: any) =>
    computeFinalizeBalances(db, {
      orgId: s.orgId,
      reconciliationId: s.recon.id,
      ledgerAccountId: s.ledgerAccountId,
      periodStart: s.recon.periodStart,
      periodEnd: s.recon.periodEnd,
      statementBeginningBalance: 1000,
      statementEndingBalance: 900,
    });

  it("does not balance while the split line is unmatched", async () => {
    const s = await seedSplitScenario();
    const balances = await balancesFor(s);
    expect(balances.unmatchedStatementLines).toBe(1);
    // Nothing cleared yet, so cleared stays at the opening balance.
    expect(balances.clearedBalance).toBe(1000);
    expect(balances.clearedDifference).toBe(-100);
  });

  it("balances EXACTLY once the line clears through the join table", async () => {
    const s = await seedSplitScenario();

    await db.insert(statementLineMatches).values([
      {
        organizationId: s.orgId,
        statementLineId: s.line.id,
        journalLineId: s.journalLineIds[0],
        allocatedAmount: "-60.00",
      },
      {
        organizationId: s.orgId,
        statementLineId: s.line.id,
        journalLineId: s.journalLineIds[1],
        allocatedAmount: "-40.00",
      },
    ]);
    await db
      .update(statementLines)
      .set({ matchStatus: "matched", matchedJournalLineId: null })
      .where(eq(statementLines.id, s.line.id));

    const balances = await balancesFor(s);
    expect(balances.unmatchedStatementLines).toBe(0);
    // 1000 opening − 100 of cleared activity = 900 = the statement's closing.
    expect(balances.clearedBalance).toBe(900);
    expect(balances.clearedDifference).toBe(0);
  });

  it("counts split and 1:1 clearing together without double counting", async () => {
    const s = await seedSplitScenario();

    // Clear ONE of the two ledger lines the ordinary 1:1 way, via a second
    // statement line; the other clears through the join table.
    const [secondLine] = await db
      .insert(statementLines)
      .values({
        reconciliationId: s.recon.id,
        transactionDate: "2026-01-11",
        description: "SINGLE PAYOUT",
        amount: "-60.00",
        matchStatus: "matched" as const,
        matchedJournalLineId: s.journalLineIds[0],
        source: "ocr" as const,
      })
      .returning();
    expect(secondLine.matchedJournalLineId).toBe(s.journalLineIds[0]);

    await db.insert(statementLineMatches).values({
      organizationId: s.orgId,
      statementLineId: s.line.id,
      journalLineId: s.journalLineIds[1],
      allocatedAmount: "-40.00",
    });
    await db
      .update(statementLines)
      .set({ matchStatus: "matched", matchedJournalLineId: null, amount: "-40.00" })
      .where(eq(statementLines.id, s.line.id));

    const balances = await balancesFor(s);
    // 60 (1:1) + 40 (split) = 100 cleared, each counted exactly once.
    expect(balances.clearedBalance).toBe(900);
  });

  it("refuses to clear the same ledger line twice (unique index)", async () => {
    const s = await seedSplitScenario();
    await db.insert(statementLineMatches).values({
      organizationId: s.orgId,
      statementLineId: s.line.id,
      journalLineId: s.journalLineIds[0],
      allocatedAmount: "-60.00",
    });

    const [otherLine] = await db
      .insert(statementLines)
      .values({
        reconciliationId: s.recon.id,
        transactionDate: "2026-01-12",
        description: "ANOTHER",
        amount: "-60.00",
        matchStatus: "unmatched" as const,
        source: "ocr" as const,
      })
      .returning();

    await expect(
      db.insert(statementLineMatches).values({
        organizationId: s.orgId,
        statementLineId: otherLine.id,
        journalLineId: s.journalLineIds[0],
        allocatedAmount: "-60.00",
      }),
    ).rejects.toThrow();
  });

  it("cascades split rows away when the statement line is deleted (re-OCR)", async () => {
    const s = await seedSplitScenario();
    await db.insert(statementLineMatches).values({
      organizationId: s.orgId,
      statementLineId: s.line.id,
      journalLineId: s.journalLineIds[0],
      allocatedAmount: "-60.00",
    });

    await db.delete(statementLines).where(eq(statementLines.id, s.line.id));

    const remaining = await db
      .select()
      .from(statementLineMatches)
      .where(
        and(
          eq(statementLineMatches.organizationId, s.orgId),
          eq(statementLineMatches.statementLineId, s.line.id),
        ),
      );
    expect(remaining).toHaveLength(0);
  });
});
