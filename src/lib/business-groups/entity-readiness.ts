import type { ProjectionStateView } from "../reporting/projection";
import type { EntityReadiness, EntityReadinessStatus, EntityReadinessSummary } from "./performance";

const PROJECTION_STALE_AFTER_SECONDS = 300;
export const MAX_ENTITY_READINESS_PAGE_SIZE = 25;

const statusPriority: Record<EntityReadinessStatus, number> = {
  failed: 0,
  stale: 1,
  missing: 2,
  pending: 3,
  building: 4,
  ready: 5,
};

interface AuthorizedEntityReadinessMembership {
  entity: {
    organizationId: string;
    name: string;
  };
  groupIds: string[];
  groupNames: string[];
}

function projectionIsReady(state: ProjectionStateView | undefined): boolean {
  return Boolean(
    state &&
    state.status === "ready" &&
    state.appliedVersion >= state.requestedVersion &&
    state.initialBackfillCompletedAt,
  );
}

/**
 * Convert internal worker state into the safe per-business contract. The
 * memberships passed here must already be authorized and deduplicated.
 */
export function buildProjectedEntityReadiness(
  memberships: readonly AuthorizedEntityReadinessMembership[],
  states: ReadonlyMap<string, ProjectionStateView>,
  now: Date = new Date(),
): EntityReadiness[] {
  return memberships.map((membership) => {
    const state = states.get(membership.entity.organizationId);
    const ready = projectionIsReady(state);
    const syncAgeSeconds =
      state && !ready
        ? Math.max(0, Math.floor((now.getTime() - state.updatedAt.getTime()) / 1000))
        : null;
    const ledgerLagSeconds =
      state?.lastLedgerEventAt && state.lastProjectedAt
        ? Math.max(
            0,
            Math.floor(
              (state.lastLedgerEventAt.getTime() - state.lastProjectedAt.getTime()) / 1000,
            ),
          )
        : null;
    const status = (() => {
      if (!state || state.status === "missing") return "missing" as const;
      if (ready) return "ready" as const;
      if (state.status === "failed") return "failed" as const;
      if (syncAgeSeconds !== null && syncAgeSeconds > PROJECTION_STALE_AFTER_SECONDS) {
        return "stale" as const;
      }
      if (state.status === "pending") return "pending" as const;
      return "building" as const;
    })();

    return {
      organizationId: membership.entity.organizationId,
      name: membership.entity.name,
      groupIds: membership.groupIds,
      groupNames: membership.groupNames,
      status,
      projectionAsOf: state?.lastProjectedAt?.toISOString() ?? null,
      syncActivityAt: state?.updatedAt.toISOString() ?? null,
      syncAgeSeconds,
      ledgerLagSeconds,
    };
  });
}

export function paginateEntityReadiness(
  readiness: readonly EntityReadiness[],
  input: { page: number; pageSize: number; prioritizeActionable?: boolean },
): { entityReadiness: EntityReadiness[]; entityReadinessSummary: EntityReadinessSummary } {
  const page = Math.max(1, Math.floor(input.page));
  const pageSize = Math.max(
    1,
    Math.min(MAX_ENTITY_READINESS_PAGE_SIZE, Math.floor(input.pageSize)),
  );
  const statusCounts: Record<EntityReadinessStatus, number> = {
    missing: 0,
    pending: 0,
    building: 0,
    ready: 0,
    stale: 0,
    failed: 0,
  };
  for (const entry of readiness) statusCounts[entry.status] += 1;

  const ordered = [...readiness];
  if (input.prioritizeActionable !== false) {
    ordered.sort(
      (left, right) =>
        statusPriority[left.status] - statusPriority[right.status] ||
        left.name.localeCompare(right.name),
    );
  }
  const offset = (page - 1) * pageSize;
  const entityReadiness = ordered.slice(offset, offset + pageSize);
  return {
    entityReadiness,
    entityReadinessSummary: {
      total: readiness.length,
      page,
      pageSize,
      returnedCount: entityReadiness.length,
      statusCounts,
    },
  };
}

export function projectionReadinessWarning(
  sourceMode: "projected" | "shadow",
  status: "building" | "stale" | "failed",
): string {
  if (sourceMode === "shadow") {
    return status === "failed"
      ? "The projection check failed, but live-ledger totals remain available. Refresh the projection or contact support."
      : "The projection check is still being prepared, but live-ledger totals remain available.";
  }
  return status === "failed"
    ? "Projected financial data could not be refreshed. Totals remain withheld until every accessible business is current."
    : "Projected financial data is still being prepared. Totals are withheld until every accessible business is current.";
}
