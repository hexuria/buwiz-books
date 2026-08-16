import type Stripe from "stripe";
import type { EntitlementStatus } from "../../db/schema/business-groups";
import { DEFAULT_ENTITLEMENT_GRACE_DAYS, resolveEntitlementState } from "./entitlement-state";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EnterpriseStripeSubscriptionSnapshot {
  enterpriseAccountId: string;
  checkoutReservationId?: string | null;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  quantity: number;
  providerStatus: Stripe.Subscription.Status;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export interface EnterpriseStripeTransition {
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date;
  graceEndsAt: Date;
}

export interface EnterpriseStripePriorEntitlement {
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  graceEndsAt: Date | null;
  provisioningSource: string;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function earlierDate(current: Date, previous: Date | null): Date {
  return previous && previous.getTime() < current.getTime() ? previous : current;
}

function lockedTransitionAtEvent(
  transition: EnterpriseStripeTransition,
  previous: EnterpriseStripePriorEntitlement,
  eventCreatedAt: Date,
): EnterpriseStripeTransition {
  const endsAt = earlierDate(eventCreatedAt, previous.endsAt);
  const candidateGraceEndsAt = earlierDate(eventCreatedAt, previous.graceEndsAt);
  return {
    ...transition,
    status: "locked",
    startsAt: earlierDate(transition.startsAt, previous.startsAt),
    endsAt,
    graceEndsAt: candidateGraceEndsAt.getTime() < endsAt.getTime() ? endsAt : candidateGraceEndsAt,
  };
}

function preserveContinuousNonWritableEpisode(
  transition: EnterpriseStripeTransition,
  previous: EnterpriseStripePriorEntitlement | undefined,
  eventCreatedAt: Date,
): EnterpriseStripeTransition {
  if (transition.status === "active" || !previous) return transition;
  const effectivePrevious = resolveEntitlementState(previous, eventCreatedAt);
  if (
    previous.status === "pending" ||
    effectivePrevious.status === "pending" ||
    effectivePrevious.status === "locked"
  ) {
    return lockedTransitionAtEvent(transition, previous, eventCreatedAt);
  }
  if (effectivePrevious.status === "active") return transition;
  return {
    ...transition,
    startsAt: earlierDate(transition.startsAt, previous.startsAt),
    endsAt: earlierDate(transition.endsAt, previous.endsAt),
    graceEndsAt: earlierDate(
      transition.graceEndsAt,
      previous.graceEndsAt ?? effectivePrevious.graceEndsAt,
    ),
  };
}

export function resolveEnterpriseStripeTransition(
  snapshot: EnterpriseStripeSubscriptionSnapshot,
  eventType: string,
  eventCreatedAt: Date,
  previous?: EnterpriseStripePriorEntitlement,
): EnterpriseStripeTransition {
  const immediateGrace =
    eventType === "invoice.payment_failed" ||
    ["past_due", "unpaid", "canceled"].includes(snapshot.providerStatus);
  if (immediateGrace) {
    return preserveContinuousNonWritableEpisode(
      {
        status: "grace",
        startsAt: snapshot.currentPeriodStart,
        endsAt: eventCreatedAt,
        graceEndsAt: addDays(eventCreatedAt, DEFAULT_ENTITLEMENT_GRACE_DAYS),
      },
      previous,
      eventCreatedAt,
    );
  }
  if (snapshot.providerStatus === "active" || snapshot.providerStatus === "trialing") {
    return {
      status: "active",
      startsAt: snapshot.currentPeriodStart,
      endsAt: snapshot.currentPeriodEnd,
      graceEndsAt: addDays(snapshot.currentPeriodEnd, DEFAULT_ENTITLEMENT_GRACE_DAYS),
    };
  }
  const locked: EnterpriseStripeTransition = {
    status: "locked",
    startsAt: snapshot.currentPeriodStart,
    endsAt: eventCreatedAt,
    graceEndsAt: eventCreatedAt,
  };
  return preserveContinuousNonWritableEpisode(locked, previous, eventCreatedAt);
}

function stringId(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

export function snapshotEnterpriseStripeSubscription(
  subscription: Stripe.Subscription,
  expectedPriceId: string | null,
): EnterpriseStripeSubscriptionSnapshot {
  const enterpriseAccountId = subscription.metadata.enterpriseAccountId?.trim();
  if (!enterpriseAccountId) throw new Error("missing_enterprise_account");
  if (!UUID_PATTERN.test(enterpriseAccountId)) throw new Error("invalid_enterprise_account");
  const checkoutReservationId = subscription.metadata.checkoutReservationId?.trim() || null;
  if (checkoutReservationId && !UUID_PATTERN.test(checkoutReservationId)) {
    throw new Error("invalid_checkout_reservation");
  }
  const matchingItems = expectedPriceId
    ? subscription.items.data.filter((item) => item.price.id === expectedPriceId)
    : subscription.items.data;
  if (matchingItems.length !== 1 || subscription.items.data.length !== 1) {
    throw new Error("unexpected_price_configuration");
  }
  const [item] = matchingItems;
  const quantity = item.quantity ?? 0;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("invalid_quantity");
  if (
    !Number.isSafeInteger(item.current_period_start) ||
    !Number.isSafeInteger(item.current_period_end)
  ) {
    throw new Error("invalid_billing_period");
  }
  const currentPeriodStart = new Date(item.current_period_start * 1000);
  const currentPeriodEnd = new Date(item.current_period_end * 1000);
  if (
    Number.isNaN(currentPeriodStart.getTime()) ||
    Number.isNaN(currentPeriodEnd.getTime()) ||
    currentPeriodEnd <= currentPeriodStart
  ) {
    throw new Error("invalid_billing_period");
  }
  return {
    enterpriseAccountId,
    checkoutReservationId,
    customerId: stringId(subscription.customer),
    subscriptionId: subscription.id,
    priceId: item.price.id,
    quantity,
    providerStatus: subscription.status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}
