import type { DbExecutor } from "@/db";
import { businessGroupProjectionReconciliationEvents } from "@/db/schema/reporting-projections";
import { createLogger } from "@/lib/logger";
import type { ProjectionMismatch } from "./projection-reconciliation-policy";

export * from "./projection-reconciliation-policy";

const logger = createLogger("business-groups.projection-reconciliation");

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
