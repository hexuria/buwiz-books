import { auth } from "./auth";
import { AuthenticationError, AuthorizationError, toAuthErrorResponse } from "./auth-errors";
import {
  getActiveMemberRole as getSessionActiveMemberRole,
  getActiveOrganizationId as getSessionActiveOrganizationId,
  type UserRole,
} from "./auth-types";
import type { Resource, Action } from "./permissions";
import { roles } from "./permissions";
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

  let orgId = getSessionActiveOrganizationId(session);
  let role: string | null = getSessionActiveMemberRole(session);

  if (orgId && !role) {
    // The session has an active org but no role. The role MUST come from the
    // membership row of that same org — the previous fallback took the user's
    // arbitrary first membership, which could belong to a different org and
    // grant a mismatched role (e.g. admin-in-A acting on B).
    const [membership] = await db
      .select()
      .from(memberTable)
      .where(and(eq(memberTable.userId, session.user.id), eq(memberTable.organizationId, orgId)))
      .limit(1);

    if (!membership) {
      throw new AuthorizationError("organization", "access");
    }
    role = membership.role as UserRole;
  } else if (!orgId) {
    // No active org on the session — deterministically pick the OLDEST
    // membership (createdAt, then id, as tiebreak) and take BOTH orgId and
    // role from that single row. Never mix rows: org and role must always
    // describe the same membership.
    const [membership] = await db
      .select()
      .from(memberTable)
      .where(eq(memberTable.userId, session.user.id))
      .orderBy(asc(memberTable.createdAt), asc(memberTable.id))
      .limit(1);

    if (membership) {
      orgId = membership.organizationId;
      role = membership.role as UserRole;

      // Try to set active org on the session so future requests don't need this fallback
      try {
        await auth.api.setActiveOrganization({
          headers,
          body: { organizationId: orgId },
        });
      } catch {
        // Non-fatal — we already have the orgId
      }
    }
  }

  if (!orgId) {
    throw new Error("No active organization");
  }

  if (!role) {
    // Unreachable today: every path above either resolved a role or threw.
    // Kept as a hard failure so a future refactor can't silently grant a
    // default role for an org the user may not belong to.
    throw new AuthorizationError("organization", "access");
  }

  return {
    session,
    userId: session.user.id,
    orgId,
    role,
  };
}

// ============================================================================
// In-memory permission evaluation
// ============================================================================

/** Map role name → role definition from permissions.ts */
const ROLE_MAP: Record<string, { statements: Record<string, readonly string[]> }> = {
  owner: roles.superuser,
  admin: roles.admin,
  member: roles.member,
  client_approver: roles.clientApprover,
  report_viewer: roles.reportViewer,
};

/**
 * Evaluate a permission check in-memory using role definitions.
 * No DB call needed — all role→permission mappings are static.
 */
function checkPermissionLocal(role: string, resource: string, action: string): boolean {
  const roleDef = ROLE_MAP[role];
  if (!roleDef) return false;
  const allowed = roleDef.statements[resource];
  if (!allowed) return false;
  return allowed.includes(action);
}

/**
 * Boolean permission check for a role (no throw, no DB). Use inside a handler
 * that already passed a coarser gate but needs to conditionally allow a
 * finer-grained action (e.g. "may this caller also create parties?").
 */
export function roleHasPermission(role: string, resource: string, action: string): boolean {
  return checkPermissionLocal(role, resource, action);
}

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
  if (!checkPermissionLocal(role, resource, action)) {
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
  if (!checkPermissionLocal(ctx.role, resource, action as string)) {
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
