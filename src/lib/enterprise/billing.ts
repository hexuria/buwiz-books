import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { dbAdmin, type DbExecutor } from "../../db";
import { user } from "../../db/schema/auth";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
  enterpriseBillingCheckoutSessions,
  enterpriseBillingSubscriptions,
} from "../../db/schema/business-groups";
import { BUSINESS_GROUPS_FEATURE, BusinessGroupAccessError } from "./entitlement-state";
import {
  getBusinessGroupsEntityUsage,
  lockEnterpriseAllowance,
  requireEnterpriseAccountRole,
} from "./entitlements";

export const ENTERPRISE_BILLING_ROLES = ["owner", "billing_admin"] as const;
const STRIPE_CHECKOUT_SECONDS = 2 * 60 * 60;
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

export class EnterpriseBillingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "BILLING_NOT_CONFIGURED"
      | "BILLING_ACCOUNT_SUSPENDED"
      | "BILLING_ALREADY_MANAGED"
      | "BILLING_ACTIVATION_PENDING"
      | "BILLING_PORTAL_UNAVAILABLE"
      | "BILLING_QUANTITY_BELOW_USAGE",
  ) {
    super(message);
    this.name = "EnterpriseBillingError";
  }
}

export interface EnterpriseBillingOverview {
  enterpriseAccountId: string;
  accountName: string;
  role: "owner" | "billing_admin";
  management: "none" | "manual" | "stripe";
  entitlementStatus: string | null;
  quantity: number | null;
  providerStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canStartCheckout: boolean;
  canOpenPortal: boolean;
}

function isTerminalSubscriptionStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_SUBSCRIPTION_STATUSES.has(status));
}

export async function getEnterpriseBillingOverview(
  executor: DbExecutor,
  enterpriseAccountId: string,
  userId: string,
): Promise<EnterpriseBillingOverview> {
  const membership = await requireEnterpriseAccountRole(
    executor,
    enterpriseAccountId,
    userId,
    ENTERPRISE_BILLING_ROLES,
  );
  const [row] = await executor
    .select({
      account: enterpriseAccounts,
      entitlement: accountEntitlements,
      subscription: enterpriseBillingSubscriptions,
    })
    .from(enterpriseAccounts)
    .leftJoin(
      accountEntitlements,
      and(
        eq(accountEntitlements.enterpriseAccountId, enterpriseAccounts.id),
        eq(accountEntitlements.featureKey, BUSINESS_GROUPS_FEATURE),
      ),
    )
    .leftJoin(
      enterpriseBillingSubscriptions,
      eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccounts.id),
    )
    .where(eq(enterpriseAccounts.id, enterpriseAccountId))
    .limit(1);
  if (!row) throw new BusinessGroupAccessError("Enterprise account access is denied");

  const management = row.subscription
    ? "stripe"
    : row.entitlement
      ? row.entitlement.provisioningSource === "stripe"
        ? "stripe"
        : "manual"
      : "none";
  const accountIsActive = row.account.status === "active";
  const terminalSubscription = isTerminalSubscriptionStatus(row.subscription?.providerStatus);
  const portalConfigured = Boolean(process.env.STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID);
  return {
    enterpriseAccountId,
    accountName: row.account.name,
    role: membership.role as "owner" | "billing_admin",
    management,
    entitlementStatus: row.entitlement?.status ?? null,
    quantity: row.subscription?.quantity ?? row.entitlement?.includedEntityLimit ?? null,
    providerStatus: row.subscription?.providerStatus ?? null,
    currentPeriodEnd: row.subscription?.currentPeriodEnd.toISOString() ?? null,
    cancelAtPeriodEnd: row.subscription?.cancelAtPeriodEnd ?? false,
    canStartCheckout: accountIsActive && (management === "none" || terminalSubscription),
    canOpenPortal: Boolean(
      accountIsActive && portalConfigured && row.account.externalCustomerId && row.subscription,
    ),
  };
}

interface BillingActor {
  accountName: string;
  billingContactEmail: string | null;
  externalCustomerId: string | null;
}

