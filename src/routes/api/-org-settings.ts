// ============================================================================
// Organization Settings — Server Functions
// Manages org-level configuration stored in auth_organizations.metadata
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { serverBrand } from "@/config/brand";
import { organization, member, user, invitation } from "../../db/schema/auth";
import { eq, and, desc } from "drizzle-orm";
import { createLogger } from "../../lib/logger";
import {
  withMutationPermissionOrgContext,
  withSessionOrgContext,
  type OrgServerContext,
} from "../../lib/server-context";
import { sendApproverInviteEmail } from "../../services/email";
import { parseOrgMetadata } from "../../lib/org-metadata";
import { maskGeminiKeys } from "../../lib/mask-secret";
import { getOrganizationSecrets, updateOrganizationSecrets } from "../../lib/org-secrets";
import {
  addOrgAiCredential as addOrgAiCredentialRow,
  getOrgAiConfig,
  listOrgAiCredentials,
  revokeOrgAiCredential as revokeOrgAiCredentialRow,
  updateOrgAiConfig,
  type OrgAiConfigView,
  type OrgAiCredentialView,
} from "../../lib/ai/org-ai-config";

const logger = createLogger("api.org-settings");

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  geminiApiKeys: string[];
  geminiDefaultModel: string;
  aiModelOcr: string;
  aiModelTextAnalysis: string;
  aiModelImageGen: string;
  enableImageGeneration: boolean;
  emailSenderName: string;
  emailSenderEmail: string;
  resendApiKeySet: boolean;
  phone: string;
  website: string;
  taxId: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressPostalCode: string;
  addressCountry: string;
  logoUrl: string;
  currency: string;
  paymentProvider: string;
  stripePublishableKey: string;
  stripeSecretKeySet: boolean;
  paypalClientId: string;
  paypalClientSecretSet: boolean;
  paymentBankAccountId: string;
}

export interface OrgMember {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: {
    name: string | null;
    email: string;
    image: string | null;
  };
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertOrgScope(ctx: OrgServerContext, organizationId: string): void {
  if (organizationId !== ctx.orgId) {
    throw new Error("Not authorized for this organization");
  }
}

function assertOrgAdmin(ctx: Pick<OrgServerContext, "role">): void {
  if (ctx.role !== "admin" && ctx.role !== "owner") {
    throw new Error("Only organization admins can perform this action");
  }
}

// ── Server Functions ─────────────────────────────────────────────────────────

async function getOrgSettingsImpl(rawData: unknown): Promise<OrgSettings> {
  return withSessionOrgContext(async (ctx) => {
    const { organizationId } = rawData as { organizationId: string };
    if (!organizationId) throw new Error("organizationId is required");
    assertOrgScope(ctx, organizationId);

    const [org] = await ctx.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
        metadata: organization.metadata,
      })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    if (!org) throw new Error("Organization not found");

    const [meta, secrets] = await Promise.all([
      Promise.resolve(parseOrgMetadata(org.metadata)),
      getOrganizationSecrets(ctx.db, organizationId),
    ]);

    // Credential material (masked AI keys, "secret is set" flags) is only for
    // org admins. Non-admins still read this endpoint to render invoices, so
    // display + publishable fields stay; the credential fields are redacted.
    const isAdmin = ctx.role === "admin" || ctx.role === "owner";
    const maskedGeminiKeys = isAdmin ? maskGeminiKeys(secrets.geminiApiKeys) : [];

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      geminiApiKeys: maskedGeminiKeys,
      geminiDefaultModel: meta.geminiDefaultModel ?? "",
      aiModelOcr: meta.aiModelOcr ?? "",
      aiModelTextAnalysis: meta.aiModelTextAnalysis ?? "",
      aiModelImageGen: meta.aiModelImageGen ?? "",
      enableImageGeneration: meta.enableImageGeneration ?? false,
      emailSenderName: meta.emailSenderName ?? "",
      emailSenderEmail: meta.emailSenderEmail ?? "",
      resendApiKeySet: isAdmin && !!secrets.resendApiKey,
      phone: meta.phone ?? "",
      website: meta.website ?? "",
      taxId: meta.taxId ?? "",
      addressStreet: meta.addressStreet ?? "",
      addressCity: meta.addressCity ?? "",
      addressState: meta.addressState ?? "",
      addressPostalCode: meta.addressPostalCode ?? "",
      addressCountry: meta.addressCountry ?? "",
      logoUrl: meta.logoUrl ?? "",
      currency: meta.currency ?? "USD",
      paymentProvider: meta.paymentProvider ?? "none",
      stripePublishableKey: meta.stripePublishableKey ?? "",
      stripeSecretKeySet: isAdmin && !!secrets.stripeSecretKey,
      paypalClientId: meta.paypalClientId ?? "",
      paypalClientSecretSet: isAdmin && !!secrets.paypalClientSecret,
      paymentBankAccountId: meta.paymentBankAccountId ?? "",
    } satisfies OrgSettings;
  });
}

