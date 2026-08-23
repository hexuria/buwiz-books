export interface SessionMembership {
  organizationId: string;
  role: string;
}

export type MembershipEvidence =
  | { state: "not_loaded" }
  | { state: "loaded"; membership: SessionMembership | null };

export type SessionOrganizationResolution =
  | { kind: "resolved"; orgId: string; role: string; activateOrganization: boolean }
  | { kind: "lookup_active_membership"; orgId: string }
  | { kind: "lookup_oldest_membership" }
  | { kind: "forbidden" }
  | { kind: "no_organization" };

/**
 * Resolve one internally consistent organization/role pair from session state
 * plus one organization-membership lookup.
 *
 * The session cookie's cached role claim is deliberately NOT an input. With
 * better-auth's 24h cookieCache, trusting the cookie's member-role field meant a removed
 * member kept full access — and a demoted one their old role — for up to a
 * day after the auth_members row changed, because nothing on the server ever
 * looked past the cookie. Authorization is always re-resolved from the
 * membership row (one indexed read per request); the cookie cache keeps
 * serving identity, never authorization.
 */
export function resolveSessionOrganization(input: {
  activeOrganizationId: string | null;
  membership: MembershipEvidence;
}): SessionOrganizationResolution {
  const { activeOrganizationId, membership } = input;

  if (activeOrganizationId) {
    if (membership.state === "not_loaded") {
      return { kind: "lookup_active_membership", orgId: activeOrganizationId };
    }

    const loaded = membership.membership;
    if (
      !loaded ||
      loaded.organizationId !== activeOrganizationId ||
      !loaded.organizationId ||
      !loaded.role
    ) {
      return { kind: "forbidden" };
    }

    return {
      kind: "resolved",
      orgId: loaded.organizationId,
      role: loaded.role,
      activateOrganization: false,
    };
  }

  if (membership.state === "not_loaded") {
    return { kind: "lookup_oldest_membership" };
  }

  const loaded = membership.membership;
  if (!loaded) return { kind: "no_organization" };
  if (!loaded.organizationId || !loaded.role) return { kind: "forbidden" };

  return {
    kind: "resolved",
    orgId: loaded.organizationId,
    role: loaded.role,
    activateOrganization: true,
  };
}
