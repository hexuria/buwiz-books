import { describe, expect, it } from "vitest";
import { resolveSessionOrganization } from "../../../src/lib/session-organization-policy";

describe("resolveSessionOrganization", () => {
  it("uses a complete active-session organization without loading membership", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: "org-a",
        activeMemberRole: "admin",
        membership: { state: "not_loaded" },
      }),
    ).toEqual({
      kind: "resolved",
      orgId: "org-a",
      role: "admin",
      activateOrganization: false,
    });
  });

  it("requests only the active organization's membership when its role is absent", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: "org-b",
        activeMemberRole: null,
        membership: { state: "not_loaded" },
      }),
    ).toEqual({ kind: "lookup_active_membership", orgId: "org-b" });
  });

  it("takes the role from the matching active-organization membership", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: "org-b",
        activeMemberRole: null,
        membership: {
          state: "loaded",
          membership: { organizationId: "org-b", role: "member" },
        },
      }),
    ).toEqual({
      kind: "resolved",
      orgId: "org-b",
      role: "member",
      activateOrganization: false,
    });
  });

  it.each([
    ["missing", null],
    ["different organization", { organizationId: "org-a", role: "admin" }],
    ["empty role", { organizationId: "org-b", role: "" }],
  ])("fails closed for a %s active-organization membership", (_case, membership) => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: "org-b",
        activeMemberRole: null,
        membership: { state: "loaded", membership },
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("requests the oldest membership when no organization is active", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: null,
        activeMemberRole: null,
        membership: { state: "not_loaded" },
      }),
    ).toEqual({ kind: "lookup_oldest_membership" });
  });

  it("keeps the selected membership's organization and role paired and requests activation", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: null,
        activeMemberRole: "admin",
        membership: {
          state: "loaded",
          membership: { organizationId: "org-oldest", role: "member" },
        },
      }),
    ).toEqual({
      kind: "resolved",
      orgId: "org-oldest",
      role: "member",
      activateOrganization: true,
    });
  });

  it("reports no organization when the user has no memberships", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: null,
        activeMemberRole: null,
        membership: { state: "loaded", membership: null },
      }),
    ).toEqual({ kind: "no_organization" });
  });

  it("fails closed when the oldest membership has an empty organization or role", () => {
    for (const membership of [
      { organizationId: "", role: "owner" },
      { organizationId: "org-oldest", role: "" },
    ]) {
      expect(
        resolveSessionOrganization({
          activeOrganizationId: null,
          activeMemberRole: "admin",
          membership: { state: "loaded", membership },
        }),
      ).toEqual({ kind: "forbidden" });
    }
  });
});
