import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionOrganization } from "../../../src/lib/session-organization-policy";

/**
 * The audit's session-revocation high, pinned at the policy layer.
 *
 * The old resolver short-circuited on the cookie-cached member-role claim:
 * with better-auth's 24h cookieCache, a member removed from the organization
 * kept full access — and a demoted admin their admin role — for up to a day,
 * because no server code ever looked past the cookie. (This file's first test
 * used to pin exactly that behavior as correct.) The claim is now structurally
 * untrusted: it is not even an input to the resolver, so every request with an
 * active organization MUST go through the auth_members lookup, and revocation
 * bites on the very next request.
 */
describe("resolveSessionOrganization", () => {
  it("an active organization ALWAYS demands the membership lookup — no cookie claim skips it", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: "org-b",
        membership: { state: "not_loaded" },
      }),
    ).toEqual({ kind: "lookup_active_membership", orgId: "org-b" });
  });

  it("takes the role from the matching active-organization membership", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: "org-b",
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
        membership: { state: "loaded", membership },
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("requests the oldest membership when no organization is active", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: null,
        membership: { state: "not_loaded" },
      }),
    ).toEqual({ kind: "lookup_oldest_membership" });
  });

  it("keeps the selected membership's organization and role paired and requests activation", () => {
    expect(
      resolveSessionOrganization({
        activeOrganizationId: null,
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
          membership: { state: "loaded", membership },
        }),
      ).toEqual({ kind: "forbidden" });
    }
  });
});

describe("session revocation wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../../..", rel), "utf-8");

  it("the resolver never references the cookie role claim again", () => {
    const policy = read("src/lib/session-organization-policy.ts");
    expect(policy).not.toContain("activeMemberRole");
  });

  it("the middleware feeds the resolver session org id and membership evidence only", () => {
    const middleware = read("src/lib/auth-middleware.ts");
    const calls = middleware.match(/resolveSessionOrganization\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).not.toContain("activeMemberRole");
    }
  });

  it("member removal and role change both revoke the target's sessions", () => {
    const orgSettings = read("src/routes/api/-org-settings.ts");
    expect(orgSettings).toContain(
      'import { revokeUserSessionsAsAdmin } from "../../lib/session-revocation"',
    );
    const revocations =
      orgSettings.match(/await revokeUserSessionsAsAdmin\(existing\.userId\)/g) ?? [];
    expect(revocations.length).toBe(2);
  });
});
