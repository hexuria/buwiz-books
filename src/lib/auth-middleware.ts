import { auth } from "./auth";
import { AuthenticationError, AuthorizationError, toAuthErrorResponse } from "./auth-errors";
import {
  getActiveMemberRole as getSessionActiveMemberRole,
  getActiveOrganizationId as getSessionActiveOrganizationId,
} from "./auth-types";
import type { Resource, Action } from "./permissions";
import { roleHasPermission } from "./permission-policy";
import { resolveSessionOrganization, type SessionMembership } from "./session-organization-policy";
import { db } from "@/db";
import { member as memberTable } from "@/db/schema/auth";
import { and, asc, eq } from "drizzle-orm";

/**
 * Auth Middleware Utilities
 *
 * Server-side helpers for route protection and permission checking.
 */

/** Session context returned by getSessionContext */
export interface SessionContext {
  session: Awaited<ReturnType<typeof auth.api.getSession>>;
  userId: string;
  orgId: string;
  role: string;
}

/**
 * Get the current session from request headers.
 * Throws AuthenticationError if no valid session exists.
 */
export async function requireSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });

  if (!session?.user) {
    throw new AuthenticationError();
  }

  return session;
}

/**
 * Get the full session context in a single call.
 * Returns userId, orgId, and role — avoids redundant session fetches.
 * Throws AuthenticationError if not authenticated.
 *
 * If no active organization is set on the session, auto-resolves from
 * the user's first membership to avoid "No active organization" errors.
 */
export async function getSessionContext(headers: Headers): Promise<SessionContext> {
  const session = await requireSession(headers);

  const activeOrganizationId = getSessionActiveOrganizationId(session);
  const activeMemberRole = getSessionActiveMemberRole(session);
  let resolution = resolveSessionOrganization({
    activeOrganizationId,
    activeMemberRole,
    membership: { state: "not_loaded" },
  });

  if (
    resolution.kind === "lookup_active_membership" ||
    resolution.kind === "lookup_oldest_membership"
  ) {
    let membership: SessionMembership | null = null;

    if (resolution.kind === "lookup_active_membership") {
      const [row] = await db
        .select({ organizationId: memberTable.organizationId, role: memberTable.role })
        .from(memberTable)
        .where(
          and(
            eq(memberTable.userId, session.user.id),
            eq(memberTable.organizationId, resolution.orgId),
          ),
        )
        .limit(1);
      membership = row ?? null;
    } else {
      const [row] = await db
        .select({ organizationId: memberTable.organizationId, role: memberTable.role })
        .from(memberTable)
        .where(eq(memberTable.userId, session.user.id))
        .orderBy(asc(memberTable.createdAt), asc(memberTable.id))
        .limit(1);
      membership = row ?? null;
    }

    resolution = resolveSessionOrganization({
      activeOrganizationId,
      activeMemberRole,
      membership: { state: "loaded", membership },
    });
  }

  if (resolution.kind === "forbidden") {
    throw new AuthorizationError("organization", "access");
  }
  if (resolution.kind === "no_organization") {
    throw new Error("No active organization");
  }
  if (resolution.kind !== "resolved") {
    throw new AuthorizationError("organization", "access");
  }

  if (resolution.activateOrganization) {
    try {
      await auth.api.setActiveOrganization({
        headers,
        body: { organizationId: resolution.orgId },
      });
    } catch {
      // Non-fatal: the membership row already established this request's context.
    }
  }

  return {
    session,
    userId: session.user.id,
    orgId: resolution.orgId,
    role: resolution.role,
  };
}

// ============================================================================
// In-memory permission evaluation
// ============================================================================

/**
 * Boolean permission check for a role (no throw, no DB). Use inside a handler
 * that already passed a coarser gate but needs to conditionally allow a
 * finer-grained action (e.g. "may this caller also create parties?").
 */
export { roleHasPermission } from "./permission-policy";

/**
 * Two-key model helper: assert an UNDERLYING resource permission inside a
 * handler whose wrapper already gated the first key (e.g. aiTask:run).
 * Throws AuthorizationError when the role lacks the permission.
 */
export function assertRolePermission<R extends Resource>(
  role: string,
  resource: R,
  action: Action<R>,
): void {
  if (!roleHasPermission(role, resource, action)) {
    throw new AuthorizationError(resource, action);
  }
}

/**
 * Check if the current user has a specific permission.
 * Returns the session context so callers don't need to re-fetch.
 * Throws AuthorizationError if permission is denied.
 *
 * Uses in-memory permission evaluation (zero extra DB calls).
 * Session is fetched once via cookie-cached getSession().
 */
export async function requirePermission<R extends Resource>(
  headers: Headers,
  resource: R,
  action: Action<R>,
): Promise<SessionContext> {
  // Get session context (one call — cookie-cached)
  const ctx = await getSessionContext(headers);

  // In-memory permission check — no DB round-trip
  if (!roleHasPermission(ctx.role, resource, action as string)) {
    throw new AuthorizationError(resource, action);
  }

  return ctx;
}

/**
 * Check multiple permissions at once.
 * All permissions must be granted or AuthorizationError is thrown.
 * Returns the session context.
 */
export async function requirePermissions(
  headers: Headers,
  permissions: Partial<{ [R in Resource]: Action<R>[] }>,
): Promise<SessionContext> {
  const ctx = await getSessionContext(headers);

  const result = await auth.api.hasPermission({
    headers,
    body: { permissions },
  });

  // hasPermission returns { success: boolean }, not a plain boolean
  if (!result?.success) {
    const resources = Object.keys(permissions).join(", ");
    throw new AuthorizationError(resources, "multiple actions");
  }

  return ctx;
}

/**
 * Wrap an async handler with auth error handling.
 * Converts AuthError instances to proper HTTP responses.
 */
export function withAuthErrorHandling<T>(handler: () => Promise<T>): Promise<T | Response> {
  return handler().catch((error) => {
    const { error: message, code, statusCode } = toAuthErrorResponse(error);
    return new Response(JSON.stringify({ error: message, code }), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/**
 * Get the active organization ID from the current session.
 * Returns null if no active organization.
 */
export async function getActiveOrganizationId(headers: Headers): Promise<string | null> {
  const session = await auth.api.getSession({ headers });
  return getSessionActiveOrganizationId(session);
}

/**
 * Get the current user's role in the active organization.
 * Returns null if no active organization.
 */
export async function getActiveMemberRole(headers: Headers): Promise<string | null> {
  const session = await auth.api.getSession({ headers });

  if (!getSessionActiveOrganizationId(session)) {
    return null;
  }

  return getSessionActiveMemberRole(session);
}
