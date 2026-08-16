import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import type { ReportRow } from "@/lib/report-calculations";
import { moneyToCents } from "@/lib/money";
import { getPriorPeriodRange } from "@/lib/report-utils";
import { getReportingProjectionStates, type ProjectionStateView } from "@/lib/reporting/projection";
import {
  buildProjectedEntityReadiness,
  paginateEntityReadiness,
  projectionReadinessWarning,
} from "./entity-readiness";
import {
  accessWarnings,
  aggregateMetrics,
  attachUnpaginatedPerformanceEntities,
  buildEntityPerformanceMetric,
  compareMoneyAmounts,
  dedupeGroupAccess,
  type BusinessGroupPerformanceAccess,
  type BusinessGroupPerformanceSlice,
  type BusinessGroupsPerformanceResult,
  type EntityReadiness,
  type EntityReadinessSummary,
  type PortfolioEntityPerformanceMetric,
} from "./performance";

interface ProjectedBalanceRow {
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
  cashDebit: string;
  cashCredit: string;
}

function reportRow(row: ProjectedBalanceRow, totalDebit: string, totalCredit: string): ReportRow {
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

function nonZero(debit: string, credit: string): boolean {
  return moneyToCents(debit) !== 0 || moneyToCents(credit) !== 0;
}

async function loadProjectedBalances(
  tx: DbExecutor,
  input: {
    organizationIds: readonly string[];
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
  },
): Promise<ProjectedBalanceRow[]> {
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
      ), 0)::text as "priorCredit",
      coalesce(sum(activity.total_debit) filter (
        where account.subtype = 'bank_accounts'
          and activity.activity_date <= ${input.dateTo}::date
      ), 0)::text as "cashDebit",
      coalesce(sum(activity.total_credit) filter (
        where account.subtype = 'bank_accounts'
          and activity.activity_date <= ${input.dateTo}::date
      ), 0)::text as "cashCredit"
    from organization_daily_account_activity activity
    join organization_reporting_accounts account
      on account.organization_id = activity.organization_id
     and account.account_id = activity.account_id
    where activity.organization_id in (${sql.join(
      input.organizationIds.map((organizationId) => sql`${organizationId}`),
      sql`, `,
    )})
      and activity.activity_date <= ${input.dateTo}::date
      and (
        activity.activity_date >= ${lowerDate}::date
        or account.subtype = 'bank_accounts'
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
  return result as unknown as ProjectedBalanceRow[];
}

function unavailableResult(
  groups: BusinessGroupPerformanceAccess[],
  input: {
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    page: number;
    pageSize: number;
    sourceMode: "projected" | "shadow";
  },
  metadata: {
    projectionAsOf: string | null;
    projectionLagSeconds: number | null;
    projectionSyncAgeSeconds: number | null;
    projectionStatus: "building" | "stale" | "failed";
    incompleteEntityCount: number;
    entityReadiness: EntityReadiness[];
    entityReadinessSummary: EntityReadinessSummary;
  },
): BusinessGroupsPerformanceResult {
  const omittedEntityCount = groups.reduce(
    (total, group) => total + group.access.omittedEntityCount,
    0,
  );
  const uniqueEntityCount = dedupeGroupAccess(groups).length;
  const warnings = [projectionReadinessWarning(input.sourceMode, metadata.projectionStatus)];
  if (omittedEntityCount > 0) {
    warnings.push(
      `${omittedEntityCount} linked group ${omittedEntityCount === 1 ? "entry was" : "entries were"} omitted because you do not have direct access.`,
    );
  }
  return attachUnpaginatedPerformanceEntities(
    {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      compare: input.compare,
      sourceMode: input.sourceMode,
      generatedAt: new Date().toISOString(),
      ...metadata,
      selectedGroupCount: groups.length,
      entities: [],
      page: input.page,
      pageSize: input.pageSize,
      uniqueEntityCount,
      groups: groups.map((group) => ({
        groupId: group.groupId,
        groupName: group.groupName,
        accessibleEntityCount: group.access.entities.length,
        aggregate: null,
        aggregateCurrency: null,
        totalEntityCount: group.access.totalEntityCount,
        omittedEntityCount: group.access.omittedEntityCount,
        warnings: accessWarnings(group.access, false),
      })),
      aggregate: null,
      aggregateCurrency: null,
      totalEntityCount: groups.reduce((total, group) => total + group.access.totalEntityCount, 0),
      omittedEntityCount,
      duplicateMembershipCount:
        groups.reduce((total, group) => total + group.access.entities.length, 0) -
        uniqueEntityCount,
      warnings,
    },
    [],
  );
}

