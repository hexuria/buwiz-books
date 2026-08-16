import { describe, expect, it } from "vitest";
import {
  buildProjectedEntityReadiness,
  paginateEntityReadiness,
  projectionReadinessWarning,
} from "../../src/lib/business-groups/entity-readiness";
import type { EntityReadiness } from "../../src/lib/business-groups/performance";
import type { ProjectionStateView } from "../../src/lib/reporting/projection";

const now = new Date("2026-08-01T12:00:00.000Z");

function entity(organizationId: string, name: string) {
  return {
    id: `entity-${organizationId}`,
    organizationId,
    name,
    role: "owner",
    currency: "USD",
  };
}

function state(
  organizationId: string,
  overrides: Partial<ProjectionStateView>,
): ProjectionStateView {
  return {
    organizationId,
    status: "building",
    requestedVersion: 2,
    appliedVersion: 1,
    lastLedgerEventAt: new Date("2026-08-01T11:59:00.000Z"),
    lastProjectedAt: new Date("2026-08-01T11:55:00.000Z"),
    initialBackfillCompletedAt: new Date("2026-07-01T00:00:00.000Z"),
    lastError: null,
    updatedAt: new Date("2026-08-01T11:59:00.000Z"),
    ...overrides,
  };
}

describe("projected entity readiness", () => {
  it("normalizes each internal state without exposing worker details", () => {
    const businesses = [
      entity("missing", "Bayshore Retail"),
      entity("pending", "Cedar Logistics"),
      entity("building", "Fieldstone Foods"),
      entity("stale", "Juniper Industrial"),
      entity("ready", "Northline Services"),
      entity("failed", "Pinecrest Manufacturing"),
    ];
    const memberships = businesses.map((business) => ({
      entity: business,
      groupIds: ["group-a"],
      groupNames: ["Operating Companies"],
    }));
    const states = new Map<string, ProjectionStateView>([
      ["pending", state("pending", { status: "pending" })],
      ["building", state("building", { status: "building" })],
      [
        "stale",
        state("stale", {
          status: "building",
          updatedAt: new Date("2026-08-01T11:54:59.000Z"),
        }),
      ],
      [
        "ready",
        state("ready", {
          status: "ready",
          requestedVersion: 2,
          appliedVersion: 2,
          lastLedgerEventAt: new Date("2026-08-01T11:59:59.000Z"),
        }),
      ],
      ["failed", state("failed", { status: "failed", lastError: "private stack trace" })],
    ]);

    const readiness = buildProjectedEntityReadiness(memberships, states, now);

    expect(
      readiness.map((entry) => [
        entry.organizationId,
        entry.status,
        entry.syncAgeSeconds,
        entry.ledgerLagSeconds,
      ]),
    ).toEqual([
      ["missing", "missing", null, null],
      ["pending", "pending", 60, 240],
      ["building", "building", 60, 240],
      ["stale", "stale", 301, 240],
      ["ready", "ready", null, 299],
      ["failed", "failed", 60, 240],
    ]);
    expect(Object.keys(readiness.at(-1)!).sort()).toEqual(
      [
        "groupIds",
        "groupNames",
        "ledgerLagSeconds",
        "name",
        "organizationId",
        "projectionAsOf",
        "status",
        "syncActivityAt",
        "syncAgeSeconds",
      ].sort(),
    );
    expect(JSON.stringify(readiness)).not.toContain("private stack trace");
    expect(JSON.stringify(readiness)).not.toContain("requestedVersion");
  });

  it("cannot include projection states outside the authorized memberships", () => {
    const memberships = [
      {
        entity: entity("authorized", "Juniper Industrial"),
        groupIds: ["group-a"],
        groupNames: ["Operating Companies"],
      },
    ];
    const states = new Map<string, ProjectionStateView>([
      ["authorized", state("authorized", {})],
      ["inaccessible", state("inaccessible", { status: "failed" })],
    ]);

    expect(
      buildProjectedEntityReadiness(memberships, states, now).map((entry) => entry.name),
    ).toEqual(["Juniper Industrial"]);
  });

  it("ages pending work from request activity instead of old or missing ledger activity", () => {
    const memberships = [
      {
        entity: entity("idle-refresh", "Northline Services"),
        groupIds: ["group-a"],
        groupNames: ["Operating Companies"],
      },
      {
        entity: entity("initial-backfill", "Bayshore Retail"),
        groupIds: ["group-a"],
        groupNames: ["Operating Companies"],
      },
    ];
    const states = new Map<string, ProjectionStateView>([
      [
        "idle-refresh",
        state("idle-refresh", {
          status: "pending",
          lastLedgerEventAt: new Date("2026-06-01T00:00:00.000Z"),
          lastProjectedAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-08-01T11:59:55.000Z"),
        }),
      ],
      [
        "initial-backfill",
        state("initial-backfill", {
          status: "pending",
          lastLedgerEventAt: null,
          lastProjectedAt: null,
          initialBackfillCompletedAt: null,
          updatedAt: new Date("2026-08-01T11:59:55.000Z"),
        }),
      ],
    ]);

    expect(buildProjectedEntityReadiness(memberships, states, now)).toMatchObject([
      { status: "pending", syncAgeSeconds: 5, ledgerLagSeconds: 0 },
      { status: "pending", syncAgeSeconds: 5, ledgerLagSeconds: null },
    ]);
  });

  it("caps serialized readiness pages at 25 while retaining portfolio status counts", () => {
    const readiness = Array.from(
      { length: 60 },
      (_, index): EntityReadiness => ({
        organizationId: `organization-${index}`,
        name: `Business ${String(index).padStart(2, "0")}`,
        groupIds: ["group-a"],
        groupNames: ["Operating Companies"],
        status: index < 4 ? "failed" : index < 10 ? "stale" : "ready",
        projectionAsOf: null,
        syncActivityAt: null,
        syncAgeSeconds: null,
        ledgerLagSeconds: null,
      }),
    );

    const firstPage = paginateEntityReadiness(readiness, { page: 1, pageSize: 100 });
    const thirdPage = paginateEntityReadiness(readiness, { page: 3, pageSize: 100 });

    expect(firstPage.entityReadiness).toHaveLength(25);
    expect(firstPage.entityReadinessSummary).toMatchObject({
      total: 60,
      page: 1,
      pageSize: 25,
      returnedCount: 25,
      statusCounts: { failed: 4, stale: 6, ready: 50 },
    });
    expect(thirdPage.entityReadiness).toHaveLength(10);
    expect(thirdPage.entityReadinessSummary.returnedCount).toBe(10);
  });

  it("uses source-aware availability copy", () => {
    expect(projectionReadinessWarning("shadow", "failed")).toContain(
      "live-ledger totals remain available",
    );
    expect(projectionReadinessWarning("projected", "failed")).toContain("Totals remain withheld");
  });
});
