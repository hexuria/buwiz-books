import { describe, expect, it } from "vitest";
import {
  attachUnpaginatedPerformanceEntities,
  type BusinessGroupsPerformanceResult,
  type PortfolioEntityPerformanceMetric,
} from "../../src/lib/business-groups/performance-model";
import { findProjectionMismatches } from "../../src/lib/business-groups/projection-reconciliation-policy";
import type { ProjectionStateView } from "../../src/lib/reporting/projection-types";

function entity(
  organizationId: string,
  overrides: Partial<PortfolioEntityPerformanceMetric> = {},
): PortfolioEntityPerformanceMetric {
  return {
    entityId: `entity-${organizationId}`,
    organizationId,
    name: organizationId,
    currency: "USD",
    revenue: "100.00",
    priorRevenue: "80.00",
    revenueChangePct: 25,
    grossProfit: "70.00",
    grossMargin: 70,
    operatingExpenses: "20.00",
    operatingIncome: "50.00",
    operatingMargin: 50,
    netIncome: "50.00",
    priorNetIncome: "40.00",
    netMargin: 50,
    cash: "125.00",
    profitable: true,
    groupIds: ["group-a"],
    groupNames: ["Operating Companies"],
    ...overrides,
  };
}

function report(
  sourceMode: "live_ledger" | "shadow",
  visibleEntities: PortfolioEntityPerformanceMetric[],
  allEntities = visibleEntities,
): BusinessGroupsPerformanceResult {
  return attachUnpaginatedPerformanceEntities(
    {
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      compare: "prior_period",
      sourceMode,
      generatedAt: "2026-07-01T00:00:00.000Z",
      projectionAsOf: sourceMode === "shadow" ? "2026-07-01T00:00:00.000Z" : null,
      projectionLagSeconds: sourceMode === "shadow" ? 0 : null,
      projectionSyncAgeSeconds: null,
      projectionStatus: sourceMode === "shadow" ? "ready" : "not_applicable",
      incompleteEntityCount: 0,
      entityReadiness: [],
      entityReadinessSummary: null,
      selectedGroupCount: 1,
      entities: visibleEntities,
      page: 1,
      pageSize: 1,
      uniqueEntityCount: allEntities.length,
      groups: [],
      aggregate: null,
      aggregateCurrency: "USD",
      totalEntityCount: allEntities.length,
      omittedEntityCount: 0,
      duplicateMembershipCount: 0,
      warnings: [],
    },
    allEntities,
  );
}

function projectionStates(...organizationIds: string[]) {
  return new Map<string, ProjectionStateView>(
    organizationIds.map((organizationId) => [
      organizationId,
      {
        organizationId,
        status: "ready",
        requestedVersion: 7,
        appliedVersion: 7,
        lastLedgerEventAt: null,
        lastProjectedAt: new Date("2026-07-01T00:00:00.000Z"),
        initialBackfillCompletedAt: new Date("2026-07-01T00:00:00.000Z"),
        lastError: null,
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]),
  );
}

describe("Business Group projection reconciliation", () => {
  it("ignores rounding noise inside the configured tolerance", () => {
    const live = report("live_ledger", [entity("org-a")]);
    const projected = report("shadow", [entity("org-a", { grossMargin: 70.004 })]);

    expect(
      findProjectionMismatches(live, projected, {
        tolerance: 0.01,
        projectionVersions: projectionStates("org-a"),
      }),
    ).toEqual([]);
  });

  it("records metric, nullability, and entity-presence differences", () => {
    const live = report("live_ledger", [entity("org-a", { priorRevenue: null }), entity("org-b")]);
    const projected = report("shadow", [
      entity("org-a", { revenue: "99.00", priorRevenue: "80.00" }),
      entity("org-c"),
    ]);

    const mismatches = findProjectionMismatches(live, projected, {
      tolerance: 0.01,
      projectionVersions: projectionStates("org-a", "org-b", "org-c"),
    });

    expect(mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: "org-a", metric: "revenue" }),
        expect.objectContaining({ organizationId: "org-a", metric: "priorRevenue" }),
        expect.objectContaining({ organizationId: "org-b", metric: "entityPresence" }),
        expect.objectContaining({ organizationId: "org-c", metric: "entityPresence" }),
      ]),
    );
    expect(mismatches.every((mismatch) => mismatch.projectionVersion === 7)).toBe(true);
  });

  it("compares the full server-side result even when the current page is empty", () => {
    const liveAll = [entity("org-a"), entity("org-b")];
    const projectedAll = [entity("org-a"), entity("org-b", { cash: "130.00" })];
    const live = report("live_ledger", [], liveAll);
    const projected = report("shadow", [], projectedAll);

    expect(
      findProjectionMismatches(live, projected, {
        tolerance: 0.01,
        projectionVersions: projectionStates("org-a", "org-b"),
      }),
    ).toEqual([
      expect.objectContaining({
        organizationId: "org-b",
        metric: "cash",
        projectedValue: "130.00",
      }),
    ]);
  });
});