async function listOrgMembersImpl(): Promise<OrgMember[]> {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const rows = await db
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        userName: user.name,
        userEmail: user.email,
        userImage: user.image,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, orgId));

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      role: row.role,
      createdAt: row.createdAt,
      user: {
        name: row.userName,
        email: row.userEmail,
        image: row.userImage,
      },
    }));
  });
}

async function listAllOrganizationsImpl() {
  return withSessionOrgContext(async (ctx) => {
    // The platform-wide org list is only useful to the one identity that may
    // actually enter another tenant (see `adminSwitchOrgImpl`), and every id it
    // returns is a cross-tenant target, so it is gated on the same check. A
    // tenant admin gets the empty list and the switcher's "All Organizations"
    // section never renders for them.
    if (!isPlatformOperator(ctx)) {
      return { orgs: [], isAdmin: false };
    }

    const allOrgs = await ctx.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
      })
      .from(organization)
      .orderBy(organization.name);

    return { orgs: allOrgs, isAdmin: true };
  });
}

/**
 * True only for the platform operator — the `ADMIN_EMAIL` break-glass account
 * configured at deploy time (see the env table in README.md). Sign-in is Google
 * OAuth or email OTP, so matching it requires owning that mailbox; unlike
 * `isUserAdmin` it is not something a tenant can grant itself. Unset => nobody.
 */
function isPlatformOperator(ctx: Pick<OrgServerContext, "session">): boolean {
  const configured = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!configured) return false;
  const email = ctx.session?.user?.email?.trim().toLowerCase();
  return !!email && email === configured;
}

async function adminSwitchOrgImpl(rawData: unknown) {
  return withMutationPermissionOrgContext(
    "organization",
    "update",
    { routeKey: "org-settings:admin-switch-org", limit: 10, windowMs: 60_000 },
    async (ctx) => {
      const { organizationId } = rawData as { organizationId: string };
      if (!organizationId) throw new Error("organizationId is required");

      const existing = await ctx.db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, ctx.userId), eq(member.organizationId, organizationId)))
        .limit(1);

      // Already a member: the caller is switching between orgs that are
      // genuinely theirs, and there is nothing to grant.
      if (existing.length > 0) return { success: true };

      // Not a member. Granting membership in an org the caller does not belong
      // to crosses the tenant boundary, so "admin or owner in ANY org" can
      // never authorize it — every user who creates a workspace is its owner,
      // which would let anyone join any tenant as admin. Only the platform
      // operator identity, which no tenant can assign itself, may do this.
      if (!isPlatformOperator(ctx)) {
        throw new Error("Not authorized for this organization");
      }

      await ctx.db.insert(member).values({
        id: crypto.randomUUID(),
        userId: ctx.userId,
        organizationId,
        role: "admin",
      });
      logger.warn("Platform operator break-glass join", {
        userId: ctx.userId,
        organizationId,
      });

      return { success: true };
    },
  );
}

/**
 * Get organization settings including API keys.
 */
export const getOrgSettings = createServerFn({ method: "GET" }).handler(async ({ data }) =>
  getOrgSettingsImpl(data),
);

/**
 * Update organization Gemini API keys.
 */
