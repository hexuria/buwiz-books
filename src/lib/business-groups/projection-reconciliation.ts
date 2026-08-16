import type { DbExecutor } from "@/db";
import { businessGroupProjectionReconciliationEvents } from "@/db/schema/reporting-projections";
import { createLogger } from "@/lib/logger";
import { centsToMoney, moneyToCents } from "@/lib/money";
import type { ProjectionStateView } from "@/lib/reporting/projection";
import type { BusinessGroupsPerformanceResult } from "./performance";
import {
  getUnpaginatedPerformanceEntities,
  PERFORMANCE_MONEY_METRICS,
  PERFORMANCE_PERCENT_METRICS,
} from "./performance";

const logger = createLogger("business-groups.projection-reconciliation");

type ComparableMetric =
  | (typeof PERFORMANCE_MONEY_METRICS)[number]
  | (typeof PERFORMANCE_PERCENT_METRICS)[number]
  | "entityPresence";

export interface ProjectionMismatch {
  organizationId: string;
  metric: ComparableMetric;
  liveValue: string | null;
  projectedValue: string | null;
  absoluteDifference: string | null;
  tolerance: number;
  projectionVersion: number;
}

export function findProjectionMismatches(
  live: BusinessGroupsPerformanceResult,
  projected: BusinessGroupsPerformanceResult,
  options: {
    tolerance: number;
    projectionVersions: ReadonlyMap<string, ProjectionStateView>;
  },
): ProjectionMismatch[] {
  if (projected.projectionStatus !== "ready") return [];

  const tolerance = Number.isFinite(options.tolerance) ? Math.max(0, options.tolerance) : 0.01;
  const liveEntities = getUnpaginatedPerformanceEntities(live);
  const projectedEntities = getUnpaginatedPerformanceEntities(projected);
  const projectedByOrganization = new Map(
    projectedEntities.map((entity) => [entity.organizationId, entity] as const),
  );
  const liveOrganizationIds = new Set(liveEntities.map((entity) => entity.organizationId));
  const mismatches: ProjectionMismatch[] = [];

  for (const liveEntity of liveEntities) {
    const projectionVersion =
      options.projectionVersions.get(liveEntity.organizationId)?.appliedVersion ?? 0;
    const projectedEntity = projectedByOrganization.get(liveEntity.organizationId);
    if (!projectedEntity) {
      mismatches.push({
        organizationId: liveEntity.organizationId,
        metric: "entityPresence",
        liveValue: "1",
        projectedValue: "0",
        absoluteDifference: "1",
        tolerance,
        projectionVersion,
      });
      continue;
    }

    const moneyToleranceCents = moneyToCents(tolerance.toString(), "reconciliation tolerance");
    for (const metric of PERFORMANCE_MONEY_METRICS) {
      const liveValue = liveEntity[metric] as string | null;
      const projectedValue = projectedEntity[metric] as string | null;
      if (liveValue === null || projectedValue === null) {
        if (liveValue === projectedValue) continue;
        mismatches.push({
          organizationId: liveEntity.organizationId,
          metric,
          liveValue,
          projectedValue,
          absoluteDifference: null,
          tolerance,
          projectionVersion,
        });
        continue;
      }
      const differenceCents = Math.abs(moneyToCents(liveValue) - moneyToCents(projectedValue));
      if (differenceCents <= moneyToleranceCents) continue;
      mismatches.push({
        organizationId: liveEntity.organizationId,
        metric,
        liveValue,
        projectedValue,
        absoluteDifference: centsToMoney(differenceCents),
        tolerance,
        projectionVersion,
      });
    }

    const toleranceBasisPoints = Math.round(tolerance * 100);
    for (const metric of PERFORMANCE_PERCENT_METRICS) {
      const liveValue = liveEntity[metric] as number | null;
      const projectedValue = projectedEntity[metric] as number | null;
      if (liveValue === null || projectedValue === null) {
        if (liveValue === projectedValue) continue;
        mismatches.push({
          organizationId: liveEntity.organizationId,
          metric,
          liveValue: liveValue?.toString() ?? null,
          projectedValue: projectedValue?.toString() ?? null,
          absoluteDifference: null,
          tolerance,
          projectionVersion,
        });
        continue;
      }
      const differenceBasisPoints = Math.abs(
        Math.round(liveValue * 100) - Math.round(projectedValue * 100),
      );
      if (differenceBasisPoints <= toleranceBasisPoints) continue;
      mismatches.push({
        organizationId: liveEntity.organizationId,
        metric,
        liveValue: liveValue.toString(),
        projectedValue: projectedValue.toString(),
        absoluteDifference: (differenceBasisPoints / 100).toFixed(2),
        tolerance,
        projectionVersion,
      });
    }
  }

  for (const projectedEntity of projectedEntities) {
    if (liveOrganizationIds.has(projectedEntity.organizationId)) continue;
    mismatches.push({
      organizationId: projectedEntity.organizationId,
      metric: "entityPresence",
      liveValue: "0",
      projectedValue: "1",
      absoluteDifference: "1",
      tolerance,
      projectionVersion:
        options.projectionVersions.get(projectedEntity.organizationId)?.appliedVersion ?? 0,
    });
  }

  return mismatches;
}

/**
 * Shadow telemetry must never make a customer report fail. The durable rows
 * remain organization-scoped under RLS; the structured log contains counts
 * and versions only, not financial values.
 */
export async function recordProjectionMismatches(
  tx: DbExecutor,
  mismatches: readonly ProjectionMismatch[],
  context: {
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    selectedGroupIds: readonly string[];
    projectionAsOf: string | null;
  },
): Promise<boolean> {
  if (mismatches.length === 0) return true;
  const selectedGroupIds = [...new Set(context.selectedGroupIds)];
  const projectionAsOf = context.projectionAsOf ? new Date(context.projectionAsOf) : null;

  try {
    for (let offset = 0; offset < mismatches.length; offset += 250) {
      await tx.insert(businessGroupProjectionReconciliationEvents).values(
        mismatches.slice(offset, offset + 250).map((mismatch) => ({
          organizationId: mismatch.organizationId,
          dateFrom: context.dateFrom,
          dateTo: context.dateTo,
          compareMode: context.compare,
          metric: mismatch.metric,
          liveValue: mismatch.liveValue,
          projectedValue: mismatch.projectedValue,
          absoluteDifference: mismatch.absoluteDifference,
          tolerance: mismatch.tolerance.toString(),
          projectionVersion: mismatch.projectionVersion,
          projectionAsOf,
          selectedGroupIds,
        })),
      );
    }
    logger.warn("Projection shadow comparison found mismatches", {
      mismatchCount: mismatches.length,
      organizationCount: new Set(mismatches.map((mismatch) => mismatch.organizationId)).size,
      dateFrom: context.dateFrom,
      dateTo: context.dateTo,
      projectionVersions: [...new Set(mismatches.map((mismatch) => mismatch.projectionVersion))],
    });
    return true;
  } catch (error) {
    logger.error("Could not persist projection shadow mismatches", {
      error,
      mismatchCount: mismatches.length,
      dateFrom: context.dateFrom,
      dateTo: context.dateTo,
    });
    return false;
  }
}
