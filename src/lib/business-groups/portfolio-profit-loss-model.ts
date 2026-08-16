import { buildProfitLoss, type ReportRow } from "@/lib/report-calculations";
import { centsToMoney, moneyToCents } from "@/lib/money";
import type { ProjectionStateView } from "@/lib/reporting/projection-types";
import { dedupeGroupAccess, type BusinessGroupPerformanceAccess } from "./performance-model";

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

export interface ProjectionReadiness {
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

/** Combine equivalent cross-organization lines using management-reporting keys. */
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

export function buildPortfolioProfitLossMetadata(
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
