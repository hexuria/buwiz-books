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
import { centsToMoney, moneyToCents } from "@/lib/money";
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

/** decimal(20,8) SUM strings and 2dp statement columns, to integer cents. */
function toCents(value: string | number | null | undefined): number {
  return moneyToCents(value ?? "0", "balance");
}

/** Persistable 2dp string for a FinalizeBalances field. */
export function balanceString(value: number): string {
  return centsToMoney(moneyToCents(value, "balance"));
}

/**
 * Pure gate math, separated from the queries for direct unit testing.
 *
 * All arithmetic happens in INTEGER CENTS (audit PR-15): the inputs are the
 * database's decimal strings — parsing them to floats and accumulating with
 * round2 let representation error decide whether clearedDifference cleared
 * the finalize tolerance. Number fields remain accepted for callers/tests
 * that already hold numbers.
 */
export function computeClearedBalance(opts: {
  statementBeginningBalance: string | number;
  statementEndingBalance: string | number;
  clearedDebit: string | number;
  clearedCredit: string | number;
  clearedPriorDebit?: string | number;
  clearedPriorCredit?: string | number;
  totalDebit: string | number;
  totalCredit: string | number;
  unmatchedStatementLines: number;
}): FinalizeBalances {
  const beginningCents = toCents(opts.statementBeginningBalance);
  const endingCents = toCents(opts.statementEndingBalance);
  const clearedNetCents = toCents(opts.clearedDebit) - toCents(opts.clearedCredit);
  // Of the cleared net, this much is prior-period outstanding items — real
  // clears for the bank (they count in clearedBalance) but not part of THIS
  // period's ledger activity (they must not distort unclearedTotal).
  const clearedPriorNetCents = toCents(opts.clearedPriorDebit) - toCents(opts.clearedPriorCredit);
  const totalNetCents = toCents(opts.totalDebit) - toCents(opts.totalCredit);
  const clearedBalanceCents = beginningCents + clearedNetCents;
  const ledgerBalanceCents = beginningCents + totalNetCents;
  return {
    clearedBalance: clearedBalanceCents / 100,
    ledgerBalance: ledgerBalanceCents / 100,
    unclearedTotal: (totalNetCents - (clearedNetCents - clearedPriorNetCents)) / 100,
    clearedDifference: (endingCents - clearedBalanceCents) / 100,
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
    statementBeginningBalance: string | number;
    statementEndingBalance: string | number;
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
  // Cleared journals are bounded only ABOVE by the period end. A cheque
  // written 28 January that clears on the February statement is the textbook
  // outstanding check; bounding below by periodStart made clearedBalance
  // permanently short by exactly such items, so February could never
  // finalize. The prior-period portion is measured separately below so
  // unclearedTotal keeps describing THIS period's ledger activity.
  const clearedFilter = and(
    eq(journalLines.accountId, opts.ledgerAccountId),
    eq(journalHeaders.organizationId, opts.orgId),
    eq(journalHeaders.status, "posted"),
    effectiveJournalPredicate(),
    lte(journalHeaders.transactionDate, opts.periodEnd),
  );
  const priorPeriodOnly = sql`${journalHeaders.transactionDate} < ${opts.periodStart}`;

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

  // The prior-period portion of what this statement cleared — outstanding
  // items from earlier periods. Needed so unclearedTotal can stay scoped to
  // THIS period's ledger activity while clearedBalance counts every clear.
  const [clearedDirectPrior] = await db
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
        priorPeriodOnly,
      ),
    );
  const [clearedSplitPrior] = await db
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
        priorPeriodOnly,
      ),
    );

  // Double counting across the two representations is enforced impossible:
  // every claiming write path checks findClaimedJournalLine, and the 0048
  // DEFERRABLE constraint triggers refuse a journal line present in both at
  // COMMIT. Summing the two sets is therefore safe.
  const clearedDebitCents =
    toCents(clearedDirect?.clearedDebit) + toCents(clearedSplit?.clearedDebit);
  const clearedCreditCents =
    toCents(clearedDirect?.clearedCredit) + toCents(clearedSplit?.clearedCredit);

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
    clearedDebit: centsToMoney(clearedDebitCents),
    clearedCredit: centsToMoney(clearedCreditCents),
    clearedPriorDebit: centsToMoney(
      toCents(clearedDirectPrior?.clearedDebit) + toCents(clearedSplitPrior?.clearedDebit),
    ),
    clearedPriorCredit: centsToMoney(
      toCents(clearedDirectPrior?.clearedCredit) + toCents(clearedSplitPrior?.clearedCredit),
    ),
    totalDebit: totals?.totalDebit ?? "0",
    totalCredit: totals?.totalCredit ?? "0",
    unmatchedStatementLines: unmatched?.count ?? 0,
  });
}
