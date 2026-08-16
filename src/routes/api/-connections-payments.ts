/**
 * Connections — Payment Gateway Credentials Server Functions
 * Moved from org-settings. Handles reading/writing Stripe & PayPal config
 * stored in auth_organizations.metadata JSON.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseOrgMetadata } from "../../lib/org-metadata";
import { organization } from "../../db/schema/auth";
import { eq } from "drizzle-orm";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { getOrganizationSecrets, updateOrganizationSecrets } from "../../lib/org-secrets";

// ============================================================================
// Types
// ============================================================================

export interface PaymentGatewayConfig {
  paymentProvider: "none" | "stripe" | "paypal" | "both";
  stripePublishableKey: string;
  stripeSecretKeySet: boolean;
  stripeWebhookSecretSet: boolean;
  paypalClientId: string;
  paypalClientSecretSet: boolean;
  paypalMode: "sandbox" | "live";
}

function assertRequestedOrgId(orgId: string, requestedOrgId?: string): string {
  const targetOrgId = requestedOrgId ?? orgId;
  if (targetOrgId !== orgId) {
    throw new Error("Unauthorized: organization ID mismatch");
  }
  return targetOrgId;
}

// ============================================================================
// Get Payment Gateway Config
// ============================================================================

export const getPaymentGatewayConfig = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db, role }) => {
      const { data } = (rawData as { data?: { organizationId?: string } }) ?? {};
      const targetOrgId = assertRequestedOrgId(orgId, data?.organizationId);

      const [org] = await db
        .select({ metadata: organization.metadata })
        .from(organization)
        .where(eq(organization.id, targetOrgId))
        .limit(1);

      const meta = parseOrgMetadata(org?.metadata);
      const secrets = await getOrganizationSecrets(db, targetOrgId);

      // "Secret is set" flags reveal credential config state — admins only.
      // Publishable fields (used to render payment widgets) stay for all.
      const isAdmin = role === "admin" || role === "owner";

      return {
        paymentProvider:
          (meta.paymentProvider as PaymentGatewayConfig["paymentProvider"]) ?? "none",
        stripePublishableKey: meta.stripePublishableKey ?? "",
        stripeSecretKeySet: isAdmin && !!secrets.stripeSecretKey,
        stripeWebhookSecretSet: isAdmin && !!secrets.stripeWebhookSecret,
        paypalClientId: meta.paypalClientId ?? "",
        paypalClientSecretSet: isAdmin && !!secrets.paypalClientSecret,
        paypalMode: meta.paypalMode ?? "sandbox",
      } satisfies PaymentGatewayConfig;
    });
  },
);

// ============================================================================
// Save Payment Gateway Config
// ============================================================================

const savePaymentGatewaySchema = z.object({
  organizationId: z.string(),
  paymentProvider: z.enum(["none", "stripe", "paypal", "both"]),
  stripePublishableKey: z.string().optional().default(""),
  stripeSecretKey: z.string().optional().default(""),
  stripeWebhookSecret: z.string().optional().default(""),
  paypalClientId: z.string().optional().default(""),
  paypalClientSecret: z.string().optional().default(""),
  paypalMode: z.enum(["sandbox", "live"]).optional().default("sandbox"),
});

export const savePaymentGatewayConfig = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "organization:payment-gateway:update", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = savePaymentGatewaySchema.parse(rawData);
        assertRequestedOrgId(orgId, parsed.organizationId);

        const [org] = await db
          .select({ metadata: organization.metadata })
          .from(organization)
          .where(eq(organization.id, orgId))
          .limit(1);

        const meta = parseOrgMetadata(org?.metadata);

        const updated = {
          ...meta,
          paymentProvider: parsed.paymentProvider,
          stripePublishableKey: parsed.stripePublishableKey,
          paypalClientId: parsed.paypalClientId,
          paypalMode: parsed.paypalMode,
        };

        await db
          .update(organization)
          .set({ metadata: JSON.stringify(updated) })
          .where(eq(organization.id, orgId));
        await updateOrganizationSecrets(db, orgId, {
          ...(parsed.stripeSecretKey.trim()
            ? { stripeSecretKey: parsed.stripeSecretKey.trim() }
            : {}),
          ...(parsed.stripeWebhookSecret.trim()
            ? { stripeWebhookSecret: parsed.stripeWebhookSecret.trim() }
            : {}),
          ...(parsed.paypalClientSecret.trim()
            ? { paypalClientSecret: parsed.paypalClientSecret.trim() }
            : {}),
        });

        return { success: true };
      },
    );
  },
);
