/** Authenticated Enterprise Stripe Checkout and customer-portal boundaries. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createLogger } from "../../lib/logger";
import {
  createEnterpriseCheckoutSession,
  createEnterprisePortalSession,
  ENTERPRISE_BILLING_ROLES,
  EnterpriseBillingError,
  getEnterpriseBillingOverview,
} from "../../lib/enterprise/billing";
import { requireEnterpriseAccountRole } from "../../lib/enterprise/entitlements";
import { AuthError } from "../../lib/auth-errors";
import { withMutationSessionUserContext, withSessionUserContext } from "../../lib/server-context";

const logger = createLogger("api.enterprise-billing");
const accountSchema = z.object({ enterpriseAccountId: z.string().uuid() });
const checkoutSchema = accountSchema.extend({
  quantity: z.number().int().min(1).max(1_000),
});

async function stripeClient() {
  const secretKey = process.env.STRIPE_ENTERPRISE_SECRET_KEY;
  if (!secretKey || !process.env.DATABASE_URL_ADMIN) {
    throw new EnterpriseBillingError(
      "Enterprise billing is not configured.",
      "BILLING_NOT_CONFIGURED",
    );
  }
  const { default: Stripe } = await import("stripe");
  return new Stripe(secretKey);
}

function safeBillingFailure(error: unknown): never {
  if (error instanceof EnterpriseBillingError || error instanceof AuthError) throw error;
  logger.error("Enterprise billing request failed", { error: String(error) });
  throw new Error("Enterprise billing could not be opened. Please try again.");
}

export const getEnterpriseBilling = createServerFn({ method: "GET" })
  .validator((data: unknown) => accountSchema.parse(data))
  .handler(async ({ data }) =>
    withSessionUserContext(({ db, userId }) =>
      getEnterpriseBillingOverview(db, data.enterpriseAccountId, userId),
    ),
  );

export const startEnterpriseCheckout = createServerFn({ method: "POST" })
  .validator((data: unknown) => checkoutSchema.parse(data))
  .handler(async ({ data }) => {
    const actor = await withMutationSessionUserContext(
      data.enterpriseAccountId,
      { routeKey: "enterprise-billing:checkout", limit: 10, windowMs: 60_000 },
      async ({ db, userId }) => {
        await requireEnterpriseAccountRole(
          db,
          data.enterpriseAccountId,
          userId,
          ENTERPRISE_BILLING_ROLES,
        );
        return { userId };
      },
    );
    try {
      return await createEnterpriseCheckoutSession(await stripeClient(), {
        enterpriseAccountId: data.enterpriseAccountId,
        userId: actor.userId,
        requestedQuantity: data.quantity,
      });
    } catch (error) {
      safeBillingFailure(error);
    }
  });

export const openEnterpriseBillingPortal = createServerFn({ method: "POST" })
  .validator((data: unknown) => accountSchema.parse(data))
  .handler(async ({ data }) => {
    const actor = await withMutationSessionUserContext(
      data.enterpriseAccountId,
      { routeKey: "enterprise-billing:portal", limit: 20, windowMs: 60_000 },
      async ({ db, userId }) => {
        await requireEnterpriseAccountRole(
          db,
          data.enterpriseAccountId,
          userId,
          ENTERPRISE_BILLING_ROLES,
        );
        return { userId };
      },
    );
    try {
      return await createEnterprisePortalSession(await stripeClient(), {
        enterpriseAccountId: data.enterpriseAccountId,
        userId: actor.userId,
      });
    } catch (error) {
      safeBillingFailure(error);
    }
  });
