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
 * and, when needed, one organization-membership lookup.
 */
export function resolveSessionOrganization(input: {
  activeOrganizationId: string | null;
  activeMemberRole: string | null;
  membership: MembershipEvidence;
}): SessionOrganizationResolution {
  const { activeOrganizationId, activeMemberRole, membership } = input;

  if (activeOrganizationId) {
    if (activeMemberRole) {
      return {
        kind: "resolved",
        orgId: activeOrganizationId,
        role: activeMemberRole,
        activateOrganization: false,
      };
    }

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
