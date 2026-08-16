import { withOrgContext } from "../../db";
import type { ReportRow } from "../../lib/report-calculations";
import { centsToMoney, moneyToCents } from "../../lib/money";
import { getPriorPeriodRange } from "../../lib/report-utils";
import { aggregateBalances } from "../../services/reports";
import type { AccessibleGroupEntity, GroupEntityAccessView } from "./service";

export interface EntityPerformanceMetric {
  entityId: string;
  organizationId: string;
  name: string;
  currency: string;
  revenue: string;
  priorRevenue: string | null;
  revenueChangePct: number | null;
  grossProfit: string;
  grossMargin: number | null;
  operatingExpenses: string;
  operatingIncome: string;
  operatingMargin: number | null;
  netIncome: string;
  priorNetIncome: string | null;
  netMargin: number | null;
  cash: string;
  profitable: boolean;
}

export type AggregatePerformanceMetric = Omit<
  EntityPerformanceMetric,
  "entityId" | "organizationId" | "name" | "profitable"
>;

export interface GroupPerformanceResult {
  dateFrom: string;
  dateTo: string;
  compare: "none" | "prior_period";
  sourceMode: "live_ledger" | "shadow" | "projected";
  generatedAt: string;
  projectionAsOf: string | null;
  projectionLagSeconds: number | null;
  projectionStatus: "not_applicable" | "building" | "ready" | "stale" | "failed";
  incompleteEntityCount: number;
  entities: EntityPerformanceMetric[];
  aggregate: AggregatePerformanceMetric | null;
  aggregateCurrency: string | null;
  totalEntityCount: number;
  omittedEntityCount: number;
  warnings: string[];
}

export interface BusinessGroupPerformanceSlice {
  groupId: string;
  groupName: string;
  accessibleEntityCount: number;
  aggregate: AggregatePerformanceMetric | null;
  aggregateCurrency: string | null;
  totalEntityCount: number;
  omittedEntityCount: number;
  warnings: string[];
}

export interface PortfolioEntityPerformanceMetric extends EntityPerformanceMetric {
  groupIds: string[];
  groupNames: string[];
}

export type EntityReadinessStatus =
  | "missing"
  | "pending"
  | "building"
  | "ready"
  | "stale"
  | "failed";

/**
 * Safe, authorization-filtered projection state for one business. Internal
 * projection versions and worker errors intentionally stay server-side.
 */
export interface EntityReadiness {
  organizationId: string;
  name: string;
  groupIds: string[];
  groupNames: string[];
  status: EntityReadinessStatus;
  projectionAsOf: string | null;
  syncActivityAt: string | null;
  syncAgeSeconds: number | null;
  ledgerLagSeconds: number | null;
}

export interface EntityReadinessSummary {
  total: number;
  page: number;
  pageSize: number;
  returnedCount: number;
  statusCounts: Record<EntityReadinessStatus, number>;
}

export interface BusinessGroupsPerformanceResult {
  dateFrom: string;
  dateTo: string;
  compare: "none" | "prior_period";
  sourceMode: "live_ledger" | "shadow" | "projected";
  generatedAt: string;
  projectionAsOf: string | null;
  projectionLagSeconds: number | null;
  projectionSyncAgeSeconds: number | null;
  projectionStatus: "not_applicable" | "building" | "ready" | "stale" | "failed";
  incompleteEntityCount: number;
  entityReadiness: EntityReadiness[];
  entityReadinessSummary: EntityReadinessSummary | null;
  selectedGroupCount: number;
  entities: PortfolioEntityPerformanceMetric[];
  page: number;
  pageSize: number;
  uniqueEntityCount: number;
  groups: BusinessGroupPerformanceSlice[];
  aggregate: AggregatePerformanceMetric | null;
  aggregateCurrency: string | null;
  totalEntityCount: number;
  omittedEntityCount: number;
  duplicateMembershipCount: number;
  warnings: string[];
}

