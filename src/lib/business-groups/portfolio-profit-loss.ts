import { sql } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { buildProfitLoss, type ReportRow } from "@/lib/report-calculations";
import { centsToMoney, moneyToCents } from "@/lib/money";
import { getPriorPeriodRange } from "@/lib/report-utils";
import { getReportingProjectionStates, type ProjectionStateView } from "@/lib/reporting/projection";
import { aggregateBalances } from "@/services/reports";
import { dedupeGroupAccess, type BusinessGroupPerformanceAccess } from "./performance";

export const PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING =
  "Portfolio P&L shadow comparison is not yet supported. This statement uses authorized live ledgers.";

export type PortfolioProfitLossSourceMode = "live_ledger" | "projected";
export type PortfolioProjectionStatus =
  | "not_applicable"
  | "building"
  | "ready"
  | "stale"
  | "failed";

export interface PortfolioReportScope {
  enterpriseAccountId: string;
  groups: Array<{ id: string; name: string }>;
  organizations: Array<{
    organizationId: string;
    name: string;
    role: string;
    currency: string;
    groupIds: string[];
    groupNames: string[];
  }>;
  totalEntityCount: number;
  omittedEntityCount: number;
  duplicateMembershipCount: number;
  currency: string | null;
}

export interface PortfolioProfitLossMetadata {
  enterpriseAccountId: string;
  selectedGroups: Array<{ id: string; name: string }>;
  includedBusinesses: Array<{
    organizationId: string;
    name: string;
    groupIds: string[];
    groupNames: string[];
  }>;
  selectedGroupCount: number;
  uniqueEntityCount: number;
  totalEntityCount: number;
  omittedEntityCount: number;
  duplicateMembershipCount: number;
  currency: string | null;
  dateFrom: string;
  dateTo: string;
  compare: "none" | "prior_period";
  sourceMode: PortfolioProfitLossSourceMode;
  generatedAt: string;
  projectionAsOf: string | null;
  projectionLagSeconds: number | null;
  projectionStatus: PortfolioProjectionStatus;
  incompleteEntityCount: number;
  warnings: string[];
}

export interface PortfolioProfitLossResult {
  report: ReturnType<typeof buildProfitLoss> | null;
  metadata: PortfolioProfitLossMetadata;
}

interface ProjectedPortfolioBalanceRow {
  organizationId: string;
  accountId: string;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
  parentId: string | null;
  currentDebit: string;
  currentCredit: string;
  priorDebit: string;
  priorCredit: string;
}