export async function computeProjectedBusinessGroupsPerformance(
  tx: DbExecutor,
  groups: BusinessGroupPerformanceAccess[],
  input: {
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    page?: number;
    pageSize?: number;
    sourceMode?: "projected" | "shadow";
    projectionStates?: ReadonlyMap<string, ProjectionStateView>;
  },
): Promise<BusinessGroupsPerformanceResult> {
  const sourceMode = input.sourceMode ?? "projected";
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, Math.min(25, input.pageSize ?? 25));
  const deduplicated = dedupeGroupAccess(groups);
  const organizationIds = deduplicated.map((membership) => membership.entity.organizationId);
  const states =
    input.projectionStates ?? (await getReportingProjectionStates(tx, organizationIds));
  const allEntityReadiness = buildProjectedEntityReadiness(deduplicated, states);
  const incomplete = allEntityReadiness.filter((readiness) => readiness.status !== "ready");
  const projectedDates = organizationIds
    .map((organizationId) => states.get(organizationId)?.lastProjectedAt ?? null)
    .filter((value): value is Date => value !== null);
  const projectionAsOf =
    projectedDates.length === 0
      ? null
      : new Date(Math.min(...projectedDates.map((value) => value.getTime()))).toISOString();
  const ledgerLags = allEntityReadiness
    .map((readiness) => readiness.ledgerLagSeconds)
    .filter((lag): lag is number => lag !== null);
  const projectionLagSeconds = ledgerLags.length > 0 ? Math.max(...ledgerLags) : null;
  const syncAges = incomplete
    .map((readiness) => readiness.syncAgeSeconds)
    .filter((age): age is number => age !== null);
  const projectionSyncAgeSeconds = syncAges.length > 0 ? Math.max(...syncAges) : null;
  const failed = incomplete.some((readiness) => readiness.status === "failed");
  if (incomplete.length > 0) {
    const boundedReadiness = paginateEntityReadiness(allEntityReadiness, {
      page,
      pageSize,
    });
    return unavailableResult(
      groups,
      { ...input, page, pageSize, sourceMode },
      {
        projectionAsOf,
        projectionLagSeconds,
        projectionSyncAgeSeconds,
        projectionStatus: failed
          ? "failed"
          : incomplete.some((readiness) => readiness.status === "stale")
            ? "stale"
            : "building",
        incompleteEntityCount: incomplete.length,
        ...boundedReadiness,
      },
    );
  }

  const balances = await loadProjectedBalances(tx, {
    organizationIds,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    compare: input.compare,
  });
  const balancesByOrganization = new Map<string, ProjectedBalanceRow[]>();
  for (const row of balances) {
    const rows = balancesByOrganization.get(row.organizationId) ?? [];
    rows.push(row);
    balancesByOrganization.set(row.organizationId, rows);
  }

  const computed = deduplicated.map((membership): PortfolioEntityPerformanceMetric => {
    const rows = balancesByOrganization.get(membership.entity.organizationId) ?? [];
    const currentRows = rows
      .filter((row) => nonZero(row.currentDebit, row.currentCredit))
      .map((row) => reportRow(row, row.currentDebit, row.currentCredit));
    const priorRows = rows
      .filter((row) => nonZero(row.priorDebit, row.priorCredit))
      .map((row) => reportRow(row, row.priorDebit, row.priorCredit));
    const asOfRows = rows
      .filter((row) => row.subtype === "bank_accounts")
      .map((row) => reportRow(row, row.cashDebit, row.cashCredit));
    const metric = buildEntityPerformanceMetric({
      entityId: membership.entity.id,
      organizationId: membership.entity.organizationId,
      name: membership.entity.name,
      currency: membership.entity.currency,
      currentRows,
      priorRows: input.compare === "prior_period" && priorRows.length > 0 ? priorRows : null,
      asOfRows,
    });
    return { ...metric, groupIds: membership.groupIds, groupNames: membership.groupNames };
  });
  computed.sort(
    (left, right) =>
      compareMoneyAmounts(right.netIncome, left.netIncome) || left.name.localeCompare(right.name),
  );
  const metricByOrganization = new Map(
    computed.map((metric) => [metric.organizationId, metric] as const),
  );
  const groupResults: BusinessGroupPerformanceSlice[] = groups.map((group) => {
    const entities = group.access.entities
      .map((entity) => metricByOrganization.get(entity.organizationId))
      .filter((entity): entity is PortfolioEntityPerformanceMetric => Boolean(entity));
    const { aggregate, aggregateCurrency } = aggregateMetrics(entities);
    return {
      groupId: group.groupId,
      groupName: group.groupName,
      accessibleEntityCount: entities.length,
      aggregate,
      aggregateCurrency,
      totalEntityCount: group.access.totalEntityCount,
      omittedEntityCount: group.access.omittedEntityCount,
      warnings: accessWarnings(group.access, aggregate !== null),
    };
  });
  const { aggregate, aggregateCurrency } = aggregateMetrics(computed);
  const accessibleMembershipCount = groups.reduce(
    (total, group) => total + group.access.entities.length,
    0,
  );
  const duplicateMembershipCount = accessibleMembershipCount - computed.length;
  const omittedEntityCount = groups.reduce(
    (total, group) => total + group.access.omittedEntityCount,
    0,
  );
  const warnings: string[] = [];
  if (omittedEntityCount > 0) {
    warnings.push(
      `${omittedEntityCount} linked group ${omittedEntityCount === 1 ? "entry was" : "entries were"} omitted because you do not have direct access.`,
    );
  }
  if (duplicateMembershipCount > 0) {
    warnings.push(
      `${duplicateMembershipCount} overlapping group ${duplicateMembershipCount === 1 ? "assignment was" : "assignments were"} counted once in the combined totals.`,
    );
  }
  if (computed.length > 1 && aggregate === null) {
    warnings.push(
      "Combined totals are unavailable because the selected businesses use different functional currencies.",
    );
  }
  const offset = (page - 1) * pageSize;
  const readinessByOrganization = new Map(
    allEntityReadiness.map((readiness) => [readiness.organizationId, readiness] as const),
  );
  const orderedReadiness = computed
    .map((metric) => readinessByOrganization.get(metric.organizationId))
    .filter((readiness): readiness is EntityReadiness => Boolean(readiness));
  const boundedReadiness = paginateEntityReadiness(orderedReadiness, {
    page,
    pageSize,
    prioritizeActionable: false,
  });

  return attachUnpaginatedPerformanceEntities(
    {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      compare: input.compare,
      sourceMode,
      generatedAt: new Date().toISOString(),
      projectionAsOf,
      projectionLagSeconds,
      projectionSyncAgeSeconds: null,
      projectionStatus: "ready",
      incompleteEntityCount: 0,
      ...boundedReadiness,
      selectedGroupCount: groups.length,
      entities: computed.slice(offset, offset + pageSize),
      page,
      pageSize,
      uniqueEntityCount: computed.length,
      groups: groupResults,
      aggregate,
      aggregateCurrency,
      totalEntityCount: groups.reduce((total, group) => total + group.access.totalEntityCount, 0),
      omittedEntityCount,
      duplicateMembershipCount,
      warnings,
    },
    computed,
  );
}