export interface BusinessGroupPerformanceAccess {
  enterpriseAccountId: string;
  groupId: string;
  groupName: string;
  access: GroupEntityAccessView;
}

const unpaginatedEntities = new WeakMap<
  BusinessGroupsPerformanceResult,
  readonly PortfolioEntityPerformanceMetric[]
>();

/**
 * Keep shadow-reconciliation input server-local without adding thousands of
 * rows to the serialized page response.
 */
export function attachUnpaginatedPerformanceEntities(
  result: BusinessGroupsPerformanceResult,
  entities: readonly PortfolioEntityPerformanceMetric[],
): BusinessGroupsPerformanceResult {
  unpaginatedEntities.set(result, entities);
  return result;
}

export function getUnpaginatedPerformanceEntities(
  result: BusinessGroupsPerformanceResult,
): readonly PortfolioEntityPerformanceMetric[] {
  return unpaginatedEntities.get(result) ?? result.entities;
}

export const PERFORMANCE_MONEY_METRICS = [
  "revenue",
  "priorRevenue",
  "grossProfit",
  "operatingExpenses",
  "operatingIncome",
  "netIncome",
  "priorNetIncome",
  "cash",
] as const satisfies readonly (keyof EntityPerformanceMetric)[];

export const PERFORMANCE_PERCENT_METRICS = [
  "revenueChangePct",
  "grossMargin",
  "operatingMargin",
  "netMargin",
] as const satisfies readonly (keyof EntityPerformanceMetric)[];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentFromCents(numeratorCents: number, denominatorCents: number): number | null {
  if (denominatorCents === 0) return null;
  return round2((numeratorCents / Math.abs(denominatorCents)) * 100);
}

