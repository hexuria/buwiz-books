import { describe, expect, it } from "vitest";
import {
  defaultGraceEnd,
  entitlementAllowsOperation,
  resolveEntitlementState,
} from "../../src/lib/enterprise/entitlement-state";

const NOW = new Date("2026-07-31T00:00:00.000Z");

describe("Enterprise entitlement lifecycle", () => {
  it("keeps a current contract active", () => {
    const state = resolveEntitlementState(
      {
        status: "active",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-12-31T00:00:00.000Z"),
        graceEndsAt: new Date("2027-01-30T00:00:00.000Z"),
      },
      NOW,
    );

    expect(state.status).toBe("active");
    expect(state.isReadOnly).toBe(false);
    expect(entitlementAllowsOperation(state, "mutate")).toBe(true);
  });

  it("enters read-only grace immediately after the contract ends", () => {
    const state = resolveEntitlementState(
      {
        status: "active",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-07-30T00:00:00.000Z"),
        graceEndsAt: new Date("2026-08-29T00:00:00.000Z"),
      },
      NOW,
    );

    expect(state.status).toBe("grace");
    expect(state.isReadOnly).toBe(true);
    expect(entitlementAllowsOperation(state, "read")).toBe(true);
    expect(entitlementAllowsOperation(state, "export")).toBe(true);
    expect(entitlementAllowsOperation(state, "project")).toBe(true);
    expect(entitlementAllowsOperation(state, "mutate")).toBe(false);
  });

  it("locks without deleting data after grace expires", () => {
    const state = resolveEntitlementState(
      {
        status: "active",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-06-01T00:00:00.000Z"),
        graceEndsAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      NOW,
    );

    expect(state.status).toBe("locked");
    expect(state.isEntitled).toBe(false);
    expect(entitlementAllowsOperation(state, "read")).toBe(false);
  });

  it("defaults grace to exactly 30 days", () => {
    const end = new Date("2026-07-01T12:30:00.000Z");
    expect(defaultGraceEnd(end).toISOString()).toBe("2026-07-31T12:30:00.000Z");
  });

  it("keeps future contracts pending even if provisioned as active", () => {
    const state = resolveEntitlementState(
      {
        status: "active",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: null,
        graceEndsAt: null,
      },
      NOW,
    );
    expect(state.status).toBe("pending");
  });

  it("activates a pending contract at its start time without waiting for a scheduler", () => {
    const state = resolveEntitlementState(
      {
        status: "pending",
        startsAt: new Date("2026-07-01T00:00:00.000Z"),
        endsAt: new Date("2026-12-31T00:00:00.000Z"),
        graceEndsAt: new Date("2027-01-30T00:00:00.000Z"),
      },
      NOW,
    );
    expect(state.status).toBe("active");
    expect(entitlementAllowsOperation(state, "mutate")).toBe(true);
  });

  it("moves a started pending contract through grace and then locks it after grace", () => {
    const contract = {
      status: "pending" as const,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-07-30T00:00:00.000Z"),
      graceEndsAt: new Date("2026-08-29T00:00:00.000Z"),
    };

    const grace = resolveEntitlementState(contract, NOW);
    expect(grace.status).toBe("grace");
    expect(grace.isReadOnly).toBe(true);
    expect(entitlementAllowsOperation(grace, "read")).toBe(true);
    expect(entitlementAllowsOperation(grace, "mutate")).toBe(false);

    const locked = resolveEntitlementState(contract, new Date("2026-08-30T00:00:00.000Z"));
    expect(locked.status).toBe("locked");
    expect(locked.isEntitled).toBe(false);
    expect(entitlementAllowsOperation(locked, "read")).toBe(false);
  });

  it("keeps a cancelled future contract locked rather than pending", () => {
    const state = resolveEntitlementState(
      {
        status: "cancelled",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: null,
        graceEndsAt: null,
      },
      NOW,
    );
    expect(state.status).toBe("locked");
  });
});