async function requireBillingActor(
  tx: Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0],
  enterpriseAccountId: string,
  userId: string,
): Promise<BillingActor> {
  const [actorUser] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .for("update");
  if (!actorUser) throw new BusinessGroupAccessError("Enterprise billing access is denied");

  const [account] = await tx
    .select({
      accountName: enterpriseAccounts.name,
      accountStatus: enterpriseAccounts.status,
      billingContactEmail: enterpriseAccounts.billingContactEmail,
      externalCustomerId: enterpriseAccounts.externalCustomerId,
    })
    .from(enterpriseAccounts)
    .where(eq(enterpriseAccounts.id, enterpriseAccountId))
    .limit(1)
    .for("update");
  if (!account) throw new BusinessGroupAccessError("Enterprise billing access is denied");

  const [membership] = await tx
    .select({ role: enterpriseAccountMembers.role })
    .from(enterpriseAccountMembers)
    .where(
      and(
        eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
        eq(enterpriseAccountMembers.userId, userId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !membership ||
    !ENTERPRISE_BILLING_ROLES.includes(membership.role as (typeof ENTERPRISE_BILLING_ROLES)[number])
  ) {
    throw new BusinessGroupAccessError("Enterprise billing access is denied");
  }
  if (account.accountStatus !== "active") {
    throw new EnterpriseBillingError(
      "Enterprise billing cannot be changed while the account is suspended.",
      "BILLING_ACCOUNT_SUSPENDED",
    );
  }
  return account;
}

interface CheckoutReservation {
  id: string;
  requestedQuantity: number;
  externalPriceId: string;
  externalCustomerId: string | null;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  status: "creating" | "open";
  providerSessionId: string | null;
  providerSessionUrl: string | null;
  expiresAt: Date;
}

function checkoutReturnUrls(enterpriseAccountId: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const returnUrl = new URL("/business-groups", enterpriseBillingBaseUrl());
  returnUrl.searchParams.set("accountId", enterpriseAccountId);
  const successUrl = new URL(returnUrl);
  successUrl.searchParams.set("billing", "success");
  const cancelUrl = new URL(returnUrl);
  cancelUrl.searchParams.set("billing", "cancelled");
  return { successUrl: successUrl.toString(), cancelUrl: cancelUrl.toString() };
}

function checkoutReservationView(
  row: typeof enterpriseBillingCheckoutSessions.$inferSelect,
): CheckoutReservation {
  if (row.status !== "creating" && row.status !== "open") {
    throw new Error("checkout_reservation_is_not_active");
  }
  return {
    id: row.id,
    requestedQuantity: row.requestedQuantity,
    externalPriceId: row.externalPriceId,
    externalCustomerId: row.externalCustomerId,
    customerEmail: row.customerEmail,
    successUrl: row.successUrl,
    cancelUrl: row.cancelUrl,
    status: row.status,
    providerSessionId: row.providerSessionId,
    providerSessionUrl: row.providerSessionUrl,
    expiresAt: row.expiresAt,
  };
}

export async function reserveEnterpriseCheckout(input: {
  enterpriseAccountId: string;
  userId: string;
  requestedQuantity: number;
  now?: Date;
}): Promise<CheckoutReservation> {
  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`enterprise-billing-checkout:${input.enterpriseAccountId}`}, 0))`,
    );
    const actor = await requireBillingActor(tx, input.enterpriseAccountId, input.userId);
    await lockEnterpriseAllowance(tx, input.enterpriseAccountId);
    const usage = await getBusinessGroupsEntityUsage(tx, input.enterpriseAccountId);
    if (input.requestedQuantity < usage) {
      throw new EnterpriseBillingError(
        `The requested allowance cannot be below the ${usage} currently linked businesses.`,
        "BILLING_QUANTITY_BELOW_USAGE",
      );
    }
    const [subscription] = await tx
      .select({
        id: enterpriseBillingSubscriptions.id,
        providerStatus: enterpriseBillingSubscriptions.providerStatus,
      })
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, input.enterpriseAccountId))
      .limit(1);
    const terminalSubscription = isTerminalSubscriptionStatus(subscription?.providerStatus);
    if (subscription && !terminalSubscription) {
      throw new EnterpriseBillingError(
        "This Enterprise account is already managed in Stripe. Open the billing portal instead.",
        "BILLING_ALREADY_MANAGED",
      );
    }
    const [entitlement] = await tx
      .select({ provisioningSource: accountEntitlements.provisioningSource })
      .from(accountEntitlements)
      .where(
        and(
          eq(accountEntitlements.enterpriseAccountId, input.enterpriseAccountId),
          eq(accountEntitlements.featureKey, BUSINESS_GROUPS_FEATURE),
        ),
      )
      .limit(1);
    if (entitlement && !(terminalSubscription && entitlement.provisioningSource === "stripe")) {
      throw new EnterpriseBillingError(
        "This Enterprise contract must be migrated to Stripe by support before checkout.",
        "BILLING_ALREADY_MANAGED",
      );
    }

    const [active] = await tx
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(
        and(
          eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, input.enterpriseAccountId),
          inArray(enterpriseBillingCheckoutSessions.status, ["creating", "open", "completed"]),
        ),
      )
      .orderBy(desc(enterpriseBillingCheckoutSessions.createdAt))
      .limit(1)
      .for("update");
    if (active?.status === "completed") {
      throw new EnterpriseBillingError(
        "Subscription activation is still being reconciled. Try again shortly.",
        "BILLING_ACTIVATION_PENDING",
      );
    }
    if (active && (active.status === "creating" || active.status === "open")) {
      if (active.requestedQuantity < usage) {
        throw new EnterpriseBillingError(
          `The reserved allowance is below the ${usage} currently linked businesses. Contact support to reconcile the pending Checkout Session.`,
          "BILLING_QUANTITY_BELOW_USAGE",
        );
      }
      return checkoutReservationView(active);
    }

    const priceId = process.env.STRIPE_ENTERPRISE_PRICE_ID;
    if (!priceId) {
      throw new EnterpriseBillingError(
        "Enterprise billing is not configured.",
        "BILLING_NOT_CONFIGURED",
      );
    }
    const { successUrl, cancelUrl } = checkoutReturnUrls(input.enterpriseAccountId);
    // Do not shorten a new provider window by time spent waiting on either
    // account-scoped advisory lock or validating the account. Tests may still
    // inject a deterministic time.
    const now = input.now ?? new Date();
    const expiresAt = new Date((Math.floor(now.getTime() / 1000) + STRIPE_CHECKOUT_SECONDS) * 1000);

    const [created] = await tx
      .insert(enterpriseBillingCheckoutSessions)
      .values({
        enterpriseAccountId: input.enterpriseAccountId,
        createdBy: input.userId,
        requestedQuantity: input.requestedQuantity,
        externalPriceId: priceId,
        externalCustomerId: actor.externalCustomerId,
        customerEmail: actor.externalCustomerId ? null : actor.billingContactEmail,
        successUrl,
        cancelUrl,
        expiresAt,
      })
      .returning();
    return checkoutReservationView(created);
  });
}

export function enterpriseBillingBaseUrl(): string {
  const configured = process.env.BETTER_AUTH_URL ?? process.env.VITE_APP_URL;
  if (!configured) {
    if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
    throw new EnterpriseBillingError(
      "Enterprise billing is not configured.",
      "BILLING_NOT_CONFIGURED",
    );
  }
  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new EnterpriseBillingError(
      "Enterprise billing is not configured.",
      "BILLING_NOT_CONFIGURED",
    );
  }
  return url.origin;
}

function checkoutSessionMatchesReservation(
  session: Stripe.Checkout.Session,
  reservation: CheckoutReservation,
  enterpriseAccountId: string,
  expectedProviderSessionId: string,
): boolean {
  return (
    session.id === expectedProviderSessionId &&
    session.client_reference_id === enterpriseAccountId &&
    session.metadata?.enterpriseAccountId === enterpriseAccountId &&
    session.metadata?.checkoutReservationId === reservation.id
  );
}

async function reconcileRetrievedCheckoutSession(
  enterpriseAccountId: string,
  userId: string,
  reservation: CheckoutReservation,
  session: Stripe.Checkout.Session,
  expectedProviderSessionId: string,
): Promise<"open" | "completed" | "expired"> {
  if (
    !checkoutSessionMatchesReservation(
      session,
      reservation,
      enterpriseAccountId,
      expectedProviderSessionId,
    )
  ) {
    throw new Error("checkout_session_binding_mismatch");
  }
  if (!session.status || !["open", "complete", "expired"].includes(session.status)) {
    throw new Error("checkout_session_status_is_invalid");
  }
  const providerState = session.status === "complete" ? "completed" : session.status;

  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`enterprise-billing-checkout:${enterpriseAccountId}`}, 0))`,
    );
    await requireBillingActor(tx, enterpriseAccountId, userId);
    await lockEnterpriseAllowance(tx, enterpriseAccountId);
    const [current] = await tx
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(
        and(
          eq(enterpriseBillingCheckoutSessions.id, reservation.id),
          eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId),
        ),
      )
      .limit(1)
      .for("update");
    const providerMatches =
      current?.providerSessionId === session.id ||
      (current?.providerSessionId === null &&
        (current.status === "creating" || current.status === "consumed"));
    if (!current || !providerMatches) throw new Error("checkout_reservation_mismatch");

    // A signed webhook or subscription reconciliation owns terminal truth if
    // it won the race while the provider retrieve was in flight.
    if (current.status === "completed" || current.status === "consumed") {
      if (!current.providerSessionId) {
        await tx
          .update(enterpriseBillingCheckoutSessions)
          .set({ providerSessionId: session.id, updatedAt: new Date() })
          .where(eq(enterpriseBillingCheckoutSessions.id, current.id));
      }
      return "completed";
    }
    if (current.status === "expired") return "expired";
    if (current.status !== "creating" && current.status !== "open") {
      throw new Error("checkout_reservation_state_mismatch");
    }

    if (providerState === "open" && !session.url) {
      throw new Error("checkout_session_url_is_missing");
    }
    await tx
      .update(enterpriseBillingCheckoutSessions)
      .set({
        status: providerState,
        providerSessionId: session.id,
        providerSessionUrl: providerState === "open" ? session.url : null,
        completedAt: providerState === "completed" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(enterpriseBillingCheckoutSessions.id, current.id));
    return providerState;
  });
}

