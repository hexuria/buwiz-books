import { and, eq, inArray, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { dbAdmin } from "../../db";
import {
  accountEntitlements,
  enterpriseAccounts,
  enterpriseBillingCheckoutSessions,
  enterpriseBillingSubscriptions,
  enterpriseBillingWebhookEvents,
  entitlementEvents,
} from "../../db/schema/business-groups";
import { BUSINESS_GROUPS_FEATURE } from "./entitlement-state";
import {
  resolveEnterpriseStripeTransition,
  snapshotEnterpriseStripeSubscription,
  type EnterpriseStripeSubscriptionSnapshot,
} from "./stripe-entitlement-policy";
export {
  resolveEnterpriseStripeTransition,
  snapshotEnterpriseStripeSubscription,
} from "./stripe-entitlement-policy";
export type {
  EnterpriseStripePriorEntitlement,
  EnterpriseStripeSubscriptionSnapshot,
  EnterpriseStripeTransition,
} from "./stripe-entitlement-policy";
import { lockEnterpriseAllowance } from "./entitlements";

const RELEVANT_EVENT_TYPES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "checkout.session.completed",
  "checkout.session.expired",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_FAILURE_CODES = new Set([
  "missing_enterprise_account",
  "invalid_enterprise_account",
  "unexpected_price_configuration",
  "invalid_quantity",
  "invalid_billing_period",
]);

export type EnterpriseStripeProcessingResult = {
  status: "processed" | "ignored";
  duplicate: boolean;
  failureCode?: string;
};

function stringId(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

async function markEvent(
  tx: Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0],
  providerEventId: string,
  values: {
    status: "processed" | "ignored";
    enterpriseAccountId?: string;
    failureCode?: string;
  },
) {
  await tx
    .update(enterpriseBillingWebhookEvents)
    .set({
      status: values.status,
      enterpriseAccountId: values.enterpriseAccountId,
      failureCode: values.failureCode,
      processedAt: new Date(),
    })
    .where(eq(enterpriseBillingWebhookEvents.providerEventId, providerEventId));
}

async function recordIgnoredEvent(
  event: Pick<Stripe.Event, "id" | "type" | "created">,
  failureCode?: string,
): Promise<EnterpriseStripeProcessingResult> {
  const inserted = await dbAdmin
    .insert(enterpriseBillingWebhookEvents)
    .values({
      providerEventId: event.id,
      eventType: event.type,
      providerCreatedAt: new Date(event.created * 1000),
      status: "ignored",
      failureCode,
      processedAt: new Date(),
    })
    .onConflictDoNothing({
      target: enterpriseBillingWebhookEvents.providerEventId,
    })
    .returning({ id: enterpriseBillingWebhookEvents.id });
  return {
    status: "ignored",
    duplicate: inserted.length === 0,
    ...(failureCode ? { failureCode } : {}),
  };
}

function providerEventIsNotNewer(
  storedCreatedAt: Date,
  storedEventId: string,
  incomingCreatedAt: Date,
  incomingEventId: string,
): boolean {
  const storedTimestamp = storedCreatedAt.getTime();
  const incomingTimestamp = incomingCreatedAt.getTime();
  return (
    storedTimestamp > incomingTimestamp ||
    (storedTimestamp === incomingTimestamp && storedEventId >= incomingEventId)
  );
}

async function lockEnterpriseStripeProviderIdentifiers(
  tx: Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0],
  snapshot: Pick<EnterpriseStripeSubscriptionSnapshot, "customerId" | "subscriptionId">,
): Promise<void> {
  // Different Enterprise accounts can receive metadata that points at the
  // same provider objects. Sort the namespaced keys so every transaction takes
  // overlapping provider locks in one global order before unique binding writes.
  const providerIdentifierLockKeys = [
    `buwiz:enterprise-stripe:customer:${snapshot.customerId}`,
    `buwiz:enterprise-stripe:subscription:${snapshot.subscriptionId}`,
  ].sort();
  for (const lockKey of providerIdentifierLockKeys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  }
}

