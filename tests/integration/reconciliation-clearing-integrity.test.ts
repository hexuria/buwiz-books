import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestDb } from "../utils/db-utils";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  reconciliations,
  statementLines,
  statementLineMatches,
} from "../../src/db/schema/reconciliations";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import {
  findClaimedJournalLine,
  getOrgClaimedJournalLineIds,
} from "../../src/lib/reconciliation-claimed-lines";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The clearing-exclusivity contract: a journal line is cleared by AT MOST ONE
 * representation — the 1:1 statement_lines.matched_journal_line_id column OR
 * a split row in statement_line_matches, never both.
 *
 * Each side has its own unique index, but the two indexes live on two
 * different tables, so before 0048 nothing spanned them:
 * computeFinalizeBalances counted a line claimed on both sides twice, and a
 * reconciliation that was genuinely out of balance could finalize cleanly —
 * the audit's critical reconciliation finding.
 *
 * Two layers are pinned here: the 0048 DEFERRABLE constraint triggers (the
 * backstop) and findClaimedJournalLine (the application-side check every
 * write path now calls so the failure is a message, not a constraint error).
 * The test applies 0048 itself — idempotent, same file CI applies through
 * scripts/apply-tax-foundation.ts — so it does not depend on rebuild order.
 */
describeDb("reconciliation clearing exclusivity", () => {
  let ORG: string;
  let db: any;
  let sql: postgres.Sql;

  let ledgerAccountId: string;
  let contraAccountId: string;
  let reconId: string;

  /** Post one balanced two-line journal; returns the bank-side line id. */
  async function postBankJournal(amount: string): Promise<string> {
    return db.transaction(async (tx: any) => {
      const [header] = await tx
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionDate: "2026-02-10",
          transactionType: "pay_out" as const,
          status: "posted" as const,
          transactionNumber: `TXN-${crypto.randomUUID().slice(0, 8)}`,
        })
        .returning();
      const [bankLine] = await tx
        .insert(journalLines)
        .values({
          organizationId: ORG,
          journalHeaderId: header.id,
          accountId: ledgerAccountId,
          credit: amount,
          debit: "0",
          lineDescription: `Payout ${amount}`,
        })
        .returning();
      await tx.insert(journalLines).values({
        organizationId: ORG,
        journalHeaderId: header.id,
        accountId: contraAccountId,
        credit: "0",
        debit: amount,
        lineDescription: `Payout ${amount} contra`,
      });
      return bankLine.id as string;
    });
  }

  async function insertStatementLine(amount: string): Promise<string> {
    const [line] = await db
      .insert(statementLines)
      .values({
        reconciliationId: reconId,
        transactionDate: "2026-02-10",
        description: `LINE ${amount}`,
        amount,
        matchStatus: "unmatched" as const,
        source: "manual" as const,
      })
      .returning({ id: statementLines.id });
    return line.id as string;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());

    // The trigger under test — idempotent, the same file CI applies.
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0048_statement_clearing_exclusivity.sql"),
      "utf8",
    );
    await sql.unsafe(migration);

    ORG = crypto.randomUUID();
    const [ledger] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Checking",
        accountNumber: `1100-${crypto.randomUUID().slice(0, 4)}`,
        accountType: "asset" as const,
        subtype: "bank_accounts" as const,
      })
      .returning();
    ledgerAccountId = ledger.id;
    const [contra] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Payout Contra",
        accountNumber: `6000-${crypto.randomUUID().slice(0, 4)}`,
        accountType: "expense" as const,
        subtype: "general_operations" as const,
      })
      .returning();
    contraAccountId = contra.id;
    const [bank] = await db
      .insert(financialAccounts)
      .values({
        organizationId: ORG,
        accountName: "Checking",
        accountType: "checking" as const,
        ledgerAccountId,
        isManual: true,
      })
      .returning();
    const [recon] = await db
      .insert(reconciliations)
      .values({
        organizationId: ORG,
        bankAccountId: bank.id,
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        statementBeginningBalance: "1000.00",
        statementEndingBalance: "900.00",
      })
      .returning();
    reconId = recon.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Drizzle wraps constraint errors as "Failed query"; the trigger's message is in the cause chain. */
  async function expectClearingRefusal(promise: Promise<unknown>): Promise<void> {
    let caught: unknown = null;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected the 0048 trigger to refuse this write").not.toBeNull();
    const messages: string[] = [];
    let cursor: unknown = caught;
    while (cursor instanceof Error) {
      messages.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(messages.join(" | ")).toMatch(/cleared exactly once/);
  }

  // ---- the 0048 backstop ---------------------------------------------------

  it("refuses a 1:1 claim on a journal line already cleared by a split", async () => {
    const journalLineId = await postBankJournal("60.00");
    const splitLine = await insertStatementLine("-60.00");
    const directLine = await insertStatementLine("-60.00");

    await db.insert(statementLineMatches).values({
      organizationId: ORG,
      statementLineId: splitLine,
      journalLineId,
      allocatedAmount: "-60.00",
    });

    await expectClearingRefusal(
      db
        .update(statementLines)
        .set({ matchedJournalLineId: journalLineId, matchStatus: "matched" })
        .where(eq(statementLines.id, directLine)),
    );
  });

  it("refuses a split row for a journal line already claimed 1:1", async () => {
    const journalLineId = await postBankJournal("40.00");
    const directLine = await insertStatementLine("-40.00");
    const splitLine = await insertStatementLine("-40.00");

    await db
      .update(statementLines)
      .set({ matchedJournalLineId: journalLineId, matchStatus: "matched" })
      .where(eq(statementLines.id, directLine));

    await expectClearingRefusal(
      db.insert(statementLineMatches).values({
        organizationId: ORG,
        statementLineId: splitLine,
        journalLineId,
        allocatedAmount: "-40.00",
      }),
    );
  });

  it("allows moving a line between representations inside one transaction", async () => {
    const journalLineId = await postBankJournal("25.00");
    const line = await insertStatementLine("-25.00");

    await db.insert(statementLineMatches).values({
      organizationId: ORG,
      statementLineId: line,
      journalLineId,
      allocatedAmount: "-25.00",
    });

    // Deferred means the constraint sees the transaction's FINAL state: the
    // split row is gone by COMMIT, so the 1:1 claim is the only one standing.
    await db.transaction(async (tx: any) => {
      await tx
        .delete(statementLineMatches)
        .where(
          and(
            eq(statementLineMatches.statementLineId, line),
            eq(statementLineMatches.organizationId, ORG),
          ),
        );
      await tx
        .update(statementLines)
        .set({ matchedJournalLineId: journalLineId, matchStatus: "matched" })
        .where(eq(statementLines.id, line));
    });

    const [row] = await db
      .select({ matched: statementLines.matchedJournalLineId })
      .from(statementLines)
      .where(eq(statementLines.id, line));
    expect(row.matched).toBe(journalLineId);
  });

  // ---- the application-side guard ------------------------------------------

  it("findClaimedJournalLine sees claims from either representation", async () => {
    const direct = await postBankJournal("10.00");
    const split = await postBankJournal("11.00");
    const free = await postBankJournal("12.00");
    const lineA = await insertStatementLine("-10.00");
    const lineB = await insertStatementLine("-11.00");

    await db
      .update(statementLines)
      .set({ matchedJournalLineId: direct, matchStatus: "matched" })
      .where(eq(statementLines.id, lineA));
    await db.insert(statementLineMatches).values({
      organizationId: ORG,
      statementLineId: lineB,
      journalLineId: split,
      allocatedAmount: "-11.00",
    });

    const directClaim = await findClaimedJournalLine(db, ORG, [direct]);
    expect(directClaim).toMatchObject({ journalLineId: direct, via: "direct" });

    const splitClaim = await findClaimedJournalLine(db, ORG, [split]);
    expect(splitClaim).toMatchObject({ journalLineId: split, via: "split" });

    expect(await findClaimedJournalLine(db, ORG, [free])).toBeNull();

    // A line replacing ITS OWN claim is not a conflict.
    expect(
      await findClaimedJournalLine(db, ORG, [direct], { excludeStatementLineId: lineA }),
    ).toBeNull();
    expect(
      await findClaimedJournalLine(db, ORG, [split], { excludeStatementLineId: lineB }),
    ).toBeNull();
  });

  it("org-wide claims include lines cleared with matchStatus 'created'", async () => {
    const journalLineId = await postBankJournal("13.00");
    const line = await insertStatementLine("-13.00");
    await db
      .update(statementLines)
      .set({ matchedJournalLineId: journalLineId, matchStatus: "created" })
      .where(eq(statementLines.id, line));

    // computeFinalizeBalances counts 'created' lines as cleared, so the claim
    // set must too — filtering on 'matched' alone offered these journals for
    // matching again next period.
    const claimed = await getOrgClaimedJournalLineIds(db, ORG);
    expect(claimed.has(journalLineId)).toBe(true);
  });
});
