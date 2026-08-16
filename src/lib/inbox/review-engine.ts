import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { accounts } from "@/db/schema/accounts";
import {
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  reviewRuleRuns,
} from "@/db/schema/inbox";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "@/db/schema/journals";
import type { InboxServiceContext } from "./types";
import { REVIEW_AGENT_RUN_KEYS } from "./review-rule-catalog";

/**
 * The on-demand review engine: the five Review agents, evaluated against the posted ledger.
 *
 * It deliberately does NOT evaluate the nine Book rules. Those run automatically at ingest and
 * on correction (src/lib/inbox/rules.ts), against the transaction candidate — the only point at
 * which they can still be acted on. This module used to re-implement them against posted
 * journals, which produced blocking findings on entries that can no longer be un-posted, with no
 * resolution path and a period close that then never advanced. `REVIEW_AGENT_RUN_KEYS` is the
 * allowlist that keeps that from coming back.
 *
 * Note on arithmetic: the thresholds below use float math on money strings, contrary to the
 * repo's `src/lib/money.ts` rule. It is a known, contained deviation — these numbers decide only
 * whether a flag fires, never what gets posted, so a sub-cent error changes a flag and not the
 * ledger. Converting it is a separate change; do not widen it here.
 */

type LedgerRow = {
  journalId: string;
  transactionDate: string;
  accountId: string;
  accountType: string;
  subtype: string | null;
  parentId: string | null;
  debit: string | null;
  credit: string | null;
};

type FindingTarget = {
  subjectType: "journal_header" | "account_month";
  subjectId: string;
  message: string;
  evidence: Record<string, string | number | boolean | null | string[]>;
  /**
   * The accounting month the finding belongs to, used to build its fingerprint.
   *
   * This must come from the subject itself — the journal's own transaction date, or the month
   * the balance was observed in — never from the date the run happened to be triggered on.
   * When it did, resolving a finding was pointless: the next month's run minted a fresh
   * fingerprint for the same journal, re-opened it, and re-blocked the close.
   */
  period: string;
};

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function firstDayMonthsAgo(asOf: Date, months: number): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - months, 1));
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function expenseAccount(row: LedgerRow): boolean {
  return ["expense", "other_expense", "cost_of_revenue"].includes(row.accountType);
}

function groupByJournal(rows: LedgerRow[]): Map<string, LedgerRow[]> {
  const grouped = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.journalId) ?? [];
    current.push(row);
    grouped.set(row.journalId, current);
  }
  return grouped;
}