async function processEnterpriseCheckoutEvent(
  event: Stripe.Event,
): Promise<EnterpriseStripeProcessingResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const enterpriseAccountId = session.metadata?.enterpriseAccountId?.trim();
  const reservationId = session.metadata?.checkoutReservationId?.trim();
  const completed = event.type === "checkout.session.completed";
  const validBinding =
    Boolean(enterpriseAccountId && UUID_PATTERN.test(enterpriseAccountId)) &&
    Boolean(reservationId && UUID_PATTERN.test(reservationId)) &&
    session.client_reference_id === enterpriseAccountId &&
    (!completed || (session.mode === "subscription" && Boolean(session.subscription)));
  if (!validBinding) {
    return recordIgnoredEvent(event, "invalid_checkout_binding");
  }

  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buwiz:enterprise-entitlement:${enterpriseAccountId}`}, 0))`,
    );
    await tx
      .insert(enterpriseBillingWebhookEvents)
      .values({
        providerEventId: event.id,
        eventType: event.type,
        providerCreatedAt: new Date(event.created * 1000),
      })
      .onConflictDoNothing({
        target: enterpriseBillingWebhookEvents.providerEventId,
      });
    const [delivery] = await tx
      .select()
      .from(enterpriseBillingWebhookEvents)
      .where(eq(enterpriseBillingWebhookEvents.providerEventId, event.id))
      .limit(1)
      .for("update");
    if (!delivery) throw new Error("stripe_event_not_recorded");
    if (delivery.status === "processed" || delivery.status === "ignored") {
      return {
        status: delivery.status,
        duplicate: true,
        ...(delivery.failureCode ? { failureCode: delivery.failureCode } : {}),
      };
    }

    const [account] = await tx
      .select({ id: enterpriseAccounts.id })
      .from(enterpriseAccounts)
      .where(eq(enterpriseAccounts.id, enterpriseAccountId!))
      .limit(1)
      .for("no key update");
    if (!account) {
      await markEvent(tx, event.id, {
        status: "ignored",
        failureCode: "enterprise_account_not_found",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "enterprise_account_not_found",
      };
    }
    await lockEnterpriseAllowance(tx, account.id);

    const [reservation] = await tx
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservationId!))
      .limit(1)
      .for("update");
    const providerMatches =
      reservation?.providerSessionId === session.id ||
      (reservation?.providerSessionId === null &&
        (reservation.status === "creating" || reservation.status === "consumed"));
    if (
      !reservation ||
      reservation.enterpriseAccountId !== enterpriseAccountId ||
      !providerMatches
    ) {
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId,
        failureCode: "checkout_reservation_mismatch",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "checkout_reservation_mismatch",
      };
    }
    if (reservation.status === "consumed" || (!completed && reservation.status === "completed")) {
      if (!reservation.providerSessionId) {
        await tx
          .update(enterpriseBillingCheckoutSessions)
          .set({ providerSessionId: session.id, updatedAt: new Date() })
          .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
      }
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId,
        failureCode: "stale_checkout_event",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "stale_checkout_event",
      };
    }
    const transitionAllowed = completed
      ? ["creating", "open", "completed"].includes(reservation.status)
      : ["creating", "open", "expired"].includes(reservation.status);
    if (!transitionAllowed) {
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId,
        failureCode: "checkout_reservation_mismatch",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "checkout_reservation_mismatch",
      };
    }

    await tx
      .update(enterpriseBillingCheckoutSessions)
      .set({
        status: completed ? "completed" : "expired",
        providerSessionId: session.id,
        completedAt: completed ? new Date(event.created * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    await markEvent(tx, event.id, {
      status: "processed",
      enterpriseAccountId,
    });
    return { status: "processed", duplicate: false };
  });
}

