// ============================================================================
// Invitation Lookup — Server Functions (PUBLIC — no auth required)
// Provides safe, read-only invitation metadata for the join page.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequest } from "@tanstack/react-start/server";
import { db } from "../../db";
import { invitation, organization, user, member } from "../../db/schema/auth";
import { eq, and } from "drizzle-orm";
import { auth } from "../../lib/auth";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InvitationDetails {
  id: string;
  orgName: string;
  orgLogo: string | null;
  inviterName: string;
  role: string;
  /** Masked email — e.g. "h***@gmail.com" */
  maskedEmail: string;
  /** Full email — only used server-side for matching, NOT sent to client by default */
  email: string;
  status: string;
  expiresAt: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Mask an email: "hugo@gmail.com" → "h***@gmail.com" */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(local.length - 1, 5))}@${domain}`;
}

/**
 * Normalize email for comparison.
 * Gmail ignores dots in local part: "gigachad.rustacean@gmail.com" === "gigachadrustacean@gmail.com"
 * Also handles googlemail.com alias.
 */
function normalizeEmail(email: string): string {
  const lower = email.toLowerCase().trim();
  const [local, domain] = lower.split("@");
  if (!domain) return lower;
  // Gmail and googlemail treat dots as insignificant
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.replace(/\./g, "")}@gmail.com`;
  }
  return lower;
}

// ── Server Functions ─────────────────────────────────────────────────────────

const invitationCodeSchema = z.object({
  code: z.string().min(1),
});

/**
 * Look up invitation details by code (invitation ID).
 * This is a PUBLIC endpoint — no authentication required.
 * Only exposes safe metadata (org name, masked email, role, inviter name).
 */
export const lookupInvitation = createServerFn({ method: "GET" })
  .inputValidator((data) => invitationCodeSchema.parse(data))
  .handler(async ({ data }) => {
    const { code } = data;

    // Fetch invitation with org and inviter details
    const rows = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        orgName: organization.name,
        orgLogo: organization.logo,
        inviterName: user.name,
      })
      .from(invitation)
      .innerJoin(organization, eq(invitation.organizationId, organization.id))
      .innerJoin(user, eq(invitation.inviterId, user.id))
      .where(eq(invitation.id, code.trim()))
      .limit(1);

    if (rows.length === 0) {
      throw new Error("Invitation not found. It may have been revoked or never existed.");
    }

    const inv = rows[0];

    // Check if expired
    if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
      throw new Error("This invitation has expired. Please ask the admin to send a new one.");
    }

    // Check if already used
    if (inv.status === "accepted") {
      throw new Error("This invitation has already been accepted.");
    }

    if (inv.status === "canceled" || inv.status === "rejected") {
      throw new Error("This invitation is no longer valid.");
    }

    return {
      id: inv.id,
      orgName: inv.orgName,
      orgLogo: inv.orgLogo,
      inviterName: inv.inviterName ?? "A team member",
      role: inv.role,
      maskedEmail: maskEmail(inv.email),
      email: inv.email,
      status: inv.status,
      expiresAt: inv.expiresAt?.toISOString() ?? null,
    } satisfies InvitationDetails;
  });

// ============================================================================
// Accept Invitation — Server-side (AUTHENTICATED)
// Handles acceptance for invitations created via direct DB insert.
// ============================================================================

/**
 * Accept an invitation by code (invitation ID).
 * Requires an active session. Creates the membership and marks the invitation
 * as accepted. Works with invitations created via our custom createInvitation
 * server function (which bypasses better-auth's invitation API).
 */
export const acceptInvitationByCode = createServerFn({ method: "POST" })
  .inputValidator((data) => invitationCodeSchema.parse(data))
  .handler(async ({ data }) => {
    const { code } = data;

    // Get the authenticated user's session
    const session = await auth.api.getSession({ headers: getRequest()!.headers });
    if (!session?.user) {
      throw new Error("You must be signed in to accept an invitation.");
    }

    // Fetch the invitation
    const [inv] = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        organizationId: invitation.organizationId,
      })
      .from(invitation)
      .where(eq(invitation.id, code.trim()))
      .limit(1);

    if (!inv) {
      throw new Error("Invitation not found.");
    }

    // Validate status
    if (inv.status === "accepted") {
      throw new Error("This invitation has already been accepted.");
    }
    if (inv.status === "canceled" || inv.status === "rejected") {
      throw new Error("This invitation is no longer valid.");
    }
    if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
      throw new Error("This invitation has expired.");
    }

    // Verify email matches (Gmail-aware: dots in local part are ignored)
    if (normalizeEmail(session.user.email ?? "") !== normalizeEmail(inv.email)) {
      throw new Error(
        `This invitation was sent to ${maskEmail(inv.email)}. Please sign in with that email address.`,
      );
    }

    // Check if user is already a member of this org
    const existingMembership = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, session.user.id), eq(member.organizationId, inv.organizationId)))
      .limit(1);

    if (existingMembership.length > 0) {
      // Already a member — just mark invitation as accepted and return success
      await db
        .update(invitation)
        .set({ status: "accepted", updatedAt: new Date() })
        .where(eq(invitation.id, inv.id));

      return {
        success: true,
        organizationId: inv.organizationId,
        alreadyMember: true,
      };
    }

    // Create the membership
    const memberId = crypto.randomUUID();
    await db.insert(member).values({
      id: memberId,
      userId: session.user.id,
      organizationId: inv.organizationId,
      role: inv.role || "member",
    });

    // Mark invitation as accepted
    await db
      .update(invitation)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(invitation.id, inv.id));

    return {
      success: true,
      organizationId: inv.organizationId,
      alreadyMember: false,
    };
  });
