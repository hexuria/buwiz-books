/**
 * App Config Server Functions
 *
 * Exposes server-side configuration to the client safely,
 * without leaking sensitive env vars.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import * as authSchema from "../../db/schema/auth";
import { auth } from "../../lib/auth";

/**
 * Returns public app configuration flags.
 * - inviteOnly: whether the app is in invite-only registration mode
 */
async function getAppConfigImpl() {
  return {
    inviteOnly: process.env.INVITE_ONLY === "true",
  };
}

/**
 * Checks if the current authenticated user can create organizations.
 * Only owners of at least one org (or the bootstrap admin) can create orgs.
 * Returns false for members, admins, and unauthenticated users.
 */
async function getCanCreateOrgImpl() {
  const session = await auth.api.getSession({ headers: getRequest()!.headers });
  if (!session?.user) return { canCreateOrg: false };

  const memberships = await db
    .select({ role: authSchema.member.role })
    .from(authSchema.member)
    .where(eq(authSchema.member.userId, session.user.id));

  // Bootstrap: admin email with no memberships
  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  if (memberships.length === 0 && adminEmail && session.user.email === adminEmail) {
    return { canCreateOrg: true };
  }

  // Owners and admins can create orgs
  return {
    canCreateOrg: memberships.some((m) => m.role === "owner" || m.role === "admin"),
  };
}

export const getAppConfig = createServerFn({ method: "GET" }).handler(async ({ data: _data }) =>
  getAppConfigImpl(),
);

export const getCanCreateOrg = createServerFn({ method: "GET" }).handler(async ({ data: _data }) =>
  getCanCreateOrgImpl(),
);
