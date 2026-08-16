import { describe, expect, it, vi } from "vitest";
import {
  businessGroupsReturnSearch,
  establishOrganizationProfitLossDrilldown,
  organizationProfitLossPath,
  portfolioProfitLossSearch,
  type BusinessGroupDrilldownScope,
} from "../../src/lib/business-groups/drilldown";

const scope: BusinessGroupDrilldownScope = {
  accountId: "account-1",
  groupIds: ["group-a", "group-b", "group-a"],
  dateFrom: "2026-07-01",
  dateTo: "2026-07-31",
  compare: "prior_period",
};

describe("Business Group financial drill-down", () => {
  it("preserves the authorized portfolio selector state and resets the return page", () => {
    expect(portfolioProfitLossSearch(scope)).toEqual({
      tab: "profit-loss",
      scope: "portfolio",
      accountId: "account-1",
      groupIds: "group-a,group-b",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      compare: "prior_period",
      fromBusinessGroups: true,
    });
    expect(businessGroupsReturnSearch(scope)).toEqual({
      accountId: "account-1",
      groupIds: "group-a,group-b",
      groupId: undefined,
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      compare: "prior_period",
      page: 1,
    });
  });

  it("never puts the target organization ID in the Financials URL", () => {
    const path = organizationProfitLossPath(scope);

    expect(path).toContain("scope=organization");
    expect(path).toContain("accountId=account-1");
    expect(path).toContain("groupIds=group-a%2Cgroup-b");
    expect(path).not.toContain("organizationId");
    expect(path).not.toContain("target-org-secret");
  });

  it("establishes the authenticated organization context before clearing and navigating", async () => {
    const calls: string[] = [];
    const setActiveOrganization = vi.fn(async (organizationId: string) => {
      calls.push(`active:${organizationId}`);
      return {};
    });
    const clearCachedQueries = vi.fn(() => calls.push("clear"));
    const assignLocation = vi.fn((path: string) => calls.push(`assign:${path}`));

    await establishOrganizationProfitLossDrilldown({
      organizationId: "target-org-secret",
      scope,
      setActiveOrganization,
      clearCachedQueries,
      assignLocation,
    });

    expect(calls[0]).toBe("active:target-org-secret");
    expect(calls[1]).toBe("clear");
    expect(calls[2]).toContain("assign:/financials?");
    expect(calls[2]).not.toContain("target-org-secret");
  });

  it("does not clear or navigate when the organization switch is rejected", async () => {
    const clearCachedQueries = vi.fn();
    const assignLocation = vi.fn();

    await expect(
      establishOrganizationProfitLossDrilldown({
        organizationId: "unauthorized-org",
        scope,
        setActiveOrganization: async () => ({ error: { status: 403 } }),
        clearCachedQueries,
        assignLocation,
      }),
    ).rejects.toThrow("active business could not be changed");
    expect(clearCachedQueries).not.toHaveBeenCalled();
    expect(assignLocation).not.toHaveBeenCalled();
  });
});