function checkedCents(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} is outside the supported monetary range`);
  }
  return value;
}

function addCents(left: number, right: number, field: string): number {
  return checkedCents(left + right, field);
}

function subtractCents(left: number, right: number, field: string): number {
  return checkedCents(left - right, field);
}

function normalizedAccountBalanceCents(row: ReportRow): number {
  const raw = subtractCents(
    moneyToCents(row.totalDebit, `${row.accountName} debit`),
    moneyToCents(row.totalCredit, `${row.accountName} credit`),
    `${row.accountName} balance`,
  );
  return ["liability", "equity", "revenue", "other_income"].includes(row.accountType) ? -raw : raw;
}

interface ProfitLossCents {
  revenue: number;
  costOfRevenue: number;
  operatingExpenses: number;
  otherIncome: number;
  otherExpenses: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
}

function profitLossCents(rows: readonly ReportRow[]): ProfitLossCents {
  let revenue = 0;
  let costOfRevenue = 0;
  let operatingExpenses = 0;
  let otherIncome = 0;
  let otherExpenses = 0;
  for (const row of rows) {
    const balance = normalizedAccountBalanceCents(row);
    if (row.accountType === "revenue") revenue = addCents(revenue, balance, "revenue");
    else if (row.accountType === "cost_of_revenue") {
      costOfRevenue = addCents(costOfRevenue, balance, "cost of revenue");
    } else if (row.accountType === "expense") {
      operatingExpenses = addCents(operatingExpenses, balance, "operating expenses");
    } else if (row.accountType === "other_income") {
      otherIncome = addCents(otherIncome, balance, "other income");
    } else if (row.accountType === "other_expense") {
      otherExpenses = addCents(otherExpenses, balance, "other expenses");
    }
  }
  const grossProfit = subtractCents(revenue, costOfRevenue, "gross profit");
  const operatingIncome = subtractCents(grossProfit, operatingExpenses, "operating income");
  const netIncome = subtractCents(
    addCents(operatingIncome, otherIncome, "income before other expenses"),
    otherExpenses,
    "net income",
  );
  return {
    revenue,
    costOfRevenue,
    operatingExpenses,
    otherIncome,
    otherExpenses,
    grossProfit,
    operatingIncome,
    netIncome,
  };
}

export function compareMoneyAmounts(left: string, right: string): number {
  const leftCents = moneyToCents(left);
  const rightCents = moneyToCents(right);
  return leftCents === rightCents ? 0 : leftCents < rightCents ? -1 : 1;
}

export function buildEntityPerformanceMetric(input: {
  entityId: string;
  organizationId: string;
  name: string;
  currency: string;
  currentRows: readonly ReportRow[];
  priorRows: readonly ReportRow[] | null;
  asOfRows: readonly ReportRow[];
}): EntityPerformanceMetric {
  const current = profitLossCents(input.currentRows);
  const prior = input.priorRows ? profitLossCents(input.priorRows) : null;
  const cashCents = input.asOfRows.reduce((total, row) => {
    if (row.subtype !== "bank_accounts") return total;
    return subtractCents(
      addCents(
        total,
        moneyToCents(row.totalDebit, `${row.accountName} cash debit`),
        "cash balance",
      ),
      moneyToCents(row.totalCredit, `${row.accountName} cash credit`),
      "cash balance",
    );
  }, 0);

  return {
    entityId: input.entityId,
    organizationId: input.organizationId,
    name: input.name,
    currency: input.currency,
    revenue: centsToMoney(current.revenue),
    priorRevenue: prior ? centsToMoney(prior.revenue) : null,
    revenueChangePct: prior
      ? percentFromCents(
          subtractCents(current.revenue, prior.revenue, "revenue change"),
          prior.revenue,
        )
      : null,
    grossProfit: centsToMoney(current.grossProfit),
    grossMargin: percentFromCents(current.grossProfit, current.revenue),
    operatingExpenses: centsToMoney(current.operatingExpenses),
    operatingIncome: centsToMoney(current.operatingIncome),
    operatingMargin: percentFromCents(current.operatingIncome, current.revenue),
    netIncome: centsToMoney(current.netIncome),
    priorNetIncome: prior ? centsToMoney(prior.netIncome) : null,
    netMargin: percentFromCents(current.netIncome, current.revenue),
    cash: centsToMoney(cashCents),
    profitable: current.netIncome >= 0,
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

async function computeEntityPerformance(
  entity: AccessibleGroupEntity,
  userId: string,
  dateFrom: string,
  dateTo: string,
  compare: "none" | "prior_period",
): Promise<EntityPerformanceMetric> {
  return withOrgContext(entity.organizationId, userId, entity.role, async (executor) => {
    const priorRange = compare === "prior_period" ? getPriorPeriodRange(dateFrom, dateTo) : null;
    const [currentRows, priorRows, asOfRows] = await Promise.all([
      aggregateBalances(entity.organizationId, dateFrom, dateTo, executor),
      priorRange
        ? aggregateBalances(entity.organizationId, priorRange.start, priorRange.end, executor)
        : Promise.resolve(null),
      aggregateBalances(entity.organizationId, null, dateTo, executor),
    ]);
    return buildEntityPerformanceMetric({
      entityId: entity.id,
      organizationId: entity.organizationId,
      name: entity.name,
      currency: entity.currency,
      currentRows,
      // An empty result has no comparable historical activity. Keep it
      // unavailable instead of presenting a potentially misleading zero.
      priorRows: priorRows && priorRows.length > 0 ? priorRows : null,
      asOfRows,
    });
  });
}

export function aggregateMetrics(entities: EntityPerformanceMetric[]) {
  const currency = entities[0]?.currency ?? null;
  if (!currency || entities.some((entity) => entity.currency !== currency)) {
    return { aggregate: null, aggregateCurrency: null };
  }
  const sumCents = (key: (typeof PERFORMANCE_MONEY_METRICS)[number]) =>
    entities.reduce((total, entity) => {
      const value = entity[key];
      return addCents(
        total,
        typeof value === "string" ? moneyToCents(value, key) : 0,
        `${key} aggregate`,
      );
    }, 0);
  const revenueCents = sumCents("revenue");
  const priorRevenueAvailable = entities.every((entity) => entity.priorRevenue !== null);
  const priorNetIncomeAvailable = entities.every((entity) => entity.priorNetIncome !== null);
  const priorRevenueCents = priorRevenueAvailable ? sumCents("priorRevenue") : null;
  const netIncomeCents = sumCents("netIncome");
  const grossProfitCents = sumCents("grossProfit");
  const operatingIncomeCents = sumCents("operatingIncome");
  return {
    aggregateCurrency: currency,
    aggregate: {
      currency,
      revenue: centsToMoney(revenueCents),
      priorRevenue: priorRevenueCents === null ? null : centsToMoney(priorRevenueCents),
      revenueChangePct:
        priorRevenueCents === null
          ? null
          : percentFromCents(
              subtractCents(revenueCents, priorRevenueCents, "aggregate revenue change"),
              priorRevenueCents,
            ),
      grossProfit: centsToMoney(grossProfitCents),
      grossMargin: percentFromCents(grossProfitCents, revenueCents),
      operatingExpenses: centsToMoney(sumCents("operatingExpenses")),
      operatingIncome: centsToMoney(operatingIncomeCents),
      operatingMargin: percentFromCents(operatingIncomeCents, revenueCents),
      netIncome: centsToMoney(netIncomeCents),
      priorNetIncome: priorNetIncomeAvailable ? centsToMoney(sumCents("priorNetIncome")) : null,
      netMargin: percentFromCents(netIncomeCents, revenueCents),
      cash: centsToMoney(sumCents("cash")),
    },
  };
}

export function accessWarnings(
  access: GroupEntityAccessView,
  aggregateAvailable: boolean,
): string[] {
  const warnings: string[] = [];
  if (access.omittedEntityCount > 0) {
    warnings.push(
      `${access.omittedEntityCount} linked business${access.omittedEntityCount === 1 ? " was" : "es were"} omitted because you do not have direct access.`,
    );
  }
  if (access.entities.length > 1 && !aggregateAvailable) {
    warnings.push(
      "Combined totals are unavailable because the selected businesses use different functional currencies.",
    );
  }
  return warnings;
}

export function dedupeGroupAccess(groups: BusinessGroupPerformanceAccess[]) {
  const byOrganization = new Map<
    string,
    {
      entity: AccessibleGroupEntity;
      groupIds: string[];
      groupNames: string[];
    }
  >();

  for (const group of groups) {
    for (const entity of group.access.entities) {
      const existing = byOrganization.get(entity.organizationId);
      if (existing) {
        existing.groupIds.push(group.groupId);
        existing.groupNames.push(group.groupName);
      } else {
        byOrganization.set(entity.organizationId, {
          entity,
          groupIds: [group.groupId],
          groupNames: [group.groupName],
        });
      }
    }
  }

  return [...byOrganization.values()];
}

/**
 * First reporting vertical slice. It uses each organization's existing RLS
 * context and report engine. A projected read model can replace this function's
 * source without changing its public result shape.
 */
export async function computeGroupPerformance(
  access: GroupEntityAccessView,
  input: {
    userId: string;
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
  },
): Promise<GroupPerformanceResult> {
  const entities = await mapWithConcurrency(access.entities, 6, (entity) =>
    computeEntityPerformance(entity, input.userId, input.dateFrom, input.dateTo, input.compare),
  );
  entities.sort(
    (a, b) => compareMoneyAmounts(b.netIncome, a.netIncome) || a.name.localeCompare(b.name),
  );
  const { aggregate, aggregateCurrency } = aggregateMetrics(entities);
  const warnings = accessWarnings(access, aggregate !== null);

  return {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    compare: input.compare,
    sourceMode: "live_ledger",
    generatedAt: new Date().toISOString(),
    projectionAsOf: null,
    projectionLagSeconds: null,
    projectionStatus: "not_applicable",
    incompleteEntityCount: 0,
    entities,
    aggregate,
    aggregateCurrency,
    totalEntityCount: access.totalEntityCount,
    omittedEntityCount: access.omittedEntityCount,
    warnings,
  };
}

/**
 * Aggregate several Business Groups while calculating every organization only
 * once. Cross-group assignment is prevented for new writes, but this defensive
 * deduplication protects reports while legacy data is being cleaned up.
 */
export async function computeBusinessGroupsPerformance(
  groups: BusinessGroupPerformanceAccess[],
  input: {
    userId: string;
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    page?: number;
    pageSize?: number;
  },
): Promise<BusinessGroupsPerformanceResult> {
  const deduplicated = dedupeGroupAccess(groups);
  const computed = await mapWithConcurrency(deduplicated, 6, (membership) =>
    computeEntityPerformance(
      membership.entity,
      input.userId,
      input.dateFrom,
      input.dateTo,
      input.compare,
    ),
  );
  const metricByOrganization = new Map(computed.map((metric) => [metric.organizationId, metric]));
  const allEntities: PortfolioEntityPerformanceMetric[] = deduplicated.map((membership) => ({
    ...metricByOrganization.get(membership.entity.organizationId)!,
    groupIds: membership.groupIds,
    groupNames: membership.groupNames,
  }));
  allEntities.sort(
    (a, b) => compareMoneyAmounts(b.netIncome, a.netIncome) || a.name.localeCompare(b.name),
  );

  const groupResults = groups.map((group): BusinessGroupPerformanceSlice => {
    const groupEntities = group.access.entities
      .map((entity) => ({
        ...metricByOrganization.get(entity.organizationId)!,
        entityId: entity.id,
      }))
      .sort(
        (a, b) => compareMoneyAmounts(b.netIncome, a.netIncome) || a.name.localeCompare(b.name),
      );
    const { aggregate, aggregateCurrency } = aggregateMetrics(groupEntities);
    return {
      groupId: group.groupId,
      groupName: group.groupName,
      accessibleEntityCount: groupEntities.length,
      aggregate,
      aggregateCurrency,
      totalEntityCount: group.access.totalEntityCount,
      omittedEntityCount: group.access.omittedEntityCount,
      warnings: accessWarnings(group.access, aggregate !== null),
    };
  });

  const { aggregate, aggregateCurrency } = aggregateMetrics(allEntities);
  const accessibleMembershipCount = groups.reduce(
    (total, group) => total + group.access.entities.length,
    0,
  );
  const duplicateMembershipCount = accessibleMembershipCount - allEntities.length;
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
  if (allEntities.length > 1 && aggregate === null) {
    warnings.push(
      "Combined totals are unavailable because the selected businesses use different functional currencies.",
    );
  }

  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, Math.min(25, input.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const entities = allEntities.slice(offset, offset + pageSize);

  return attachUnpaginatedPerformanceEntities(
    {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      compare: input.compare,
      sourceMode: "live_ledger",
      generatedAt: new Date().toISOString(),
      projectionAsOf: null,
      projectionLagSeconds: null,
      projectionSyncAgeSeconds: null,
      projectionStatus: "not_applicable",
      incompleteEntityCount: 0,
      entityReadiness: [],
      entityReadinessSummary: null,
      selectedGroupCount: groups.length,
      entities,
      page,
      pageSize,
      uniqueEntityCount: allEntities.length,
      groups: groupResults,
      aggregate,
      aggregateCurrency,
      totalEntityCount: groups.reduce((total, group) => total + group.access.totalEntityCount, 0),
      omittedEntityCount,
      duplicateMembershipCount,
      warnings,
    },
    allEntities,
  );
}