export const updateOrgGeminiKeys = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-gemini-keys", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const {
          organizationId,
          keys,
          defaultModel,
          aiModelOcr,
          aiModelTextAnalysis,
          aiModelImageGen,
        } = rawData as {
          organizationId: string;
          keys: string[];
          defaultModel?: string;
          aiModelOcr?: string;
          aiModelTextAnalysis?: string;
          aiModelImageGen?: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const [org] = await ctx.db
          .select({ metadata: organization.metadata })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1);

        if (!org) throw new Error("Organization not found");

        const meta = parseOrgMetadata(org.metadata);
        const currentSecrets = await getOrganizationSecrets(ctx.db, organizationId);
        const currentMasks = maskGeminiKeys(currentSecrets.geminiApiKeys);
        const currentByMask = new Map(
          currentMasks.map((mask, i) => [mask, currentSecrets.geminiApiKeys[i]]),
        );
        const nextKeys = keys
          .filter((key) => typeof key === "string" && key.trim().length > 0)
          .map((key) => currentByMask.get(key.trim()) ?? key.trim());
        if (defaultModel) {
          meta.geminiDefaultModel = defaultModel;
        }
        if (aiModelOcr !== undefined) meta.aiModelOcr = aiModelOcr || undefined;
        if (aiModelTextAnalysis !== undefined)
          meta.aiModelTextAnalysis = aiModelTextAnalysis || undefined;
        if (aiModelImageGen !== undefined) meta.aiModelImageGen = aiModelImageGen || undefined;

        await ctx.db
          .update(organization)
          .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(organization.id, organizationId));
        await updateOrganizationSecrets(ctx.db, organizationId, {
          geminiApiKeys: nextKeys,
        });

        return { success: true, keyCount: nextKeys.length };
      },
    );
  },
);

/**
 * Update organization image generation setting.
 */
export const updateOrgImageGenerationSetting = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-image-generation", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId, enabled } = rawData as {
          organizationId: string;
          enabled: boolean;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const [org] = await ctx.db
          .select({ metadata: organization.metadata })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1);

        if (!org) throw new Error("Organization not found");

        const meta = parseOrgMetadata(org.metadata);
        meta.enableImageGeneration = enabled;

        await ctx.db
          .update(organization)
          .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(organization.id, organizationId));

        return { success: true, enabled };
      },
    );
  },
);

// ============================================================================
// Per-org AI credentials + settings (multi-provider BYOK)
//
// Admin-only, like every other credential surface in this file. The logic
// lives in src/lib/ai/org-ai-config.ts so the "never return key material" and
// "never widen OCR egress" invariants are testable without a request; these
// handlers are the auth + rate-limit + org-scope shell around it.
// ============================================================================

export type { OrgAiConfigView, OrgAiCredentialView };

/**
 * List every AI credential for the org, masked. Includes legacy Gemini keys
 * (organization_secrets) as read-only pseudo-rows so admins see one list.
 */
export const getOrgAiCredentials = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:get-ai-credentials", limit: 60, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId } = (rawData ?? {}) as { organizationId?: string };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        return listOrgAiCredentials(ctx.db, organizationId);
      },
    );
  },
);

/**
 * Add a BYOK credential for a provider. `baseUrl` is required for — and only
 * accepted from — `openai_compatible`.
 */
export const addOrgAiCredential = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:add-ai-credential", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId, provider, apiKey, label, baseUrl } = rawData as {
          organizationId: string;
          provider: string;
          apiKey: string;
          label?: string;
          baseUrl?: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const created = await addOrgAiCredentialRow(ctx.db, {
          orgId: organizationId,
          actorId: ctx.userId,
          provider,
          apiKey,
          label,
          baseUrl,
        });

        // Mask only — the key never round-trips back to the client.
        return { success: true, id: created.id, provider: created.provider, mask: created.mask };
      },
    );
  },
);

/**
 * Revoke a credential (soft delete — the row and its audit trail survive).
 */
export const revokeOrgAiCredential = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:revoke-ai-credential", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId, credentialId } = rawData as {
          organizationId: string;
          credentialId: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        if (!credentialId) throw new Error("credentialId is required");
        assertOrgScope(ctx, organizationId);

        return revokeOrgAiCredentialRow(ctx.db, {
          orgId: organizationId,
          actorId: ctx.userId,
          credentialId,
        });
      },
    );
  },
);

/**
 * The org's AI settings (or defaults) plus the effective chain per task, so
 * the UI shows what will actually run — not just what was overridden.
 */
export const getOrgAiSettingsForUi = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:get-ai-settings", limit: 60, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId } = (rawData ?? {}) as { organizationId?: string };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        return getOrgAiConfig(ctx.db, organizationId);
      },
    );
  },
);

