/**
 * Belt-and-braces session revocation for member removal and role changes.
 *
 * The primary defense is that getSessionContext re-resolves the caller's role
 * from auth_members on every request, so a removed or demoted member loses
 * access on their very next call regardless of what their cookie claims. This
 * helper adds the second layer: killing the target's sessions outright forces
 * a fresh sign-in, which also clears the cookie-cached organization/role
 * claims better-auth's OWN endpoints may still consult during the 24h
 * cookieCache window, and un-sticks a client whose cookie still points at an
 * organization it can no longer enter.
 *
 * Call sites pass `dbAdmin`, and that needs the justification CLAUDE.md asks
 * for: auth_sessions RLS is user-scoped (a session row belongs to its user),
 * and this is the one administrative write that legitimately targets ANOTHER
 * user's rows. Sessions carry no organization column, so no org-scoped policy
 * can express the permission. The org boundary is enforced by the caller
 * instead, which must have already verified — under its own org context and
 * admin gate — that the target is a member of the caller's organization.
 */
import { eq } from "drizzle-orm";
import { session } from "@/db/schema/auth";
import type { DbExecutor } from "@/db";

export async function revokeUserSessions(executor: DbExecutor, userId: string): Promise<number> {
  const deleted = await executor
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return deleted.length;
}

/**
 * The form the org-settings mutations call. dbAdmin is imported lazily so the
 * route module stays constructible in unit tests that mock the request
 * context but have no database (the module-level client would otherwise be
 * built at import time).
 */
export async function revokeUserSessionsAsAdmin(userId: string): Promise<number> {
  const { dbAdmin } = await import("@/db");
  return revokeUserSessions(dbAdmin, userId);
}
