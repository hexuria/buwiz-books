/**
 * Reconciliation finalize math — cleared/uncleared (bank-reconciliation) model.
 *
 * Correct bank-rec accounting:
 *   clearedBalance = statement beginning balance (bank opening)
 *                  + net of journal lines CLEARED by this reconciliation
 *                    (matched to a statement line, matchStatus 'matched' or 'created')
 *
 *   The finalize gate compares clearedBalance to the statement ENDING balance. Uncleared
 *   GL activity (outstanding checks / deposits in transit) is a legitimate timing
 *   difference: it must NOT block finalization, and is surfaced as unclearedTotal.
 *
 * The historical bug: the gate summed ALL posted GL activity in the period (ignoring match
 * status entirely), so a reconciliation could finalize with every statement line unmatched
 * as long as totals coincided — and a legitimate outstanding check made correct
 * reconciliations impossible to finalize.
 *
 * Pure module: DB-explicit, no server-fn context — directly unit/integration testable.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "@/db/schema/journals";
import { statementLineMatches, statementLines } from "@/db/schema/reconciliations";

export interface FinalizeBalances {
  /** Bank opening + net cleared activity — what the bank should show at period end. */
  clearedBalance: number;
  /** Bank opening + net of ALL posted GL activity in the period (legacy "ledger balance"). */
  ledgerBalance: number;
  /** Net of posted GL activity NOT cleared by this reconciliation (timing differences). */
  unclearedTotal: number;
  /** statementEndingBalance − clearedBalance — must be ≈ 0 to finalize. */
  clearedDifference: number;
  /** Count of this reconciliation's statement lines still unmatched (not matched/created/ignored). */
  unmatchedStatementLines: number;
}

export const RECONCILIATION_BALANCE_TOLERANCE = 0.01;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure gate math, separated from the queries for direct unit testing.
 */
export function computeClearedBalance(opts: {
  statementBeginningBalance: number;
  statementEndingBalance: number;
  clearedDebit: number;
  clearedCredit: number;
  totalDebit: number;
  totalCredit: number;
  unmatchedStatementLines: number;
}): FinalizeBalances {
  const clearedNet = opts.clearedDebit - opts.clearedCredit;
  const totalNet = opts.totalDebit - opts.totalCredit;
  const clearedBalance = round2(opts.statementBeginningBalance + clearedNet);
  const ledgerBalance = round2(opts.statementBeginningBalance + totalNet);
  return {
    clearedBalance,
    ledgerBalance,
    unclearedTotal: round2(totalNet - clearedNet),
    clearedDifference: round2(opts.statementEndingBalance - clearedBalance),
    unmatchedStatementLines: opts.unmatchedStatementLines,
  };
}

/**
 * Query + compute the finalize balances for a reconciliation.
 * `ledgerAccountId` is the bank's chart-of-accounts account backing the reconciliation.
 */
export async function computeFinalizeBalances(
  db: DbExecutor,
  opts: {
    orgId: string;
    reconciliationId: string;
    ledgerAccountId: string;
    periodStart: string;
    periodEnd: string;
    statementBeginningBalance: number;
    statementEndingBalance: number;
  },
): Promise<FinalizeBalances> {
  // Net of ALL posted GL activity on the bank account in the period.
  const [totals] = await db
    .select({
      totalDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .where(
      and(
        eq(journalLines.accountId, opts.ledgerAccountId),
        eq(journalHeaders.organizationId, opts.orgId),
        eq(journalHeaders.status, "posted"),
        effectiveJournalPredicate(),
        gte(journalHeaders.transactionDate, opts.periodStart),
        lte(journalHeaders.transactionDate, opts.periodEnd),
      ),
    );

  // Net of GL lines CLEARED by this reconciliation (matched/created statement
  // lines). A statement line clears its ledger entries EITHER through the 1:1
  // `matchedJournalLineId` column OR — for one-to-many split matches —
  // through statement_line_matches. Both must count, or a reconciliation with
  // splits would look unbalanced and refuse to finalize.
  const clearedFilter = and(
    eq(journalLines.accountId, opts.ledgerAccountId),
    eq(journalHeaders.organizationId, opts.orgId),
    eq(journalHeaders.status, "posted"),
    effectiveJournalPredicate(),
    gte(journalHeaders.transactionDate, opts.periodStart),
    lte(journalHeaders.transactionDate, opts.periodEnd),
  );

  const [clearedDirect] = await db
    .select({
      clearedDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
      clearedCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
    })
    .from(statementLines)
    .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .where(
      and(
        eq(statementLines.reconciliationId, opts.reconciliationId),
        inArray(statementLines.matchStatus, ["matched", "created"]),
        clearedFilter,
      ),
    );

  const [clearedSplit] = await db
    .select({
      clearedDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
      clearedCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
    })
    .from(statementLineMatches)
    .innerJoin(statementLines, eq(statementLineMatches.statementLineId, statementLines.id))
    .innerJoin(journalLines, eq(statementLineMatches.journalLineId, journalLines.id))
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .where(
      and(
        eq(statementLines.reconciliationId, opts.reconciliationId),
        inArray(statementLines.matchStatus, ["matched", "created"]),
        clearedFilter,
      ),
    );

  // Double counting is impossible: a split line has matchedJournalLineId
  // null, and the join table's unique index stops a ledger line appearing in
  // both. Summing the two disjoint sets is therefore safe.
  const cleared = {
    clearedDebit: String(
      Number.parseFloat(clearedDirect?.clearedDebit ?? "0") +
        Number.parseFloat(clearedSplit?.clearedDebit ?? "0"),
    ),
    clearedCredit: String(
      Number.parseFloat(clearedDirect?.clearedCredit ?? "0") +
        Number.parseFloat(clearedSplit?.clearedCredit ?? "0"),
    ),
  };

  // Statement lines of this reconciliation still needing attention.
  const [unmatched] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(statementLines)
    .where(
      and(
        eq(statementLines.reconciliationId, opts.reconciliationId),
        inArray(statementLines.matchStatus, ["unmatched"]),
      ),
    );

  return computeClearedBalance({
    statementBeginningBalance: opts.statementBeginningBalance,
    statementEndingBalance: opts.statementEndingBalance,
    clearedDebit: Number.parseFloat(cleared?.clearedDebit ?? "0"),
    clearedCredit: Number.parseFloat(cleared?.clearedCredit ?? "0"),
    totalDebit: Number.parseFloat(totals?.totalDebit ?? "0"),
    totalCredit: Number.parseFloat(totals?.totalCredit ?? "0"),
    unmatchedStatementLines: unmatched?.count ?? 0,
  });
}