/** Earliest transaction date seen per journal, so every target can date itself. */
function journalDates(rows: LedgerRow[]): Map<string, string> {
  const dates = new Map<string, string>();
  for (const row of rows) {
    const current = dates.get(row.journalId);
    if (!current || row.transactionDate < current) dates.set(row.journalId, row.transactionDate);
  }
  return dates;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

export function evaluateUnusualSpend(
  rows: LedgerRow[],
  standardDeviations: number,
): FindingTarget[] {
  const categoryMonths = new Map<string, Map<string, number>>();
  for (const row of rows.filter(expenseAccount)) {
    const months = categoryMonths.get(row.accountId) ?? new Map<string, number>();
    const month = monthKey(row.transactionDate);
    months.set(month, (months.get(month) ?? 0) + Number(row.debit ?? "0"));
    categoryMonths.set(row.accountId, months);
  }
  const targets: FindingTarget[] = [];
  for (const [accountId, months] of categoryMonths) {
    const ordered = [...months.entries()].sort(([left], [right]) => left.localeCompare(right));
    if (ordered.length < 3) continue;
    const [latestMonth, latestSpend] = ordered.at(-1)!;
    const baseline = ordered.slice(0, -1).map(([, spend]) => spend);
    const average = baseline.reduce((sum, spend) => sum + spend, 0) / baseline.length;
    const threshold = average + standardDeviations * standardDeviation(baseline);
    if (latestSpend > threshold && latestSpend > average) {
      targets.push({
        subjectType: "account_month",
        subjectId: accountId,
        message: `Monthly spend is more than ${standardDeviations} standard deviations above its recent baseline.`,
        evidence: { month: latestMonth, latestSpend, average, threshold, standardDeviations },
        period: latestMonth,
      });
    }
  }
  return targets;
}

export function evaluateNonZeroClearing(rows: LedgerRow[], windowStart: string): FindingTarget[] {
  const accountMonths = new Map<string, Map<string, number>>();
  for (const row of rows.filter((item) => item.subtype?.includes("clearing"))) {
    const months = accountMonths.get(row.accountId) ?? new Map<string, number>();
    const month = monthKey(row.transactionDate);
    months.set(
      month,
      (months.get(month) ?? 0) + Number(row.debit ?? "0") - Number(row.credit ?? "0"),
    );
    accountMonths.set(row.accountId, months);
  }
  const targets: FindingTarget[] = [];
  for (const [accountId, months] of accountMonths) {
    let balance = 0;
    for (const [month, movement] of [...months.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      balance += movement;
      if (`${month}-01` >= windowStart && Math.abs(balance) > 0.005) {
        targets.push({
          subjectType: "account_month",
          subjectId: accountId,
          message: "Clearing account had a non-zero month-end balance.",
          evidence: { month, balance },
          period: month,
        });
      }
    }
  }
  return targets;
}

export function evaluateMaterialExpense(
  rows: LedgerRow[],
  annualizedExpensePercent: number,
): FindingTarget[] {
  const monthlyTotals = new Map<string, number>();
  for (const row of rows.filter(expenseAccount)) {
    if (row.subtype?.includes("payroll")) continue;
    const month = monthKey(row.transactionDate);
    monthlyTotals.set(month, (monthlyTotals.get(month) ?? 0) + Number(row.debit ?? "0"));
  }
  if (monthlyTotals.size === 0) return [];
  const averageMonthly =
    [...monthlyTotals.values()].reduce((sum, value) => sum + value, 0) / monthlyTotals.size;
  const threshold = averageMonthly * 12 * (annualizedExpensePercent / 100);
  const dates = journalDates(rows);
  const journalExpenses = new Map<string, number>();
  for (const row of rows.filter(expenseAccount)) {
    if (row.subtype?.includes("payroll")) continue;
    journalExpenses.set(
      row.journalId,
      (journalExpenses.get(row.journalId) ?? 0) + Number(row.debit ?? "0"),
    );
  }
  return [...journalExpenses.entries()]
    .filter(([, total]) => total > threshold)
    .map(([journalId, total]) => ({
      subjectType: "journal_header" as const,
      subjectId: journalId,
      message: `Expense transaction exceeds ${annualizedExpensePercent}% of annualized recent expenses.`,
      evidence: { total, threshold, averageMonthly, annualizedExpensePercent },
      period: monthKey(dates.get(journalId) ?? ""),
    }));
}

export function evaluateMaterialAsset(
  windowRows: LedgerRow[],
  assetHistoryRows: LedgerRow[],
  windowStart: string,
  asOfDate: string,
  totalAssetPercent: number,
): FindingTarget[] {
  const start = new Date(`${windowStart}T00:00:00.000Z`);
  const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
  const monthEnds: string[] = [];
  for (
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    cursor <= asOf;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 0))
  ) {
    monthEnds.push(isoDate(cursor > asOf ? asOf : cursor));
  }
  if (monthEnds.length === 0) return [];
  const balances = monthEnds.map((endDate) =>
    assetHistoryRows
      .filter((row) => row.transactionDate <= endDate)
      .reduce((sum, row) => sum + Number(row.debit ?? "0") - Number(row.credit ?? "0"), 0),
  );
  const averageAssets = balances.reduce((sum, balance) => sum + balance, 0) / balances.length;
  const threshold = Math.abs(averageAssets) * (totalAssetPercent / 100);
  if (threshold <= 0) return [];

  const dates = journalDates(windowRows);
  const investmentTransactions = new Map<string, number>();
  for (const row of windowRows.filter((item) => item.subtype?.includes("investment"))) {
    investmentTransactions.set(
      row.journalId,
      (investmentTransactions.get(row.journalId) ?? 0) +
        Math.max(Number(row.debit ?? "0"), Number(row.credit ?? "0")),
    );
  }
  return [...investmentTransactions.entries()]
    .filter(([, total]) => total > threshold)
    .map(([journalId, total]) => ({
      subjectType: "journal_header" as const,
      subjectId: journalId,
      message: `Investment asset transaction exceeds ${totalAssetPercent}% of average recent total assets.`,
      evidence: { total, threshold, averageAssets, totalAssetPercent },
      period: monthKey(dates.get(journalId) ?? ""),
    }));
}

