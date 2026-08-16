import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { organizationAccountingSettings } from "@/db/schema/inbox";
import { organization } from "@/db/schema/auth";
import { withMutationPermissionOrgContext, withPermissionOrgContext } from "@/lib/server-context";

export const getInboxSettings = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("inbox", "view", async ({ orgId, db }) => {
    const [settings] = await db
      .select({
        baseCurrency: organizationAccountingSettings.baseCurrency,
        timezone: organizationAccountingSettings.timezone,
        inboundEmailAddress: organizationAccountingSettings.inboundEmailAddress,
        reviewPolicy: organizationAccountingSettings.reviewPolicy,
        requireDifferentApprover: organizationAccountingSettings.requireDifferentApprover,
        allowOwnerOverride: organizationAccountingSettings.allowOwnerOverride,
      })
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, orgId))
      .limit(1);
    return (
      settings ?? {
        baseCurrency: "USD",
        timezone: "UTC",
        inboundEmailAddress: null,
        reviewPolicy: "always_review",
        requireDifferentApprover: true,
        allowOwnerOverride: true,
      }
    );
  }),
);

const updateInboxSettingsSchema = z.object({
  inboundEmailAddress: z.string().trim().email().max(320).nullable(),
  requireDifferentApprover: z.boolean(),
  allowOwnerOverride: z.boolean(),
});

export const updateInboxSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateInboxSettingsSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "integration",
      "authorize",
      { routeKey: "inbox:settings", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const [saved] = await db
          .insert(organizationAccountingSettings)
          .values({
            organizationId: orgId,
            inboundEmailAddress: data.inboundEmailAddress?.toLowerCase() ?? null,
            requireDifferentApprover: data.requireDifferentApprover,
            allowOwnerOverride: data.allowOwnerOverride,
          })
          .onConflictDoUpdate({
            target: organizationAccountingSettings.organizationId,
            set: {
              inboundEmailAddress: data.inboundEmailAddress?.toLowerCase() ?? null,
              requireDifferentApprover: data.requireDifferentApprover,
              allowOwnerOverride: data.allowOwnerOverride,
              updatedAt: new Date(),
            },
          })
          .returning({
            inboundEmailAddress: organizationAccountingSettings.inboundEmailAddress,
            requireDifferentApprover: organizationAccountingSettings.requireDifferentApprover,
            allowOwnerOverride: organizationAccountingSettings.allowOwnerOverride,
          });
        return saved;
      },
    ),
  );

// ============================================================================
// Auto-provision a unique inbound forwarding address
// ============================================================================

/** Lowercase, DNS-safe local-part fragment from an org slug/name. */
function slugFragment(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned || "org";
}

/** Short random base36 suffix, e.g. "k3f9q2". */
function randomSuffix(): string {
  return Array.from(randomBytes(5))
    .map((b) => (b % 36).toString(36))
    .join("");
}

/**
 * Generate and persist a unique inbound accounting address on the org's
 * receiving domain (INBOUND_EMAIL_DOMAIN). Resend receives at the domain level,
 * so provisioning is just minting a unique local-part — no external API call.
 */
export const generateInboundEmailAddress = createServerFn({ method: "POST" }).handler(async () =>
  withMutationPermissionOrgContext(
    "integration",
    "authorize",
    { routeKey: "inbox:generate-address", limit: 10, windowMs: 60_000 },
    async ({ orgId, db }) => {
      const domain = process.env.INBOUND_EMAIL_DOMAIN;
      if (!domain) {
        throw new Error(
          "Inbound email is not configured (INBOUND_EMAIL_DOMAIN is unset). Contact your administrator.",
        );
      }

      const [org] = await db
        .select({ slug: organization.slug, name: organization.name })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);
      const base = slugFragment(org?.slug || org?.name || "org");

      // Retry on the (rare) unique-index collision on inbound_email_address.
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const address = `inbox-${base}-${randomSuffix()}@${domain}`.toLowerCase();
        try {
          const [saved] = await db
            .insert(organizationAccountingSettings)
            .values({ organizationId: orgId, inboundEmailAddress: address })
            .onConflictDoUpdate({
              target: organizationAccountingSettings.organizationId,
              set: { inboundEmailAddress: address, updatedAt: new Date() },
            })
            .returning({
              inboundEmailAddress: organizationAccountingSettings.inboundEmailAddress,
            });
          return saved;
        } catch (err) {
          lastError = err;
        }
      }
      throw new Error(
        `Could not generate a unique inbound address after several attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  ),
);