export async function applyEnterpriseStripeSubscription(
  event: Pick<Stripe.Event, "id" | "type" | "created">,
  snapshot: EnterpriseStripeSubscriptionSnapshot,
): Promise<EnterpriseStripeProcessingResult> {
  const eventCreatedAt = new Date(event.created * 1000);
  return dbAdmin.transaction(async (tx) => {
    // This namespace exactly matches the operator CLI. Stripe deliveries and
    // manual break-glass updates therefore serialize before reading or
    // changing any state for the same Enterprise account.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buwiz:enterprise-entitlement:${snapshot.enterpriseAccountId}`}, 0))`,
    );

    await tx
      .insert(enterpriseBillingWebhookEvents)
      .values({
        providerEventId: event.id,
        eventType: event.type,
        providerCreatedAt: eventCreatedAt,
      })
      .onConflictDoNothing({
        target: enterpriseBillingWebhookEvents.providerEventId,
      });

    const [delivery] = await tx
      .select()
      .from(enterpriseBillingWebhookEvents)
      .where(eq(enterpriseBillingWebhookEvents.providerEventId, event.id))
      .limit(1)
      .for("update");
    if (!delivery) throw new Error("stripe_event_not_recorded");
    if (delivery.status === "processed" || delivery.status === "ignored") {
      return {
        status: delivery.status,
        duplicate: true,
        ...(delivery.failureCode ? { failureCode: delivery.failureCode } : {}),
      };
    }

    const [account] = await tx
      .select()
      .from(enterpriseAccounts)
      .where(eq(enterpriseAccounts.id, snapshot.enterpriseAccountId))
      .limit(1)
      .for("no key update");
    if (!account) {
      await markEvent(tx, event.id, {
        status: "ignored",
        failureCode: "enterprise_account_not_found",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "enterprise_account_not_found",
      };
    }

    // Shared lock hierarchy for billing and allowance-changing operations:
    // entitlement advisory -> delivery row -> account row -> allowance
    // advisory -> optional checkout reservation -> sorted provider identifiers
    // -> subscription/entitlement state.
    await lockEnterpriseAllowance(tx, account.id);

    let checkoutReservation: typeof enterpriseBillingCheckoutSessions.$inferSelect | undefined;
    if (snapshot.checkoutReservationId) {
      [checkoutReservation] = await tx
        .select()
        .from(enterpriseBillingCheckoutSessions)
        .where(eq(enterpriseBillingCheckoutSessions.id, snapshot.checkoutReservationId))
        .limit(1)
        .for("update");
      if (
        !checkoutReservation ||
        checkoutReservation.enterpriseAccountId !== account.id ||
        checkoutReservation.status === "expired" ||
        checkoutReservation.externalPriceId !== snapshot.priceId ||
        checkoutReservation.requestedQuantity !== snapshot.quantity ||
        (checkoutReservation.externalCustomerId !== null &&
          checkoutReservation.externalCustomerId !== snapshot.customerId)
      ) {
        await markEvent(tx, event.id, {
          status: "ignored",
          enterpriseAccountId: account.id,
          failureCode: "checkout_reservation_mismatch",
        });
        return {
          status: "ignored",
          duplicate: false,
          failureCode: "checkout_reservation_mismatch",
        };
      }
    }

    await lockEnterpriseStripeProviderIdentifiers(tx, snapshot);

    const [customerAccountOwner] = await tx
      .select({ enterpriseAccountId: enterpriseAccounts.id })
      .from(enterpriseAccounts)
      .where(eq(enterpriseAccounts.externalCustomerId, snapshot.customerId))
      .limit(1);
    const providerBindings = await tx
      .select({
        enterpriseAccountId: enterpriseBillingSubscriptions.enterpriseAccountId,
        externalCustomerId: enterpriseBillingSubscriptions.externalCustomerId,
        externalSubscriptionId: enterpriseBillingSubscriptions.externalSubscriptionId,
      })
      .from(enterpriseBillingSubscriptions)
      .where(
        or(
          eq(enterpriseBillingSubscriptions.externalCustomerId, snapshot.customerId),
          eq(enterpriseBillingSubscriptions.externalSubscriptionId, snapshot.subscriptionId),
        ),
      );

    const customerOwnedByAnotherAccount =
      (customerAccountOwner && customerAccountOwner.enterpriseAccountId !== account.id) ||
      providerBindings.some(
        (binding) =>
          binding.externalCustomerId === snapshot.customerId &&
          binding.enterpriseAccountId !== account.id,
      );
    if (
      (account.externalCustomerId && account.externalCustomerId !== snapshot.customerId) ||
      customerOwnedByAnotherAccount
    ) {
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId: account.id,
        failureCode: "customer_mismatch",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "customer_mismatch",
      };
    }

    if (
      providerBindings.some(
        (binding) =>
          binding.externalSubscriptionId === snapshot.subscriptionId &&
          binding.enterpriseAccountId !== account.id,
      )
    ) {
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId: account.id,
        failureCode: "subscription_mismatch",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "subscription_mismatch",
      };
    }

    const [storedSubscription] = await tx
      .select()
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, account.id))
      .limit(1);
    const replacementAllowed =
      storedSubscription &&
      ["canceled", "incomplete_expired"].includes(storedSubscription.providerStatus);
    if (
      storedSubscription &&
      storedSubscription.externalSubscriptionId !== snapshot.subscriptionId &&
      !replacementAllowed
    ) {
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId: account.id,
        failureCode: "subscription_mismatch",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "subscription_mismatch",
      };
    }
    if (
      storedSubscription &&
      providerEventIsNotNewer(
        storedSubscription.lastProviderEventCreatedAt,
        storedSubscription.lastProviderEventId,
        eventCreatedAt,
        event.id,
      )
    ) {
      await markEvent(tx, event.id, {
        status: "ignored",
        enterpriseAccountId: account.id,
        failureCode: "stale_event",
      });
      return {
        status: "ignored",
        duplicate: false,
        failureCode: "stale_event",
      };
    }

    const [previousEntitlement] = await tx
      .select()
      .from(accountEntitlements)
      .where(
        and(
          eq(accountEntitlements.enterpriseAccountId, account.id),
          eq(accountEntitlements.featureKey, BUSINESS_GROUPS_FEATURE),
        ),
      )
      .limit(1);
    const transition = resolveEnterpriseStripeTransition(
      snapshot,
      event.type,
      eventCreatedAt,
      previousEntitlement,
    );
    const nextVersion = (previousEntitlement?.version ?? 0) + 1;
    const nextState = {
      status: transition.status,
      includedEntityLimit: snapshot.quantity,
      startsAt: transition.startsAt.toISOString(),
      endsAt: transition.endsAt.toISOString(),
      graceEndsAt: transition.graceEndsAt.toISOString(),
      version: nextVersion,
      provisioningSource: "stripe",
    };

    if (!account.externalCustomerId) {
      await tx
        .update(enterpriseAccounts)
        .set({ externalCustomerId: snapshot.customerId, updatedAt: new Date() })
        .where(eq(enterpriseAccounts.id, account.id));
    }

    await tx
      .insert(enterpriseBillingSubscriptions)
      .values({
        enterpriseAccountId: account.id,
        externalCustomerId: snapshot.customerId,
        externalSubscriptionId: snapshot.subscriptionId,
        externalPriceId: snapshot.priceId,
        quantity: snapshot.quantity,
        providerStatus: snapshot.providerStatus,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        lastProviderEventCreatedAt: eventCreatedAt,
        lastProviderEventId: event.id,
      })
      .onConflictDoUpdate({
        target: enterpriseBillingSubscriptions.enterpriseAccountId,
        set: {
          externalCustomerId: snapshot.customerId,
          externalSubscriptionId: snapshot.subscriptionId,
          externalPriceId: snapshot.priceId,
          quantity: snapshot.quantity,
          providerStatus: snapshot.providerStatus,
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          lastProviderEventCreatedAt: eventCreatedAt,
          lastProviderEventId: event.id,
          updatedAt: new Date(),
        },
      });

    let entitlementId: string;
    if (previousEntitlement) {
      entitlementId = previousEntitlement.id;
      await tx
        .update(accountEntitlements)
        .set({
          status: transition.status,
          includedEntityLimit: snapshot.quantity,
          provisioningSource: "stripe",
          startsAt: transition.startsAt,
          endsAt: transition.endsAt,
          graceEndsAt: transition.graceEndsAt,
          version: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(accountEntitlements.id, entitlementId));
    } else {
      const [created] = await tx
        .insert(accountEntitlements)
        .values({
          enterpriseAccountId: account.id,
          featureKey: BUSINESS_GROUPS_FEATURE,
          status: transition.status,
          includedEntityLimit: snapshot.quantity,
          provisioningSource: "stripe",
          startsAt: transition.startsAt,
          endsAt: transition.endsAt,
          graceEndsAt: transition.graceEndsAt,
        })
        .returning({ id: accountEntitlements.id });
      entitlementId = created.id;
    }

    await tx.insert(entitlementEvents).values({
      enterpriseAccountId: account.id,
      entitlementId,
      actorUserId: null,
      eventType: `entitlement.stripe.${event.type}`,
      reason: `Verified Stripe event ${event.id}`,
      previousState: previousEntitlement
        ? {
            status: previousEntitlement.status,
            includedEntityLimit: previousEntitlement.includedEntityLimit,
            startsAt: previousEntitlement.startsAt.toISOString(),
            endsAt: previousEntitlement.endsAt?.toISOString() ?? null,
            graceEndsAt: previousEntitlement.graceEndsAt?.toISOString() ?? null,
            version: previousEntitlement.version,
            provisioningSource: previousEntitlement.provisioningSource,
          }
        : null,
      nextState,
    });
    if (checkoutReservation && checkoutReservation.status !== "consumed") {
      await tx
        .update(enterpriseBillingCheckoutSessions)
        .set({
          status: "consumed",
          completedAt: checkoutReservation.completedAt ?? eventCreatedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(enterpriseBillingCheckoutSessions.id, checkoutReservation.id),
            inArray(enterpriseBillingCheckoutSessions.status, ["creating", "open", "completed"]),
          ),
        );
    }
    await markEvent(tx, event.id, {
      status: "processed",
      enterpriseAccountId: account.id,
    });
    return { status: "processed", duplicate: false };
  });
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  return subscription ? stringId(subscription) : null;
}

