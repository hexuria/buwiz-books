import { centsToMoney, moneyToCents } from "@/lib/money";
import type { ProjectionStateView } from "@/lib/reporting/projection-types";
import type { BusinessGroupsPerformanceResult } from "./performance-model";
import {
  getUnpaginatedPerformanceEntities,
  PERFORMANCE_MONEY_METRICS,
  PERFORMANCE_PERCENT_METRICS,
} from "./performance-model";

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
