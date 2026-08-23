/**
 * Core Financial Reports Engine
 * Shared directly with export/CSV features.
 * Pure server module. No createServerFn exports.
 */
import type { DbExecutor } from "../db";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../db/schema/journals";
import { accounts } from "../db/schema/accounts";
import { eq, and, lte, gte, sql, asc } from "drizzle-orm";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitLoss,
  buildTrialBalance,
  type ReportRow,
} from "../lib/report-calculations";

export async function aggregateBalances(
  orgId: string,
  dateFrom: string | null,
  dateTo: string,
  executor: DbExecutor,
  options?: {
    /**
     * "posted_only" (default): voids are retroactive — a voided journal never
     * counts, whatever the report date. Period reports (P&L, cash flow, trial
     * balance) keep this view.
     *
     * "point_in_time": a journal voided AFTER the report's as-of date still
     * existed on that date and counts. This is the AP/AR aging convention
     * (-reports.ts), and the balance sheet adopts it (audit D5) so the A/P
     * and A/R control accounts tie to the aging totals for ANY as-of date —
     * previously a bill voided in July vanished from a June 30 balance sheet
     * while June 30 aging still reported it.
     */
    voidedMode?: "posted_only" | "point_in_time";
  },
): Promise<ReportRow[]> {
  const conditions = [
    eq(journalHeaders.organizationId, orgId),
    lte(journalHeaders.transactionDate, dateTo),
  ];

  if (dateFrom) {
    conditions.push(gte(journalHeaders.transactionDate, dateFrom));
  }

  if (options?.voidedMode === "point_in_time") {
    // Keep textually in lockstep with the aging predicate in -reports.ts.
    conditions.push(sql`(
      ${journalHeaders.status} = 'posted'
      OR (
        ${journalHeaders.status} = 'voided'
        AND ${journalHeaders.voidedAt}::date > ${dateTo}::date
      )
    )`);
  } else {
    // Only include posted transactions
    conditions.push(eq(journalHeaders.status, "posted"));
  }
  conditions.push(effectiveJournalPredicate());

  const rows = await executor
    .select({
      accountId: journalLines.accountId,
      accountName: accounts.name,
      accountNumber: accounts.accountNumber,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
      totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .where(and(...conditions))
    .groupBy(
      journalLines.accountId,
      accounts.name,
      accounts.accountNumber,
      accounts.accountType,
      accounts.subtype,
      accounts.parentId,
    )
    .orderBy(asc(accounts.accountNumber), asc(accounts.name));

  return rows;
}

export async function computeBalanceSheet(
  orgId: string,
  asOf: string,
  compare: string = "none",
  executor: DbExecutor,
) {
  // D5: point-in-time voids, so the balance sheet agrees with AP/AR aging at
  // any as-of date (see aggregateBalances). Deliberate divergence from the
  // period reports below.
  const rows = await aggregateBalances(orgId, null, asOf, executor, {
    voidedMode: "point_in_time",
  });

  // Comparison period — a balance sheet compares to a prior AS-OF date (one month earlier),
  // not a mirrored span. Keep the cumulative (dateFrom=null) query; only the end date changes.
  let priorRows: ReportRow[] | null = null;
  if (compare !== "none") {
    const { getPriorAsOfDate } = await import("../lib/report-utils");
    priorRows = await aggregateBalances(orgId, null, getPriorAsOfDate(asOf), executor, {
      voidedMode: "point_in_time",
    });
  }

  return buildBalanceSheet(rows, asOf, priorRows);
}

export async function computeProfitLoss(
  orgId: string,
  dateFrom: string,
  dateTo: string,
  compare: string = "none",
  executor: DbExecutor,
) {
  const rows = await aggregateBalances(orgId, dateFrom, dateTo, executor);

  // Get prior period data if needed
  let priorRows: ReportRow[] = [];
  if (compare !== "none") {
    const { getPriorPeriodRange } = await import("../lib/report-utils");
    const priorRange = getPriorPeriodRange(dateFrom, dateTo);
    priorRows = await aggregateBalances(orgId, priorRange.start, priorRange.end, executor);
  }

  return buildProfitLoss(rows, dateFrom, dateTo, compare, priorRows);
}

/**
 * Core Cash Flow logic — callable without request context.
 */
export async function computeCashFlow(
  orgId: string,
  dateFrom: string,
  dateTo: string,
  executor: DbExecutor,
) {
  const rows = await aggregateBalances(orgId, dateFrom, dateTo, executor);
  return buildCashFlow(rows, dateFrom, dateTo);
}

export async function computeTrialBalance(orgId: string, dateTo: string, executor: DbExecutor) {
  // Trial Balance is cumulative from inception — no dateFrom filter
  const rows = await aggregateBalances(orgId, null, dateTo, executor);
  return buildTrialBalance(rows, dateTo);
}
