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
  claimConflictMessage,
  findClaimedJournalLine,
  getOrgClaimedJournalLineIds,
  setStatementLineClearing,
} from "../../src/lib/reconciliation-claimed-lines";
import { lockRunForOverride, startRun } from "../../src/lib/ai/agent-run";

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
  let bankAccountId: string;

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

  async function insertStatementLine(amount: string, inRecon = reconId): Promise<string> {
    const [line] = await db
      .insert(statementLines)
      .values({
        reconciliationId: inRecon,
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

    // The triggers under test — idempotent, the same files CI applies, in order.
    for (const file of [
      "drizzle/0048_statement_clearing_exclusivity.sql",
      "drizzle/0053_statement_clearing_commit_state.sql",
    ]) {
      await sql.unsafe(readFileSync(resolve(process.cwd(), file), "utf8"));
    }

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
    bankAccountId = bank.id;
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

  it("judges each row as it stands at COMMIT, not as one write left it", async () => {
    // S1 claims A, moves to B, then a split on S2 claims A. The final state
    // is valid (A by the split only, B by S1 only); 0048 judged the tuple
    // the FIRST write captured (S1 → A) at COMMIT and refused it.
    const lineA = await postBankJournal("31.00");
    const lineB = await postBankJournal("32.00");
    const s1 = await insertStatementLine("-31.00");
    const s2 = await insertStatementLine("-31.00");

    await db.transaction(async (tx: any) => {
      await tx
        .update(statementLines)
        .set({ matchedJournalLineId: lineA, matchStatus: "matched" })
        .where(eq(statementLines.id, s1));
      await tx
        .update(statementLines)
        .set({ matchedJournalLineId: lineB })
        .where(eq(statementLines.id, s1));
      await tx.insert(statementLineMatches).values({
        organizationId: ORG,
        statementLineId: s2,
        journalLineId: lineA,
        allocatedAmount: "-31.00",
      });
    });

    const [row] = await db
      .select({ matched: statementLines.matchedJournalLineId })
      .from(statementLines)
      .where(eq(statementLines.id, s1));
    expect(row.matched).toBe(lineB);
  });

  it("refuses to install over rows that are already cleared twice", async () => {
    // Installing the triggers proves nothing about rows written before them:
    // 0053 must refuse loudly rather than leave a double-counted line in place.
    const journalLineId = await postBankJournal("33.00");
    const direct = await insertStatementLine("-33.00");
    const split = await insertStatementLine("-33.00");
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0053_statement_clearing_commit_state.sql"),
      "utf8",
    );

    let refusal = "";
    await sql
      .begin(async (tx) => {
        // The triggers are deferred, so inside this (rolled-back) transaction
        // the double claim exists exactly as pre-0048 data would.
        await tx`UPDATE statement_lines SET matched_journal_line_id = ${journalLineId}, match_status = 'matched' WHERE id = ${direct}`;
        await tx`INSERT INTO statement_line_matches (organization_id, statement_line_id, journal_line_id, allocated_amount)
                 VALUES (${ORG}, ${split}, ${journalLineId}, '-33.00')`;
        try {
          await tx.unsafe(migration);
        } catch (error) {
          refusal = (error as Error).message;
        }
        throw new Error("rollback");
      })
      .catch((error: Error) => {
        if (error.message !== "rollback") throw error;
      });

    expect(refusal).toMatch(/cleared by both representations/);
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

  // ---- where a claim lives, and what to tell the user ----------------------

  async function finalizedReconciliation(): Promise<string> {
    const [recon] = await db
      .insert(reconciliations)
      .values({
        organizationId: ORG,
        bankAccountId,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        statementBeginningBalance: "1000.00",
        statementEndingBalance: "1000.00",
        status: "finalized" as const,
      })
      .returning();
    return recon.id as string;
  }

  it("names the reconciliation holding a claim, and can skip one reconciliation", async () => {
    const journalLineId = await postBankJournal("14.00");
    const january = await finalizedReconciliation();
    const line = await insertStatementLine("-14.00", january);
    await db
      .update(statementLines)
      .set({ matchedJournalLineId: journalLineId, matchStatus: "matched" })
      .where(eq(statementLines.id, line));

    const claim = await findClaimedJournalLine(db, ORG, [journalLineId]);
    expect(claim).toMatchObject({
      via: "direct",
      reconciliationId: january,
      reconciliationStatus: "finalized",
      periodEnd: "2026-01-31",
    });
    // A finalized reconciliation refuses edits: the advice is to reopen it.
    expect(claimConflictMessage(claim!, reconId)).toMatch(
      /finalized reconciliation.*2026-01-31.*Reopen/,
    );

    // The PDF regeneration path replaces its own reconciliation's lines.
    expect(
      await findClaimedJournalLine(db, ORG, [journalLineId], { excludeReconciliationId: january }),
    ).toBeNull();
  });

  it("points at the other open reconciliation by its period", async () => {
    const journalLineId = await postBankJournal("15.00");
    const line = await insertStatementLine("-15.00");
    await db.insert(statementLineMatches).values({
      organizationId: ORG,
      statementLineId: line,
      journalLineId,
      allocatedAmount: "-15.00",
    });
    const claim = await findClaimedJournalLine(db, ORG, [journalLineId]);
    expect(claim).toMatchObject({ via: "split", reconciliationId: reconId });
    expect(claimConflictMessage(claim!, crypto.randomUUID())).toMatch(
      /in the reconciliation for the period ending 2026-02-28\. Unmatch it there first/,
    );
    expect(claimConflictMessage(claim!, reconId)).toMatch(/Remove that split/);
  });

  // ---- the shared clearing writer ------------------------------------------

  it("ignoring a line releases its 1:1 link and its split rows", async () => {
    const direct = await postBankJournal("16.00");
    const split = await postBankJournal("17.00");
    const lineA = await insertStatementLine("-16.00");
    const lineB = await insertStatementLine("-17.00");
    await db
      .update(statementLines)
      .set({ matchedJournalLineId: direct, matchStatus: "matched" })
      .where(eq(statementLines.id, lineA));
    await db.insert(statementLineMatches).values({
      organizationId: ORG,
      statementLineId: lineB,
      journalLineId: split,
      allocatedAmount: "-17.00",
    });

    for (const statementLineId of [lineA, lineB]) {
      const result = await setStatementLineClearing(db, {
        orgId: ORG,
        reconciliationId: reconId,
        statementLineId,
        clearing: { action: "ignore" },
      });
      expect(result.written).toBe(true);
    }

    for (const id of [lineA, lineB]) {
      const [row] = await db
        .select({
          status: statementLines.matchStatus,
          matched: statementLines.matchedJournalLineId,
        })
        .from(statementLines)
        .where(eq(statementLines.id, id));
      expect(row).toMatchObject({ status: "ignored", matched: null });
    }
    // Neither journal line is claimed any more.
    expect(await findClaimedJournalLine(db, ORG, [direct, split])).toBeNull();
  });

  it("a conflicting match writes nothing and reports the claim", async () => {
    const journalLineId = await postBankJournal("18.00");
    const holder = await insertStatementLine("-18.00");
    const other = await insertStatementLine("-18.00");
    await db
      .update(statementLines)
      .set({ matchedJournalLineId: journalLineId, matchStatus: "matched" })
      .where(eq(statementLines.id, holder));

    const result = await setStatementLineClearing(db, {
      orgId: ORG,
      reconciliationId: reconId,
      statementLineId: other,
      clearing: { action: "match", journalLineId },
    });
    expect(result).toMatchObject({ written: false, conflict: { statementLineId: holder } });
    const [row] = await db
      .select({ status: statementLines.matchStatus, matched: statementLines.matchedJournalLineId })
      .from(statementLines)
      .where(eq(statementLines.id, other));
    expect(row).toMatchObject({ status: "unmatched", matched: null });
  });

  // ---- the validation override is single-use -------------------------------

  it("reports the run that already overrode a blocked run", async () => {
    const blocked = await startRun(db, { orgId: ORG, kind: "statement_pipeline" });
    expect(await db.transaction((tx: any) => lockRunForOverride(tx, ORG, blocked))).toBeNull();

    const override = await startRun(db, {
      orgId: ORG,
      kind: "statement_pipeline",
      configSnapshot: { trigger: "validation_override", overriddenRunId: blocked },
    });
    expect(await db.transaction((tx: any) => lockRunForOverride(tx, ORG, blocked))).toBe(override);
    // Another org's run of the same id space is never reported.
    expect(
      await db.transaction((tx: any) => lockRunForOverride(tx, crypto.randomUUID(), blocked)),
    ).toBeNull();
  });
});