/**
 * Update the org's AI settings. Document-task chains are re-filtered to Gemini
 * before persistence, the settings cache is invalidated, and the field-level
 * diff is written to activity_logs.
 */
export const updateOrgAiSettings = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-ai-settings", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const {
          organizationId,
          providerAllowlist,
          taskChains,
          confidenceThresholds,
          monthlySpendCapUsd,
          killSwitch,
          taskAllowlist,
        } = rawData as {
          organizationId: string;
          providerAllowlist?: unknown;
          taskChains?: unknown;
          confidenceThresholds?: unknown;
          monthlySpendCapUsd?: unknown;
          killSwitch?: unknown;
          taskAllowlist?: unknown;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const raw = rawData as Record<string, unknown>;
        const result = await updateOrgAiConfig(ctx.db, {
          orgId: organizationId,
          actorId: ctx.userId,
          // Forwarded only when present — an absent key means "leave as is".
          ...("providerAllowlist" in raw ? { providerAllowlist } : {}),
          ...("taskChains" in raw ? { taskChains } : {}),
          ...("confidenceThresholds" in raw ? { confidenceThresholds } : {}),
          ...("monthlySpendCapUsd" in raw ? { monthlySpendCapUsd } : {}),
          ...("killSwitch" in raw ? { killSwitch } : {}),
          ...("taskAllowlist" in raw ? { taskAllowlist } : {}),
        });

        // Field NAMES only — the values are already in activity_logs, and the
        // response shape has to stay serializable.
        return { success: true as const, changedFields: Object.keys(result.changes) };
      },
    );
  },
);

/**
 * Update organization name.
 */
export const updateOrgName = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-name", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId, name } = rawData as {
          organizationId: string;
          name: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        if (!name?.trim()) throw new Error("name is required");
        assertOrgScope(ctx, organizationId);

        await ctx.db
          .update(organization)
          .set({ name: name.trim(), updatedAt: new Date() })
          .where(eq(organization.id, organizationId));

        return { success: true };
      },
    );
  },
);

/**
 * List org members with user details.
 */
export const listOrgMembers = createServerFn({ method: "GET" }).handler(async () =>
  listOrgMembersImpl(),
);

/**
 * Update a member's role.
 */
export const updateMemberRole = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-member-role", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { memberId, role } = rawData as { memberId: string; role: string };
        if (!memberId) throw new Error("memberId is required");
        if (!["owner", "admin", "member", "client_approver", "report_viewer"].includes(role)) {
          throw new Error("Invalid role");
        }

        // Privilege check: Only owners can assign the owner role
        if (role === "owner" && ctx.role !== "owner") {
          throw new Error("Only an existing owner can grant the owner role");
        }

        const [existing] = await ctx.db
          .select({ organizationId: member.organizationId, role: member.role })
          .from(member)
          .where(eq(member.id, memberId))
          .limit(1);
        if (!existing) throw new Error("Member not found");
        assertOrgScope(ctx, existing.organizationId);

        // Privilege check: Admins cannot modify an owner's role
        if (existing.role === "owner" && ctx.role !== "owner") {
          throw new Error("Only an existing owner can modify another owner's role");
        }

        await ctx.db
          .update(member)
          .set({ role, updatedAt: new Date() })
          .where(eq(member.id, memberId));

        return { success: true };
      },
    );
  },
);

/**
 * Remove a member from the org.
 */
export const removeOrgMember = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:remove-member", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { memberId } = rawData as { memberId: string };
        if (!memberId) throw new Error("memberId is required");

        const [existing] = await ctx.db
          .select({ organizationId: member.organizationId, role: member.role })
          .from(member)
          .where(eq(member.id, memberId))
          .limit(1);
        if (!existing) throw new Error("Member not found");
        assertOrgScope(ctx, existing.organizationId);

        // Privilege check: Admins cannot remove an owner
        if (existing.role === "owner" && ctx.role !== "owner") {
          throw new Error("Only an existing owner can remove another owner");
        }

        await ctx.db.delete(member).where(eq(member.id, memberId));

        return { success: true };
      },
    );
  },
);

// ============================================================================
// Admin — Platform-Level Functions
// ============================================================================

/**
 * List ALL organizations on the platform (platform operator only).
 * Everyone else receives an empty array — they should use `organization.list()`.
 */