/**
 * Journals with a line posted directly to a parent category rather than a leaf.
 *
 * Extracted from the deleted `evaluateTransactionRule`, which re-implemented the book rules a
 * second time and had already drifted from `rules.ts` (its `missing_receipt` compared a raw
 * float sum with no currency conversion, where `rules.ts` converts through the candidate's
 * exchange rate). This is the one case in that switch that belongs to the Review group.
 */
export function evaluateTransactionInParentCategory(
  byJournal: Map<string, LedgerRow[]>,
  parentAccountIds: Set<string>,
): FindingTarget[] {
  const targets: FindingTarget[] = [];
  for (const [journalId, rows] of byJournal) {
    const hits = rows.filter((row) => parentAccountIds.has(row.accountId));
    if (hits.length === 0) continue;
    targets.push({
      subjectType: "journal_header",
      subjectId: journalId,
      message: "Transaction posts directly to a parent category.",
      evidence: { accountIds: [...new Set(hits.map((row) => row.accountId))] },
      period: monthKey(rows[0].transactionDate),
    });
  }
  return targets;
}

export async function runConfiguredReviewRules(
  ctx: InboxServiceContext,
  asOfDate = isoDate(new Date()),
  /** Restrict the run to these rule keys. Still intersected with the review-group allowlist. */
  ruleKeys?: string[],
) {
  const requested = ruleKeys && ruleKeys.length > 0 ? new Set(ruleKeys) : null;
  const { db, orgId, userId } = ctx;
  const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
  const definitions = await db
    .select()
    .from(reviewRuleDefinitions)
    .orderBy(asc(reviewRuleDefinitions.group), asc(reviewRuleDefinitions.name));
  const configs = await db
    .select()
    .from(reviewRuleConfigs)
    .where(eq(reviewRuleConfigs.organizationId, orgId));
  const configByDefinition = new Map(configs.map((config) => [config.definitionId, config]));

  for (const definition of definitions) {
    // System rules are raised by background handlers with a hardcoded impact and read no
    // config. A row here would be a knob wired to nothing.
    if (definition.group === "system") continue;
    if (configByDefinition.has(definition.id)) continue;
    const [config] = await db
      .insert(reviewRuleConfigs)
      .values({
        organizationId: orgId,
        definitionId: definition.id,
        enabled: true,
        impact: definition.group === "review" ? "warning" : "blocking",
        lookbackMonths: 3,
        config: definition.defaultConfig,
        updatedBy: userId,
      })
      .onConflictDoNothing()
      .returning();
    if (config) configByDefinition.set(definition.id, config);
  }
  const maxLookbackMonths = Math.max(
    1,
    ...[...configByDefinition.values()].map((config) => config.lookbackMonths),
  );
  const windowStart = isoDate(firstDayMonthsAgo(asOf, maxLookbackMonths - 1));

  const ledgerRows = await db
    .select({
      journalId: journalHeaders.id,
      transactionDate: journalHeaders.transactionDate,
      accountId: journalLines.accountId,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalHeaders)
    .innerJoin(journalLines, eq(journalLines.journalHeaderId, journalHeaders.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalHeaders.organizationId, orgId),
        eq(journalHeaders.status, "posted"),
        effectiveJournalPredicate(),
        gte(journalHeaders.transactionDate, windowStart),
        lte(journalHeaders.transactionDate, asOfDate),
      ),
    );
  const assetHistoryRows = await db
    .select({
      journalId: journalHeaders.id,
      transactionDate: journalHeaders.transactionDate,
      accountId: journalLines.accountId,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalHeaders)
    .innerJoin(journalLines, eq(journalLines.journalHeaderId, journalHeaders.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalHeaders.organizationId, orgId),
        eq(journalHeaders.status, "posted"),
        effectiveJournalPredicate(),
        eq(accounts.accountType, "asset"),
        lte(journalHeaders.transactionDate, asOfDate),
      ),
    );
  const clearingHistoryRows = await db
    .select({
      journalId: journalHeaders.id,
      transactionDate: journalHeaders.transactionDate,
      accountId: journalLines.accountId,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalHeaders)
    .innerJoin(journalLines, eq(journalLines.journalHeaderId, journalHeaders.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalHeaders.organizationId, orgId),
        eq(journalHeaders.status, "posted"),
        effectiveJournalPredicate(),
        sql`lower(coalesce(${accounts.subtype}, '')) like '%clearing%'`,
        lte(journalHeaders.transactionDate, asOfDate),
      ),
    );
  const parentAccountIds = new Set(
    ledgerRows.flatMap((row) => (row.parentId ? [row.parentId] : [])),
  );

  const runResults: Array<{ ruleKey: string; findingCount: number }> = [];
  for (const definition of definitions) {
    if (!REVIEW_AGENT_RUN_KEYS.has(definition.key)) continue;
    if (requested && !requested.has(definition.key)) continue;
    const config = configByDefinition.get(definition.id);
    if (!config?.enabled) continue;
    const merged = {
      ...(definition.defaultConfig as Record<string, unknown>),
      ...(config.config as Record<string, unknown>),
    };
    const ruleWindowStart = isoDate(
      firstDayMonthsAgo(asOf, Math.max(0, config.lookbackMonths - 1)),
    );
    const ruleRows = ledgerRows.filter((row) => row.transactionDate >= ruleWindowStart);
    const [run] = await db
      .insert(reviewRuleRuns)
      .values({
        organizationId: orgId,
        ruleConfigId: config.id,
        trigger: "manual",
        windowStart: ruleWindowStart,
        windowEnd: asOfDate,
        asOfDate,
        configSnapshot: {
          ...merged,
          lookbackMonths: config.lookbackMonths,
          version: config.version,
        },
      })
      .returning();

    let targets: FindingTarget[] = [];
    if (definition.key === "unusual_spend") {
      targets = evaluateUnusualSpend(ruleRows, numberConfig(merged, "standardDeviations", 3));
    } else if (definition.key === "non_zero_clearing") {
      targets = evaluateNonZeroClearing(clearingHistoryRows, ruleWindowStart);
    } else if (definition.key === "material_expense") {
      targets = evaluateMaterialExpense(
        ruleRows,
        numberConfig(merged, "annualizedExpensePercent", 1),
      );
    } else if (definition.key === "material_asset") {
      targets = evaluateMaterialAsset(
        ruleRows,
        assetHistoryRows,
        ruleWindowStart,
        asOfDate,
        numberConfig(merged, "totalAssetPercent", 0.5),
      );
    } else if (definition.key === "transaction_in_parent_category") {
      targets = evaluateTransactionInParentCategory(groupByJournal(ruleRows), parentAccountIds);
    }

    for (const target of targets) {
      const period = target.period || monthKey(asOfDate);
      await db
        .insert(reviewFindings)
        .values({
          organizationId: orgId,
          ruleConfigId: config.id,
          ruleRunId: run.id,
          ruleKey: definition.key,
          impact: config.impact,
          subjectType: target.subjectType,
          subjectId: target.subjectId,
          fingerprint: `${definition.key}:${target.subjectType}:${target.subjectId}:${period}`,
          message: target.message,
          evidence: target.evidence,
          formulaVersion: definition.formulaVersion,
        })
        .onConflictDoUpdate({
          target: [reviewFindings.organizationId, reviewFindings.fingerprint],
          set: {
            // `state` is deliberately absent: a finding a reviewer already resolved must stay
            // resolved. Re-observing the same condition is not new information — the reviewer
            // documented an exception for exactly this fact, and reopening it would erase that
            // judgement and re-block a closed period on every run. The advancing `lastSeenAt`
            // is what records that the condition still holds.
            //
            // The system inserters (terminal-processing-failure.ts, jobs/handlers/inbound-email.ts)
            // deliberately do the opposite and reset `state` to "open", because a retried job
            // failing again IS a new failure. Do not converge the two.
            lastSeenAt: new Date(),
            ruleRunId: run.id,
            message: target.message,
            evidence: target.evidence,
            formulaVersion: definition.formulaVersion,
          },
        });
    }
    await db
      .update(reviewRuleRuns)
      .set({
        status: "completed",
        counts: { scanned: ruleRows.length, findings: targets.length },
        completedAt: new Date(),
      })
      .where(eq(reviewRuleRuns.id, run.id));
    runResults.push({ ruleKey: definition.key, findingCount: targets.length });
  }
  return { asOfDate, windowStart, rules: runResults };
}