export async function processEnterpriseStripeEvent(
  stripe: Stripe,
  event: Stripe.Event,
  expectedPriceId: string,
): Promise<EnterpriseStripeProcessingResult> {
  const [recorded] = await dbAdmin
    .select({
      status: enterpriseBillingWebhookEvents.status,
      failureCode: enterpriseBillingWebhookEvents.failureCode,
    })
    .from(enterpriseBillingWebhookEvents)
    .where(eq(enterpriseBillingWebhookEvents.providerEventId, event.id))
    .limit(1);
  if (recorded?.status === "processed" || recorded?.status === "ignored") {
    return {
      status: recorded.status,
      duplicate: true,
      ...(recorded.failureCode ? { failureCode: recorded.failureCode } : {}),
    };
  }
  if (!RELEVANT_EVENT_TYPES.has(event.type)) return recordIgnoredEvent(event);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.expired") {
    return processEnterpriseCheckoutEvent(event);
  }

  let subscription: Stripe.Subscription;
  if (event.type.startsWith("customer.subscription.")) {
    const delivered = event.data.object as Stripe.Subscription;
    subscription =
      event.type === "customer.subscription.deleted"
        ? delivered
        : await stripe.subscriptions.retrieve(delivered.id);
  } else {
    const subscriptionId = invoiceSubscriptionId(event.data.object as Stripe.Invoice);
    if (!subscriptionId) return recordIgnoredEvent(event);
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  }

  let snapshot: EnterpriseStripeSubscriptionSnapshot;
  try {
    const checkoutReservationId = subscription.metadata.checkoutReservationId?.trim();
    snapshot = snapshotEnterpriseStripeSubscription(
      subscription,
      checkoutReservationId ? null : expectedPriceId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const failureCode = SUBSCRIPTION_FAILURE_CODES.has(message) ? message : "invalid_subscription";
    return recordIgnoredEvent(event, failureCode);
  }
  return applyEnterpriseStripeSubscription(event, snapshot);
}
