import { withOrgContext } from "../../db";
import { getPriorPeriodRange } from "../../lib/report-utils";
import { aggregateBalances } from "../../services/reports";
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
  type EntityPerformanceMetric,
  type GroupPerformanceResult,
  type PortfolioEntityPerformanceMetric,
} from "./performance-model";
import type { AccessibleGroupEntity, GroupEntityAccessView } from "./types";

export * from "./performance-model";

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