export const listAllOrganizations = createServerFn({ method: "GET" }).handler(async () =>
  listAllOrganizationsImpl(),
);

/**
 * Prepare a switch to `organizationId`.
 *
 * Succeeds as a no-op when the caller already belongs to that organization.
 * Membership is auto-created ONLY for the platform operator (`ADMIN_EMAIL`);
 * every other caller is rejected, because holding admin/owner in one org says
 * nothing about their right to enter another one.
 */
export const adminSwitchOrg = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  adminSwitchOrgImpl(data),
);

// ============================================================================
// Invitation Functions
// ============================================================================

/**
 * Create an invitation (inserts directly into invitation table).
 * Better Auth's built-in invitation flow handles the email via the
 * `sendInvitationEmail` callback configured in auth.ts.
 * However, for direct server-fn usage we insert manually and return the ID.
 */
export const createInvitation = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:create-invitation", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { email, role } = rawData as {
          email: string;
          role: string;
        };
        if (!email) throw new Error("email is required");
        const invitationRole = role || "member";
        if (
          !["owner", "admin", "member", "client_approver", "report_viewer"].includes(invitationRole)
        ) {
          throw new Error("Invalid role");
        }
        if (invitationRole === "owner" && ctx.role !== "owner") {
          throw new Error("Only an existing owner can invite another owner");
        }

        const inviteId = crypto.randomUUID();

        await ctx.db.insert(invitation).values({
          id: inviteId,
          email,
          organizationId: ctx.orgId,
          role: invitationRole,
          status: "pending",
          inviterId: ctx.userId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });

        const [org] = await ctx.db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, ctx.orgId))
          .limit(1);
        const [inviter] = await ctx.db
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, ctx.userId))
          .limit(1);

        const workspaceName = org?.name ?? serverBrand.appName;
        const inviterName = inviter?.name ?? "A team member";

        const secrets = await getOrganizationSecrets(ctx.db, ctx.orgId);

        sendApproverInviteEmail({
          to: email,
          inviterName,
          workspaceName,
          joinUrl: `${process.env.APP_URL ?? "http://localhost:3000"}/organizations/join?code=${inviteId}`,
          resendApiKey: secrets.resendApiKey || undefined,
        }).catch((err) =>
          logger.error("Approver invite email failed", {
            organizationId: ctx.orgId,
            invitationId: inviteId,
            error: err,
          }),
        );

        return { success: true, invitationId: inviteId };
      },
    );
  },
);

/**
 * List pending invitations for an organization.
 */
export const listInvitations = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async (ctx) => {
      const { organizationId } = rawData as { organizationId: string };
      if (!organizationId) throw new Error("organizationId is required");
      assertOrgScope(ctx, organizationId);

      const rows = await ctx.db
        .select({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          createdAt: invitation.createdAt,
          expiresAt: invitation.expiresAt,
        })
        .from(invitation)
        .where(and(eq(invitation.organizationId, organizationId)))
        .orderBy(desc(invitation.createdAt));

      return rows as OrgInvitation[];
    });
  },
);

// ============================================================================
// Email Settings Functions
// ============================================================================

/**
 * Update organization email settings (sender name, sender email, Resend API key).
 * Stored in auth_organizations.metadata alongside geminiApiKeys.
 */
export const updateOrgEmailSettings = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-email", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const { organizationId, emailSenderName, emailSenderEmail, resendApiKey } = rawData as {
          organizationId: string;
          emailSenderName?: string;
          emailSenderEmail?: string;
          resendApiKey?: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const [org] = await ctx.db
          .select({ metadata: organization.metadata })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1);

        if (!org) throw new Error("Organization not found");

        const meta = parseOrgMetadata(org.metadata);
        if (emailSenderName !== undefined)
          meta.emailSenderName = emailSenderName.trim() || undefined;
        if (emailSenderEmail !== undefined) {
          meta.emailSenderEmail = emailSenderEmail.trim() || undefined;
        }
        await ctx.db
          .update(organization)
          .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(organization.id, organizationId));
        if (resendApiKey?.trim()) {
          await updateOrganizationSecrets(ctx.db, organizationId, {
            resendApiKey: resendApiKey.trim(),
          });
        }

        return { success: true };
      },
    );
  },
);

