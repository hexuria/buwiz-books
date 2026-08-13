import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  resolveEnterpriseStripeTransition,
  snapshotEnterpriseStripeSubscription,
  type EnterpriseStripePriorEntitlement,
  type EnterpriseStripeSubscriptionSnapshot,
} from "../../src/lib/enterprise/stripe-entitlement-policy";
import { resolveEntitlementState } from "../../src/lib/enterprise/entitlement-state";

const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-09-01T00:00:00.000Z");
const eventAt = new Date("2026-08-12T12:00:00.000Z");

function snapshot(
  overrides: Partial<EnterpriseStripeSubscriptionSnapshot> = {},
): EnterpriseStripeSubscriptionSnapshot {
  return {
    enterpriseAccountId: "11111111-1111-4111-8111-111111111111",
    checkoutReservationId: null,
    customerId: "cus_enterprise",
    subscriptionId: "sub_enterprise",
    priceId: "price_enterprise",
    quantity: 25,
    providerStatus: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function priorEntitlement(
  overrides: Partial<EnterpriseStripePriorEntitlement> = {},
): EnterpriseStripePriorEntitlement {
  return {
    status: "grace",
    startsAt: periodStart,
    endsAt: eventAt,
    graceEndsAt: new Date("2026-09-11T12:00:00.000Z"),
    provisioningSource: "stripe",
    ...overrides,
  };
}

describe("Enterprise Stripe entitlement transitions", () => {
  it("keeps a paid subscription active through its current period", () => {
    expect(resolveEnterpriseStripeTransition(snapshot(), "invoice.paid", eventAt)).toEqual({
      status: "active",
      startsAt: periodStart,
      endsAt: periodEnd,
      graceEndsAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  it.each([
    ["invoice.payment_failed", snapshot()],
    ["customer.subscription.deleted", snapshot({ providerStatus: "canceled" })],
  ])("enters immediate read-only grace for %s", (eventType, subscription) => {
    expect(resolveEnterpriseStripeTransition(subscription, eventType, eventAt)).toEqual({
      status: "grace",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: new Date("2026-09-11T12:00:00.000Z"),
    });
  });

  it("keeps an active scheduled cancellation writable through the paid period", () => {
    const transition = resolveEnterpriseStripeTransition(
      snapshot({ cancelAtPeriodEnd: true }),
      "customer.subscription.updated",
      eventAt,
    );

    expect(transition).toEqual({
      status: "active",
      startsAt: periodStart,
      endsAt: periodEnd,
      graceEndsAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(resolveEntitlementState(transition, new Date("2026-08-20T00:00:00.000Z"))).toMatchObject(
      { status: "active", isEntitled: true, isReadOnly: false },
    );
    expect(resolveEntitlementState(transition, new Date("2026-09-02T00:00:00.000Z"))).toMatchObject(
      { status: "grace", isEntitled: true, isReadOnly: true },
    );
  });

  it("returns to active after payment recovery clears the failure state", () => {
    expect(
      resolveEnterpriseStripeTransition(
        snapshot({ providerStatus: "active", cancelAtPeriodEnd: false }),
        "invoice.paid",
        eventAt,
      ).status,
    ).toBe("active");
  });

  it("does not extend an uninterrupted delinquency episode", () => {
    const laterFailure = new Date("2026-09-12T00:00:00.000Z");
    expect(
      resolveEnterpriseStripeTransition(
        snapshot({ providerStatus: "unpaid" }),
        "customer.subscription.updated",
        laterFailure,
        priorEntitlement(),
      ),
    ).toEqual({
      status: "locked",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: new Date("2026-09-11T12:00:00.000Z"),
    });
  });

  it("preserves contract-source grace deadlines on a later failure", () => {
    const laterFailure = new Date("2026-08-20T00:00:00.000Z");
    expect(
      resolveEnterpriseStripeTransition(
        snapshot(),
        "invoice.payment_failed",
        laterFailure,
        priorEntitlement({ provisioningSource: "contract" }),
      ),
    ).toEqual({
      status: "grace",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: new Date("2026-09-11T12:00:00.000Z"),
    });
  });

  it("allows contract-source effective active access to enter its first grace", () => {
    expect(
      resolveEnterpriseStripeTransition(
        snapshot(),
        "invoice.payment_failed",
        eventAt,
        priorEntitlement({
          status: "active",
          endsAt: periodEnd,
          graceEndsAt: new Date("2026-10-01T00:00:00.000Z"),
          provisioningSource: "contract",
        }),
      ),
    ).toEqual({
      status: "grace",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: new Date("2026-09-11T12:00:00.000Z"),
    });
  });

  it("keeps a contract-source locked entitlement with null dates locked on failure", () => {
    expect(
      resolveEnterpriseStripeTransition(
        snapshot(),
        "invoice.payment_failed",
        eventAt,
        priorEntitlement({
          status: "locked",
          endsAt: null,
          graceEndsAt: null,
          provisioningSource: "contract",
        }),
      ),
    ).toEqual({
      status: "locked",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: eventAt,
    });
  });

  it("clamps contract-source future locked deadlines to the failure event", () => {
    expect(
      resolveEnterpriseStripeTransition(
        snapshot(),
        "invoice.payment_failed",
        eventAt,
        priorEntitlement({
          status: "locked",
          endsAt: new Date("2026-09-01T00:00:00.000Z"),
          graceEndsAt: new Date("2026-10-01T00:00:00.000Z"),
          provisioningSource: "contract",
        }),
      ),
    ).toEqual({
      status: "locked",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: eventAt,
    });
  });

  it("does not grant grace when a contract-source pending entitlement fails", () => {
    expect(
      resolveEnterpriseStripeTransition(
        snapshot(),
        "invoice.payment_failed",
        eventAt,
        priorEntitlement({
          status: "pending",
          startsAt: new Date("2026-09-01T00:00:00.000Z"),
          endsAt: new Date("2026-10-01T00:00:00.000Z"),
          graceEndsAt: new Date("2026-10-31T00:00:00.000Z"),
          provisioningSource: "contract",
        }),
      ),
    ).toEqual({
      status: "locked",
      startsAt: periodStart,
      endsAt: eventAt,
      graceEndsAt: eventAt,
    });
  });

  it.each(["active", "trialing"] as const)(
    "lets a verified %s state reset a prior delinquency episode",
    (providerStatus) => {
      const recoveredPeriodStart = new Date("2026-09-01T00:00:00.000Z");
      const recoveredPeriodEnd = new Date("2026-10-01T00:00:00.000Z");
      expect(
        resolveEnterpriseStripeTransition(
          snapshot({
            providerStatus,
            currentPeriodStart: recoveredPeriodStart,
            currentPeriodEnd: recoveredPeriodEnd,
          }),
          "invoice.paid",
          new Date("2026-09-12T00:00:01.000Z"),
          priorEntitlement({ provisioningSource: "contract" }),
        ),
      ).toEqual({
        status: "active",
        startsAt: recoveredPeriodStart,
        endsAt: recoveredPeriodEnd,
        graceEndsAt: new Date("2026-10-31T00:00:00.000Z"),
      });
    },
  );

  it("locks terminal incomplete subscriptions", () => {
    expect(
      resolveEnterpriseStripeTransition(
        snapshot({ providerStatus: "incomplete_expired" }),
        "customer.subscription.updated",
        eventAt,
      ),
    ).toMatchObject({ status: "locked", endsAt: eventAt, graceEndsAt: eventAt });
  });

  it("stores provider incomplete as non-auto-activating locked access", () => {
    const transition = resolveEnterpriseStripeTransition(
      snapshot({ providerStatus: "incomplete" }),
      "customer.subscription.created",
      eventAt,
    );

    expect(transition).toMatchObject({
      status: "locked",
      endsAt: eventAt,
      graceEndsAt: eventAt,
    });
    expect(resolveEntitlementState(transition, new Date("2026-08-20T00:00:00.000Z"))).toMatchObject(
      { status: "locked", isEntitled: false, isReadOnly: false },
    );
  });
});

describe("Stripe subscription snapshot validation", () => {
  function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
    return {
      id: "sub_enterprise",
      customer: "cus_enterprise",
      status: "active",
      cancel_at_period_end: false,
      metadata: { enterpriseAccountId: "11111111-1111-4111-8111-111111111111" },
      items: {
        data: [
          {
            price: { id: "price_enterprise" },
            quantity: 25,
            current_period_start: Math.floor(periodStart.getTime() / 1000),
            current_period_end: Math.floor(periodEnd.getTime() / 1000),
          },
        ],
      },
      ...overrides,
    } as unknown as Stripe.Subscription;
  }

  it("maps one configured recurring item to the linked-business allowance", () => {
    expect(snapshotEnterpriseStripeSubscription(subscription(), "price_enterprise")).toEqual(
      snapshot(),
    );
  });

  it("fails closed for a missing account binding", () => {
    expect(() =>
      snapshotEnterpriseStripeSubscription(subscription({ metadata: {} }), "price_enterprise"),
    ).toThrow("missing_enterprise_account");
    expect(() =>
      snapshotEnterpriseStripeSubscription(
        subscription({ metadata: { enterpriseAccountId: "not-a-uuid" } }),
        "price_enterprise",
      ),
    ).toThrow("invalid_enterprise_account");
  });

  it("fails closed for an invalid Checkout reservation binding", () => {
    expect(() =>
      snapshotEnterpriseStripeSubscription(
        subscription({
          metadata: {
            enterpriseAccountId: "11111111-1111-4111-8111-111111111111",
            checkoutReservationId: "not-a-uuid",
          },
        }),
        "price_enterprise",
      ),
    ).toThrow("invalid_checkout_reservation");
  });

  it("fails closed for an unexpected or multi-item catalog", () => {
    expect(() => snapshotEnterpriseStripeSubscription(subscription(), "price_other")).toThrow(
      "unexpected_price_configuration",
    );
    expect(() =>
      snapshotEnterpriseStripeSubscription(
        subscription({
          items: {
            data: [
              ...subscription().items.data,
              { ...subscription().items.data[0], price: { id: "price_other" } },
            ],
          },
        }),
        "price_enterprise",
      ),
    ).toThrow("unexpected_price_configuration");
  });

  it("rejects a missing or non-positive quantity", () => {
    const base = subscription();
    expect(() =>
      snapshotEnterpriseStripeSubscription(
        subscription({ items: { data: [{ ...base.items.data[0], quantity: 0 }] } }),
        "price_enterprise",
      ),
    ).toThrow("invalid_quantity");
  });

  it("rejects reversed or out-of-range provider billing periods", () => {
    const base = subscription();
    expect(() =>
      snapshotEnterpriseStripeSubscription(
        subscription({
          items: {
            data: [
              {
                ...base.items.data[0],
                current_period_end: base.items.data[0].current_period_start,
              },
            ],
          },
        }),
        "price_enterprise",
      ),
    ).toThrow("invalid_billing_period");
    expect(() =>
      snapshotEnterpriseStripeSubscription(
        subscription({
          items: {
            data: [
              {
                ...base.items.data[0],
                current_period_end: Number.MAX_SAFE_INTEGER,
              },
            ],
          },
        }),
        "price_enterprise",
      ),
    ).toThrow("invalid_billing_period");
  });
});