interface ProjectionReadiness {
  projectionAsOf: string | null;
  projectionLagSeconds: number;
  projectionStatus: Exclude<PortfolioProjectionStatus, "not_applicable">;
  incompleteEntityCount: number;
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is outside the supported monetary range`);
  }
  return value;
}

/**
 * Combine equivalent account lines across organizations without assuming that
 * account UUIDs are shared. Account number, name, type, and subtype form the
 * management-reporting key; legal consolidation and eliminations are outside
 * this report's contract.
 */
export function combinePortfolioReportRows(rows: readonly ReportRow[]): ReportRow[] {
  const combined = new Map<
    string,
    { row: Omit<ReportRow, "totalDebit" | "totalCredit">; debit: number; credit: number }
  >();

  for (const row of rows) {
    const key = JSON.stringify([
      row.accountType,
      row.subtype,
      row.accountNumber,
      row.accountName.trim().toLocaleLowerCase("en-US"),
    ]);
    const existing = combined.get(key) ?? {
      row: {
        accountId: `portfolio:${key}`,
        accountName: row.accountName,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
        parentId: null,
      },
      debit: 0,
      credit: 0,
    };
    existing.debit = checkedAdd(
      existing.debit,
      moneyToCents(row.totalDebit, `${row.accountName} debit`),
      `${row.accountName} debit`,
    );
    existing.credit = checkedAdd(
      existing.credit,
      moneyToCents(row.totalCredit, `${row.accountName} credit`),
      `${row.accountName} credit`,
    );
    combined.set(key, existing);
  }

  return [...combined.values()]
    .sort(
      (left, right) =>
        (left.row.accountNumber ?? "").localeCompare(right.row.accountNumber ?? "") ||
        left.row.accountName.localeCompare(right.row.accountName),
    )
    .map(({ row, debit, credit }) => ({
      ...row,
      totalDebit: centsToMoney(debit),
      totalCredit: centsToMoney(credit),
    }));
}

export function buildPortfolioReportScope(
  groups: BusinessGroupPerformanceAccess[],
): PortfolioReportScope {
  if (groups.length === 0) throw new Error("At least one Business Group is required");
  const accountIds = new Set(groups.map((group) => group.enterpriseAccountId));
  if (accountIds.size !== 1) {
    throw new Error("Selected Business Groups must belong to the same Enterprise account");
  }

  const deduplicated = dedupeGroupAccess(groups);
  const currencies = new Set(deduplicated.map(({ entity }) => entity.currency));
  const totalAccessibleMemberships = groups.reduce(
    (total, group) => total + group.access.entities.length,
    0,
  );

  return {
    enterpriseAccountId: groups[0].enterpriseAccountId,
    groups: groups.map((group) => ({ id: group.groupId, name: group.groupName })),
    organizations: deduplicated.map(({ entity, groupIds, groupNames }) => ({
      organizationId: entity.organizationId,
      name: entity.name,
      role: entity.role,
      currency: entity.currency,
      groupIds,
      groupNames,
    })),
    totalEntityCount: groups.reduce((total, group) => total + group.access.totalEntityCount, 0),
    omittedEntityCount: groups.reduce((total, group) => total + group.access.omittedEntityCount, 0),
    duplicateMembershipCount: totalAccessibleMemberships - deduplicated.length,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}

function scopeWarnings(scope: PortfolioReportScope): string[] {
  const warnings: string[] = [];
  if (scope.omittedEntityCount > 0) {
    warnings.push(
      `${scope.omittedEntityCount} linked business${scope.omittedEntityCount === 1 ? " was" : "es were"} omitted because you do not have direct access.`,
    );
  }
  if (scope.duplicateMembershipCount > 0) {
    warnings.push(
      `${scope.duplicateMembershipCount} overlapping group assignment${scope.duplicateMembershipCount === 1 ? " was" : "s were"} counted once.`,
    );
  }
  if (scope.organizations.length === 0) {
    warnings.push("No accessible businesses are included in the selected Business Groups.");
  } else if (!scope.currency) {
    warnings.push(
      "Portfolio totals are unavailable because the selected businesses use different functional currencies. FX translation is not applied.",
    );
  }
  return warnings;
}

function metadata(
  scope: PortfolioReportScope,
  input: {
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    sourceMode: PortfolioProfitLossSourceMode;
  },
  readiness: {
    projectionAsOf?: string | null;
    projectionLagSeconds?: number | null;
    projectionStatus?: PortfolioProjectionStatus;
    incompleteEntityCount?: number;
    warnings?: string[];
  } = {},
): PortfolioProfitLossMetadata {
  return {
    enterpriseAccountId: scope.enterpriseAccountId,
    selectedGroups: scope.groups,
    includedBusinesses: scope.organizations.map(
      ({ organizationId, name, groupIds, groupNames }) => ({
        organizationId,
        name,
        groupIds,
        groupNames,
      }),
    ),
    selectedGroupCount: scope.groups.length,
    uniqueEntityCount: scope.organizations.length,
    totalEntityCount: scope.totalEntityCount,
    omittedEntityCount: scope.omittedEntityCount,
    duplicateMembershipCount: scope.duplicateMembershipCount,
    currency: scope.currency,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    compare: input.compare,
    sourceMode: input.sourceMode,
    generatedAt: new Date().toISOString(),
    projectionAsOf: readiness.projectionAsOf ?? null,
    projectionLagSeconds: readiness.projectionLagSeconds ?? null,
    projectionStatus: readiness.projectionStatus ?? "not_applicable",
    incompleteEntityCount: readiness.incompleteEntityCount ?? 0,
    warnings: [...scopeWarnings(scope), ...(readiness.warnings ?? [])],
  };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = Array.from({ length: values.length }) as U[];
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

export async function computeLivePortfolioProfitLoss(
  groups: BusinessGroupPerformanceAccess[],
  input: {
    userId: string;
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    warnings?: string[];
  },
): Promise<PortfolioProfitLossResult> {
  const scope = buildPortfolioReportScope(groups);
  const resultMetadata = metadata(
    scope,
    { ...input, sourceMode: "live_ledger" },
    {
      warnings: input.warnings,
    },
  );

  if (scope.organizations.length === 0 || !scope.currency) {
    return { report: null, metadata: resultMetadata };
  }

  const priorRange =
    input.compare === "prior_period" ? getPriorPeriodRange(input.dateFrom, input.dateTo) : null;
  const rows = await mapWithConcurrency(scope.organizations, 6, (organization) =>
    withOrgContext(
      organization.organizationId,
      input.userId,
      organization.role,
      async (executor) => {
        const [current, prior] = await Promise.all([
          aggregateBalances(organization.organizationId, input.dateFrom, input.dateTo, executor),
          priorRange
            ? aggregateBalances(
                organization.organizationId,
                priorRange.start,
                priorRange.end,
                executor,
              )
            : Promise.resolve([]),
        ]);
        return { current, prior };
      },
    ),
  );

  return {
    report: buildProfitLoss(
      combinePortfolioReportRows(rows.flatMap((row) => row.current)),
      input.dateFrom,
      input.dateTo,
      input.compare,
      combinePortfolioReportRows(rows.flatMap((row) => row.prior)),
    ),
    metadata: resultMetadata,
  };
}

export function summarizeProjectionReadiness(
  organizationIds: readonly string[],
  states: ReadonlyMap<string, ProjectionStateView>,
  now = new Date(),
): ProjectionReadiness {
  const incomplete = organizationIds.filter((organizationId) => {
    const state = states.get(organizationId);
    return (
      !state ||
      state.status !== "ready" ||
      state.appliedVersion < state.requestedVersion ||
      !state.initialBackfillCompletedAt
    );
  });
  const projectedDates = organizationIds
    .map((organizationId) => states.get(organizationId)?.lastProjectedAt ?? null)
    .filter((value): value is Date => value !== null);
  const projectionAsOf =
    projectedDates.length === 0
      ? null
      : new Date(Math.min(...projectedDates.map((value) => value.getTime()))).toISOString();
  const projectionLagSeconds = incomplete.reduce((maximum, organizationId) => {
    const eventAt = states.get(organizationId)?.lastLedgerEventAt;
    return Math.max(
      maximum,
      eventAt ? Math.max(0, Math.floor((now.getTime() - eventAt.getTime()) / 1000)) : 0,
    );
  }, 0);
  const failed = incomplete.some(
    (organizationId) => states.get(organizationId)?.status === "failed",
  );
  return {
    projectionAsOf,
    projectionLagSeconds,
    projectionStatus:
      incomplete.length === 0
        ? "ready"
        : failed
          ? "failed"
          : projectionLagSeconds > 300
            ? "stale"
            : "building",
    incompleteEntityCount: incomplete.length,
  };
}

async function loadProjectedPortfolioBalances(
  tx: DbExecutor,
  input: {
    organizationIds: readonly string[];
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
  },
): Promise<ProjectedPortfolioBalanceRow[]> {
  if (input.organizationIds.length === 0) return [];
  const prior = getPriorPeriodRange(input.dateFrom, input.dateTo);
  const lowerDate = input.compare === "prior_period" ? prior.start : input.dateFrom;
  const result = await tx.execute(sql`
    select
      activity.organization_id as "organizationId",
      activity.account_id as "accountId",
      account.account_name as "accountName",
      account.account_number as "accountNumber",
      account.account_type as "accountType",
      account.subtype,
      account.parent_id as "parentId",
      coalesce(sum(activity.total_debit) filter (
        where activity.activity_date between ${input.dateFrom}::date and ${input.dateTo}::date
      ), 0)::text as "currentDebit",
      coalesce(sum(activity.total_credit) filter (
        where activity.activity_date between ${input.dateFrom}::date and ${input.dateTo}::date
      ), 0)::text as "currentCredit",
      coalesce(sum(activity.total_debit) filter (
        where ${input.compare === "prior_period"}
          and activity.activity_date between ${prior.start}::date and ${prior.end}::date
      ), 0)::text as "priorDebit",
      coalesce(sum(activity.total_credit) filter (
        where ${input.compare === "prior_period"}
          and activity.activity_date between ${prior.start}::date and ${prior.end}::date
      ), 0)::text as "priorCredit"
    from organization_daily_account_activity activity
    join organization_reporting_accounts account
      on account.organization_id = activity.organization_id
     and account.account_id = activity.account_id
    where activity.organization_id in (${sql.join(
      input.organizationIds.map((organizationId) => sql`${organizationId}`),
      sql`, `,
    )})
      and activity.activity_date between ${lowerDate}::date and ${input.dateTo}::date
      and account.account_type in (
        'revenue', 'cost_of_revenue', 'expense', 'other_income', 'other_expense'
      )
    group by
      activity.organization_id,
      activity.account_id,
      account.account_name,
      account.account_number,
      account.account_type,
      account.subtype,
      account.parent_id
  `);
  return result as unknown as ProjectedPortfolioBalanceRow[];
}

function hasActivity(debit: string, credit: string): boolean {
  return moneyToCents(debit) !== 0 || moneyToCents(credit) !== 0;
}

function projectedReportRow(
  row: ProjectedPortfolioBalanceRow,
  totalDebit: string,
  totalCredit: string,
): ReportRow {
  return {
    accountId: row.accountId,
    accountName: row.accountName,
    accountNumber: row.accountNumber,
    accountType: row.accountType,
    subtype: row.subtype,
    parentId: row.parentId,
    totalDebit,
    totalCredit,
  };
}

export async function computeProjectedPortfolioProfitLoss(
  tx: DbExecutor,
  groups: BusinessGroupPerformanceAccess[],
  input: {
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    projectionStates?: ReadonlyMap<string, ProjectionStateView>;
  },
): Promise<PortfolioProfitLossResult> {
  const scope = buildPortfolioReportScope(groups);
  const organizationIds = scope.organizations.map((organization) => organization.organizationId);
  const states =
    input.projectionStates ?? (await getReportingProjectionStates(tx, organizationIds));
  const readiness = summarizeProjectionReadiness(organizationIds, states);
  const readinessWarnings =
    readiness.incompleteEntityCount === 0
      ? []
      : [
          readiness.projectionStatus === "failed"
            ? "Projected financial data could not be refreshed. The statement is withheld."
            : "Projected financial data is not current for every included business. The statement is withheld until the portfolio is ready.",
        ];
  const resultMetadata = metadata(
    scope,
    { ...input, sourceMode: "projected" },
    { ...readiness, warnings: readinessWarnings },
  );

  if (scope.organizations.length === 0 || !scope.currency || readiness.incompleteEntityCount > 0) {
    return { report: null, metadata: resultMetadata };
  }

  const rows = await loadProjectedPortfolioBalances(tx, {
    organizationIds,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    compare: input.compare,
  });
  const currentRows = rows
    .filter((row) => hasActivity(row.currentDebit, row.currentCredit))
    .map((row) => projectedReportRow(row, row.currentDebit, row.currentCredit));
  const priorRows =
    input.compare === "prior_period"
      ? rows
          .filter((row) => hasActivity(row.priorDebit, row.priorCredit))
          .map((row) => projectedReportRow(row, row.priorDebit, row.priorCredit))
      : [];

  return {
    report: buildProfitLoss(
      combinePortfolioReportRows(currentRows),
      input.dateFrom,
      input.dateTo,
      input.compare,
      combinePortfolioReportRows(priorRows),
    ),
    metadata: resultMetadata,
  };
}