/**
 * Update organization business profile info stored in metadata.
 */
export const updateOrgBusinessInfo = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-business", limit: 15, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const {
          organizationId,
          phone,
          website,
          taxId,
          addressStreet,
          addressCity,
          addressState,
          addressPostalCode,
          addressCountry,
          logoUrl,
          currency,
        } = rawData as {
          organizationId: string;
          phone?: string;
          website?: string;
          taxId?: string;
          addressStreet?: string;
          addressCity?: string;
          addressState?: string;
          addressPostalCode?: string;
          addressCountry?: string;
          logoUrl?: string;
          currency?: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const [org] = await ctx.db
          .select({ metadata: organization.metadata })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1);

        if (!org) throw new Error("Organization not found");

        const meta = parseOrgMetadata(org.metadata);

        if (phone !== undefined) meta.phone = phone.trim() || undefined;
        if (website !== undefined) meta.website = website.trim() || undefined;
        if (taxId !== undefined) meta.taxId = taxId.trim() || undefined;
        if (addressStreet !== undefined) meta.addressStreet = addressStreet.trim() || undefined;
        if (addressCity !== undefined) meta.addressCity = addressCity.trim() || undefined;
        if (addressState !== undefined) meta.addressState = addressState.trim() || undefined;
        if (addressPostalCode !== undefined) {
          meta.addressPostalCode = addressPostalCode.trim() || undefined;
        }
        if (addressCountry !== undefined) meta.addressCountry = addressCountry.trim() || undefined;
        if (logoUrl !== undefined) meta.logoUrl = logoUrl.trim() || undefined;
        if (currency !== undefined) meta.currency = currency.trim() || undefined;

        await ctx.db
          .update(organization)
          .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(organization.id, organizationId));

        return { success: true };
      },
    );
  },
);

/**
 * Get the email of the organization owner (first member with role "owner").
 * Used as fallback when no sender email is configured.
 */
export const getOwnerEmail = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async (ctx) => {
      const { organizationId } = rawData as { organizationId: string };
      if (!organizationId) throw new Error("organizationId is required");
      assertOrgScope(ctx, organizationId);

      const [ownerRow] = await ctx.db
        .select({ email: user.email, name: user.name })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")))
        .limit(1);

      return ownerRow ?? null;
    });
  },
);

// ============================================================================
// Payment Settings Functions
// ============================================================================

/**
 * Update organization payment gateway settings (Stripe / PayPal).
 * Stored in auth_organizations.metadata alongside other settings.
 */
export const updateOrgPaymentSettings = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-payments", limit: 10, windowMs: 60_000 },
      async (ctx) => {
        assertOrgAdmin(ctx);
        const {
          organizationId,
          paymentProvider,
          stripePublishableKey,
          stripeSecretKey,
          paypalClientId,
          paypalClientSecret,
          paymentBankAccountId,
        } = rawData as {
          organizationId: string;
          paymentProvider?: string;
          stripePublishableKey?: string;
          stripeSecretKey?: string;
          paypalClientId?: string;
          paypalClientSecret?: string;
          paymentBankAccountId?: string;
        };
        if (!organizationId) throw new Error("organizationId is required");
        assertOrgScope(ctx, organizationId);

        const [org] = await ctx.db
          .select({ metadata: organization.metadata })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1);

        if (!org) throw new Error("Organization not found");

        const meta = parseOrgMetadata(org.metadata);

        if (paymentProvider !== undefined) meta.paymentProvider = paymentProvider || undefined;
        if (stripePublishableKey !== undefined) {
          meta.stripePublishableKey = stripePublishableKey.trim() || undefined;
        }
        if (paypalClientId !== undefined) meta.paypalClientId = paypalClientId.trim() || undefined;
        if (paymentBankAccountId !== undefined) {
          meta.paymentBankAccountId = paymentBankAccountId.trim() || undefined;
        }

        await ctx.db
          .update(organization)
          .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(organization.id, organizationId));
        await updateOrganizationSecrets(ctx.db, organizationId, {
          ...(stripeSecretKey?.trim() ? { stripeSecretKey: stripeSecretKey.trim() } : {}),
          ...(paypalClientSecret?.trim() ? { paypalClientSecret: paypalClientSecret.trim() } : {}),
        });

        return { success: true };
      },
    );
  },
);