async function reconcileKnownCheckoutSession(
  stripe: Stripe,
  enterpriseAccountId: string,
  userId: string,
  reservation: CheckoutReservation,
): Promise<"open" | "completed" | "expired"> {
  if (!reservation.providerSessionId) throw new Error("checkout_session_id_is_missing");
  const session = await stripe.checkout.sessions.retrieve(reservation.providerSessionId);
  return reconcileRetrievedCheckoutSession(
    enterpriseAccountId,
    userId,
    reservation,
    session,
    reservation.providerSessionId,
  );
}

export async function createEnterpriseCheckoutSession(
  stripe: Stripe,
  input: {
    enterpriseAccountId: string;
    userId: string;
    requestedQuantity: number;
  },
): Promise<{ url: string; reused: boolean; quantity: number }> {
  let reservation = await reserveEnterpriseCheckout(input);
  if (reservation.status === "open" && reservation.providerSessionUrl) {
    if (reservation.expiresAt.getTime() <= Date.now()) {
      const providerState = await reconcileKnownCheckoutSession(
        stripe,
        input.enterpriseAccountId,
        input.userId,
        reservation,
      );
      if (providerState === "expired") {
        reservation = await reserveEnterpriseCheckout(input);
      } else if (providerState === "completed") {
        throw new EnterpriseBillingError(
          "Subscription activation is still being reconciled. Try again shortly.",
          "BILLING_ACTIVATION_PENDING",
        );
      } else {
        return {
          url: reservation.providerSessionUrl,
          reused: true,
          quantity: reservation.requestedQuantity,
        };
      }
    } else {
      return {
        url: reservation.providerSessionUrl,
        reused: true,
        quantity: reservation.requestedQuantity,
      };
    }
  }
  if (reservation.status === "creating" && reservation.expiresAt.getTime() <= Date.now()) {
    throw new EnterpriseBillingError(
      "Checkout creation is awaiting reconciliation. Contact support with the Enterprise account ID before starting another subscription.",
      "BILLING_ACTIVATION_PENDING",
    );
  }
  if (reservation.status === "open") {
    throw new EnterpriseBillingError(
      "Checkout is awaiting provider reconciliation. Try again shortly.",
      "BILLING_ACTIVATION_PENDING",
    );
  }

  const enterpriseMetadata = {
    enterpriseAccountId: input.enterpriseAccountId,
    checkoutReservationId: reservation.id,
  };
  const request: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [
      {
        price: reservation.externalPriceId,
        quantity: reservation.requestedQuantity,
      },
    ],
    client_reference_id: input.enterpriseAccountId,
    customer: reservation.externalCustomerId ?? undefined,
    customer_email: reservation.externalCustomerId
      ? undefined
      : (reservation.customerEmail ?? undefined),
    metadata: enterpriseMetadata,
    subscription_data: { metadata: enterpriseMetadata },
    success_url: reservation.successUrl,
    cancel_url: reservation.cancelUrl,
    expires_at: Math.floor(reservation.expiresAt.getTime() / 1000),
  };
  const session = await stripe.checkout.sessions.create(request, {
    idempotencyKey: `enterprise-checkout:${reservation.id}`,
  });
  if (!session.expires_at) {
    throw new Error("Stripe did not return a reusable Enterprise Checkout session");
  }
  if (session.expires_at * 1000 <= Date.now()) {
    const currentSession = await stripe.checkout.sessions.retrieve(session.id);
    const providerState = await reconcileRetrievedCheckoutSession(
      input.enterpriseAccountId,
      input.userId,
      reservation,
      currentSession,
      session.id,
    );
    throw new EnterpriseBillingError(
      providerState === "expired"
        ? "Stripe returned an expired Checkout Session. Start Checkout again."
        : "Checkout is awaiting verified provider reconciliation. Try again shortly.",
      "BILLING_ACTIVATION_PENDING",
    );
  }
  if (!session.url) {
    throw new Error("Stripe did not return a reusable Enterprise Checkout session");
  }
  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`enterprise-billing-checkout:${input.enterpriseAccountId}`}, 0))`,
    );
    await requireBillingActor(tx, input.enterpriseAccountId, input.userId);
    await lockEnterpriseAllowance(tx, input.enterpriseAccountId);
    const [current] = await tx
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(
        and(
          eq(enterpriseBillingCheckoutSessions.id, reservation.id),
          eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, input.enterpriseAccountId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current || (current.providerSessionId && current.providerSessionId !== session.id)) {
      throw new Error("checkout_reservation_mismatch");
    }
    if (current.status === "creating" && !current.providerSessionId) {
      await tx
        .update(enterpriseBillingCheckoutSessions)
        .set({
          status: "open",
          providerSessionId: session.id,
          providerSessionUrl: session.url,
          updatedAt: new Date(),
        })
        .where(eq(enterpriseBillingCheckoutSessions.id, current.id));
      return {
        url: session.url!,
        reused: false,
        quantity: current.requestedQuantity,
      };
    }
    if (current.status === "open" && current.providerSessionUrl) {
      return {
        url: current.providerSessionUrl,
        reused: true,
        quantity: current.requestedQuantity,
      };
    }
    if (current.status === "completed" || current.status === "consumed") {
      throw new EnterpriseBillingError(
        "Subscription activation is still being reconciled. Try again shortly.",
        "BILLING_ACTIVATION_PENDING",
      );
    }
    if (current.status === "expired") {
      throw new EnterpriseBillingError(
        "The Checkout Session expired while it was being opened. Start Checkout again.",
        "BILLING_ACTIVATION_PENDING",
      );
    }
    throw new Error("checkout_reservation_state_mismatch");
  });
}

export async function createEnterprisePortalSession(
  stripe: Stripe,
  input: { enterpriseAccountId: string; userId: string },
): Promise<{ url: string }> {
  const customerId = await dbAdmin.transaction(async (tx) => {
    const lockedActor = await requireBillingActor(tx, input.enterpriseAccountId, input.userId);
    const [subscription] = await tx
      .select({
        externalCustomerId: enterpriseBillingSubscriptions.externalCustomerId,
      })
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, input.enterpriseAccountId))
      .limit(1)
      .for("update");
    if (
      !lockedActor.externalCustomerId ||
      !subscription ||
      subscription.externalCustomerId !== lockedActor.externalCustomerId
    ) {
      throw new EnterpriseBillingError(
        "No current Stripe subscription is available for this Enterprise account.",
        "BILLING_PORTAL_UNAVAILABLE",
      );
    }
    return lockedActor.externalCustomerId;
  });
  const configuration = process.env.STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID;
  if (!configuration) {
    throw new EnterpriseBillingError(
      "Enterprise billing is not configured.",
      "BILLING_NOT_CONFIGURED",
    );
  }
  const returnUrl = new URL("/business-groups", enterpriseBillingBaseUrl());
  returnUrl.searchParams.set("accountId", input.enterpriseAccountId);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration,
    return_url: returnUrl.toString(),
  });
  return { url: session.url };
}
