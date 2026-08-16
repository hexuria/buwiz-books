import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { dbAdmin } from "../../src/db";
import { user } from "../../src/db/schema/auth";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
  enterpriseBillingSubscriptions,
  enterpriseBillingWebhookEvents,
  entitlementEvents,
} from "../../src/db/schema/business-groups";
import {
  applyEnterpriseStripeSubscription,
  processEnterpriseStripeEvent,
  type EnterpriseStripeSubscriptionSnapshot,
} from "../../src/lib/enterprise/stripe-entitlements";
import { resolveEntitlementState } from "../../src/lib/enterprise/entitlement-state";
import { lockEnterpriseAllowance } from "../../src/lib/enterprise/entitlements";

describe("Stripe-managed Enterprise entitlements", () => {
  let enterpriseAccountId: string;
  let enterpriseAccountIds: string[];
  let memberUserId: string;
  let outsiderUserId: string;
  const periodStart = new Date("2026-08-01T00:00:00.000Z");
  const periodEnd = new Date("2026-09-01T00:00:00.000Z");

  beforeEach(async () => {
    const suffix = crypto.randomUUID();
    memberUserId = `stripe-member-${suffix}`;
    outsiderUserId = `stripe-outsider-${suffix}`;
    await dbAdmin.insert(user).values([
      {
        id: memberUserId,
        name: "Stripe Enterprise Member",
        email: `${memberUserId}@test.local`,
        emailVerified: true,
      },
      {
        id: outsiderUserId,
        name: "Stripe Enterprise Outsider",
        email: `${outsiderUserId}@test.local`,
        emailVerified: true,
      },
    ]);
    const [account] = await dbAdmin
      .insert(enterpriseAccounts)
      .values({ name: `Stripe test ${suffix}`, createdBy: memberUserId })
      .returning({ id: enterpriseAccounts.id });
    enterpriseAccountId = account.id;
    enterpriseAccountIds = [account.id];
    await dbAdmin.insert(enterpriseAccountMembers).values({
      enterpriseAccountId,
      userId: memberUserId,
      role: "billing_admin",
    });
  });

  afterEach(async () => {
    await dbAdmin
      .delete(enterpriseAccounts)
      .where(inArray(enterpriseAccounts.id, enterpriseAccountIds));
    await dbAdmin.delete(user).where(inArray(user.id, [memberUserId, outsiderUserId]));
  });

  function snapshot(
    overrides: Partial<EnterpriseStripeSubscriptionSnapshot> = {},
  ): EnterpriseStripeSubscriptionSnapshot {
    const accountId = overrides.enterpriseAccountId ?? enterpriseAccountId;
    return {
      enterpriseAccountId: accountId,
      customerId: `cus_${accountId}`,
      subscriptionId: `sub_${accountId}`,
      priceId: "price_enterprise",
      quantity: 12,
      providerStatus: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      ...overrides,
    };
  }

  function event(id: string, type: Stripe.Event.Type, created: number) {
    return { id, type, created } as Pick<Stripe.Event, "id" | "type" | "created">;
  }

  async function createAdditionalAccount(): Promise<string> {
    const [account] = await dbAdmin
      .insert(enterpriseAccounts)
      .values({ name: `Stripe ordering ${crypto.randomUUID()}` })
      .returning({ id: enterpriseAccounts.id });
    enterpriseAccountIds.push(account.id);
    return account.id;
  }

  async function asRuntimeUser<T>(userId: string, operation: (tx: any) => Promise<T>) {
    return dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      return operation(tx);
    });
  }

  it("applies, audits, and exactly-once replays a subscription event", async () => {
    const created = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    const delivery = event(
      `evt_active_${enterpriseAccountId}`,
      "customer.subscription.updated",
      created,
    );

    await expect(applyEnterpriseStripeSubscription(delivery, snapshot())).resolves.toEqual({
      status: "processed",
      duplicate: false,
    });
    await expect(applyEnterpriseStripeSubscription(delivery, snapshot())).resolves.toEqual({
      status: "processed",
      duplicate: true,
    });

    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({
      status: "active",
      includedEntityLimit: 12,
      provisioningSource: "stripe",
      version: 1,
    });

    const [subscription] = await dbAdmin
      .select()
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId));
    expect(subscription).toMatchObject({
      externalPriceId: "price_enterprise",
      quantity: 12,
      providerStatus: "active",
    });

    const [auditCount] = await dbAdmin
      .select({ count: sql<number>`count(*)::int` })
      .from(entitlementEvents)
      .where(eq(entitlementEvents.enterpriseAccountId, enterpriseAccountId));
    expect(auditCount.count).toBe(1);
  });

  it("anchors repeated payment failures to the first grace deadline", async () => {
    const firstAt = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    const failedAt = Math.floor(new Date("2026-08-12T12:00:00.000Z").getTime() / 1000);
    const repeatedFailureAt = failedAt + 86_400;
    const staleAt = failedAt - 60;
    await applyEnterpriseStripeSubscription(
      event(`evt_first_${enterpriseAccountId}`, "customer.subscription.updated", firstAt),
      snapshot(),
    );
    await applyEnterpriseStripeSubscription(
      event(`evt_failed_${enterpriseAccountId}`, "invoice.payment_failed", failedAt),
      snapshot(),
    );
    await applyEnterpriseStripeSubscription(
      event(`evt_failed_again_${enterpriseAccountId}`, "invoice.payment_failed", repeatedFailureAt),
      snapshot(),
    );

    await expect(
      applyEnterpriseStripeSubscription(
        event(`evt_stale_${enterpriseAccountId}`, "customer.subscription.updated", staleAt),
        snapshot({ quantity: 99 }),
      ),
    ).resolves.toMatchObject({ status: "ignored", failureCode: "stale_event" });

    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "grace", includedEntityLimit: 12, version: 3 });
    expect(entitlement.endsAt?.toISOString()).toBe("2026-08-12T12:00:00.000Z");
    expect(entitlement.graceEndsAt?.toISOString()).toBe("2026-09-11T12:00:00.000Z");
  });

  it("preserves one delinquency episode from past_due through unpaid", async () => {
    const firstAt = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    const pastDueAt = Math.floor(new Date("2026-08-12T12:00:00.000Z").getTime() / 1000);
    const unpaidAt = Math.floor(new Date("2026-08-20T12:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      event(`evt_active_before_past_due_${enterpriseAccountId}`, "invoice.paid", firstAt),
      snapshot(),
    );
    await applyEnterpriseStripeSubscription(
      event(`evt_past_due_${enterpriseAccountId}`, "customer.subscription.updated", pastDueAt),
      snapshot({ providerStatus: "past_due" }),
    );
    await applyEnterpriseStripeSubscription(
      event(`evt_unpaid_${enterpriseAccountId}`, "customer.subscription.updated", unpaidAt),
      snapshot({ providerStatus: "unpaid" }),
    );

    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "grace", version: 3 });
    expect(entitlement.endsAt?.toISOString()).toBe("2026-08-12T12:00:00.000Z");
    expect(entitlement.graceEndsAt?.toISOString()).toBe("2026-09-11T12:00:00.000Z");
  });

  it("does not reopen expired grace until verified payment recovery", async () => {
    const firstAt = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    const failedAt = Math.floor(new Date("2026-08-12T12:00:00.000Z").getTime() / 1000);
    const afterGraceAt = Math.floor(new Date("2026-09-12T00:00:00.000Z").getTime() / 1000);
    const recoveredAt = afterGraceAt + 1;
    const nextFailureAt = Math.floor(new Date("2026-09-13T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      event(`evt_active_before_expiry_${enterpriseAccountId}`, "invoice.paid", firstAt),
      snapshot(),
    );
    await applyEnterpriseStripeSubscription(
      event(`evt_failed_before_expiry_${enterpriseAccountId}`, "invoice.payment_failed", failedAt),
      snapshot(),
    );

    let [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(resolveEntitlementState(entitlement, new Date(afterGraceAt * 1000))).toMatchObject({
      status: "locked",
      isEntitled: false,
    });

    await applyEnterpriseStripeSubscription(
      event(
        `evt_unpaid_after_expiry_${enterpriseAccountId}`,
        "customer.subscription.updated",
        afterGraceAt,
      ),
      snapshot({ providerStatus: "unpaid" }),
    );
    [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "locked", version: 3 });
    expect(entitlement.endsAt?.toISOString()).toBe("2026-08-12T12:00:00.000Z");
    expect(entitlement.graceEndsAt?.toISOString()).toBe("2026-09-11T12:00:00.000Z");
    expect(resolveEntitlementState(entitlement, new Date(afterGraceAt * 1000))).toMatchObject({
      status: "locked",
      isEntitled: false,
    });

    await applyEnterpriseStripeSubscription(
      event(`evt_recovered_${enterpriseAccountId}`, "invoice.paid", recoveredAt),
      snapshot({
        providerStatus: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "active", includedEntityLimit: 12, version: 4 });
    expect(entitlement.endsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    await applyEnterpriseStripeSubscription(
      event(
        `evt_new_failure_after_recovery_${enterpriseAccountId}`,
        "invoice.payment_failed",
        nextFailureAt,
      ),
      snapshot({
        providerStatus: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "grace", version: 5 });
    expect(entitlement.endsAt?.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(entitlement.graceEndsAt?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("records a customer mismatch without mutating the entitlement", async () => {
    const created = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      event(`evt_owner_${enterpriseAccountId}`, "customer.subscription.updated", created),
      snapshot(),
    );
    const result = await applyEnterpriseStripeSubscription(
      event(`evt_mismatch_${enterpriseAccountId}`, "customer.subscription.updated", created + 1),
      snapshot({ customerId: "cus_attacker" }),
    );
    expect(result).toMatchObject({ status: "ignored", failureCode: "customer_mismatch" });

    const [delivery] = await dbAdmin
      .select()
      .from(enterpriseBillingWebhookEvents)
      .where(
        eq(enterpriseBillingWebhookEvents.providerEventId, `evt_mismatch_${enterpriseAccountId}`),
      );
    expect(delivery).toMatchObject({ status: "ignored", failureCode: "customer_mismatch" });

    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "active", includedEntityLimit: 12, version: 1 });
  });

  it("quarantines customer and subscription identifiers bound to another account", async () => {
    const created = Math.floor(new Date("2026-08-03T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      event(`evt_binding_owner_${enterpriseAccountId}`, "customer.subscription.updated", created),
      snapshot(),
    );
    const customerTargetId = await createAdditionalAccount();
    const subscriptionTargetId = await createAdditionalAccount();

    const customerMismatch = await applyEnterpriseStripeSubscription(
      event(`evt_cross_customer_${customerTargetId}`, "customer.subscription.updated", created + 1),
      snapshot({
        enterpriseAccountId: customerTargetId,
        customerId: `cus_${enterpriseAccountId}`,
        subscriptionId: `sub_distinct_${customerTargetId}`,
      }),
    );
    const subscriptionMismatchEvent = event(
      `evt_cross_subscription_${subscriptionTargetId}`,
      "customer.subscription.updated",
      created + 2,
    );
    const subscriptionMismatch = await applyEnterpriseStripeSubscription(
      subscriptionMismatchEvent,
      snapshot({
        enterpriseAccountId: subscriptionTargetId,
        customerId: `cus_distinct_${subscriptionTargetId}`,
        subscriptionId: `sub_${enterpriseAccountId}`,
      }),
    );

    expect(customerMismatch).toEqual({
      status: "ignored",
      duplicate: false,
      failureCode: "customer_mismatch",
    });
    expect(subscriptionMismatch).toEqual({
      status: "ignored",
      duplicate: false,
      failureCode: "subscription_mismatch",
    });
    await expect(
      applyEnterpriseStripeSubscription(
        subscriptionMismatchEvent,
        snapshot({
          enterpriseAccountId: subscriptionTargetId,
          customerId: `cus_distinct_${subscriptionTargetId}`,
          subscriptionId: `sub_${enterpriseAccountId}`,
        }),
      ),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: true,
      failureCode: "subscription_mismatch",
    });

    const quarantined = await dbAdmin
      .select({
        status: enterpriseBillingWebhookEvents.status,
        failureCode: enterpriseBillingWebhookEvents.failureCode,
      })
      .from(enterpriseBillingWebhookEvents)
      .where(
        inArray(enterpriseBillingWebhookEvents.providerEventId, [
          `evt_cross_customer_${customerTargetId}`,
          subscriptionMismatchEvent.id,
        ]),
      );
    expect(quarantined).toHaveLength(2);
    expect(quarantined.every(({ status }) => status === "ignored")).toBe(true);
    expect(quarantined.map(({ failureCode }) => failureCode).sort()).toEqual([
      "customer_mismatch",
      "subscription_mismatch",
    ]);
    const targetEntitlements = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(
        inArray(accountEntitlements.enterpriseAccountId, [customerTargetId, subscriptionTargetId]),
      );
    expect(targetEntitlements).toEqual([]);
  });

  it("serializes concurrent cross-account provider identifier claims", async () => {
    const secondAccountId = await createAdditionalAccount();
    const thirdAccountId = await createAdditionalAccount();
    const fourthAccountId = await createAdditionalAccount();
    const created = Math.floor(new Date("2026-08-03T12:00:00.000Z").getTime() / 1000);
    const sharedCustomerId = `cus_race_${crypto.randomUUID()}`;
    const sharedSubscriptionId = `sub_race_${crypto.randomUUID()}`;

    const customerRace = await Promise.all([
      applyEnterpriseStripeSubscription(
        event(
          `evt_customer_race_a_${enterpriseAccountId}`,
          "customer.subscription.updated",
          created,
        ),
        snapshot({
          customerId: sharedCustomerId,
          subscriptionId: `sub_customer_race_${enterpriseAccountId}`,
        }),
      ),
      applyEnterpriseStripeSubscription(
        event(`evt_customer_race_b_${secondAccountId}`, "customer.subscription.updated", created),
        snapshot({
          enterpriseAccountId: secondAccountId,
          customerId: sharedCustomerId,
          subscriptionId: `sub_customer_race_${secondAccountId}`,
        }),
      ),
    ]);
    const subscriptionRace = await Promise.all([
      applyEnterpriseStripeSubscription(
        event(
          `evt_subscription_race_a_${thirdAccountId}`,
          "customer.subscription.updated",
          created,
        ),
        snapshot({
          enterpriseAccountId: thirdAccountId,
          customerId: `cus_subscription_race_${thirdAccountId}`,
          subscriptionId: sharedSubscriptionId,
        }),
      ),
      applyEnterpriseStripeSubscription(
        event(
          `evt_subscription_race_b_${fourthAccountId}`,
          "customer.subscription.updated",
          created,
        ),
        snapshot({
          enterpriseAccountId: fourthAccountId,
          customerId: `cus_subscription_race_${fourthAccountId}`,
          subscriptionId: sharedSubscriptionId,
        }),
      ),
    ]);

    expect(customerRace.filter(({ status }) => status === "processed")).toHaveLength(1);
    expect(
      customerRace.filter(({ failureCode }) => failureCode === "customer_mismatch"),
    ).toHaveLength(1);
    expect(subscriptionRace.filter(({ status }) => status === "processed")).toHaveLength(1);
    expect(
      subscriptionRace.filter(({ failureCode }) => failureCode === "subscription_mismatch"),
    ).toHaveLength(1);
    const subscriptions = await dbAdmin
      .select()
      .from(enterpriseBillingSubscriptions)
      .where(
        inArray(enterpriseBillingSubscriptions.enterpriseAccountId, [
          enterpriseAccountId,
          secondAccountId,
          thirdAccountId,
          fourthAccountId,
        ]),
      );
    expect(subscriptions).toHaveLength(2);
  });

  it("rejects a second live subscription and ignores a late event from a replaced subscription", async () => {
    const firstAt = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      event(
        `evt_first_subscription_${enterpriseAccountId}`,
        "customer.subscription.updated",
        firstAt,
      ),
      snapshot(),
    );

    await expect(
      applyEnterpriseStripeSubscription(
        event(
          `evt_parallel_subscription_${enterpriseAccountId}`,
          "customer.subscription.created",
          firstAt + 1,
        ),
        snapshot({ subscriptionId: `sub_parallel_${enterpriseAccountId}` }),
      ),
    ).resolves.toMatchObject({ status: "ignored", failureCode: "subscription_mismatch" });

    await applyEnterpriseStripeSubscription(
      event(`evt_cancel_old_${enterpriseAccountId}`, "customer.subscription.deleted", firstAt + 2),
      snapshot({ providerStatus: "canceled" }),
    );
    await expect(
      applyEnterpriseStripeSubscription(
        event(
          `evt_replace_subscription_${enterpriseAccountId}`,
          "customer.subscription.created",
          firstAt + 3,
        ),
        snapshot({ subscriptionId: `sub_replacement_${enterpriseAccountId}` }),
      ),
    ).resolves.toMatchObject({ status: "processed" });

    await expect(
      applyEnterpriseStripeSubscription(
        event(`evt_late_old_${enterpriseAccountId}`, "customer.subscription.deleted", firstAt + 4),
        snapshot({ providerStatus: "canceled" }),
      ),
    ).resolves.toMatchObject({ status: "ignored", failureCode: "subscription_mismatch" });

    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "active", version: 3 });

    const [lateDelivery] = await dbAdmin
      .select()
      .from(enterpriseBillingWebhookEvents)
      .where(
        eq(enterpriseBillingWebhookEvents.providerEventId, `evt_late_old_${enterpriseAccountId}`),
      );
    expect(lateDelivery).toMatchObject({
      status: "ignored",
      failureCode: "subscription_mismatch",
    });
  });

  it("serializes concurrent distinct events so the newer event wins with monotonic versions", async () => {
    const olderAt = Math.floor(new Date("2026-08-04T00:00:00.000Z").getTime() / 1000);
    const newerAt = olderAt + 1;

    const [olderResult, newerResult] = await Promise.all([
      applyEnterpriseStripeSubscription(
        event(
          `evt_concurrent_old_${enterpriseAccountId}`,
          "customer.subscription.updated",
          olderAt,
        ),
        snapshot({ quantity: 15 }),
      ),
      applyEnterpriseStripeSubscription(
        event(
          `evt_concurrent_new_${enterpriseAccountId}`,
          "customer.subscription.updated",
          newerAt,
        ),
        snapshot({ quantity: 29 }),
      ),
    ]);

    expect(newerResult.status).toBe("processed");
    expect(["processed", "ignored"]).toContain(olderResult.status);
    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    const [subscription] = await dbAdmin
      .select()
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ status: "active", includedEntityLimit: 29 });
    expect(subscription).toMatchObject({
      quantity: 29,
      lastProviderEventId: `evt_concurrent_new_${enterpriseAccountId}`,
    });

    const auditRows = await dbAdmin
      .select({ nextState: entitlementEvents.nextState })
      .from(entitlementEvents)
      .where(eq(entitlementEvents.enterpriseAccountId, enterpriseAccountId));
    const versions = auditRows
      .map(({ nextState }) => Number(nextState.version))
      .sort((left, right) => left - right);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
    expect(entitlement.version).toBe(versions.at(-1));
  });

  it("waits at the shared allowance boundary before mutating subscription state", async () => {
    let signalAllowanceLocked!: () => void;
    let releaseAllowance!: () => void;
    const allowanceLocked = new Promise<void>((resolve) => {
      signalAllowanceLocked = resolve;
    });
    const allowanceRelease = new Promise<void>((resolve) => {
      releaseAllowance = resolve;
    });
    const holder = dbAdmin.transaction(async (tx) => {
      await lockEnterpriseAllowance(tx, enterpriseAccountId);
      signalAllowanceLocked();
      await allowanceRelease;
    });
    await allowanceLocked;

    const created = Math.floor(new Date("2026-08-04T12:00:00.000Z").getTime() / 1000);
    const provider = applyEnterpriseStripeSubscription(
      event(`evt_allowance_wait_${enterpriseAccountId}`, "customer.subscription.updated", created),
      snapshot({ quantity: 27 }),
    );

    let observedAdvisoryWait = false;
    for (let attempt = 0; attempt < 100 && !observedAdvisoryWait; attempt += 1) {
      const result = await dbAdmin.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
        ) AS waiting
      `);
      observedAdvisoryWait = Boolean(
        (result as unknown as Array<{ waiting: boolean }>)[0]?.waiting,
      );
      if (!observedAdvisoryWait) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const beforeRelease = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    releaseAllowance();
    const [, providerResult] = await Promise.all([holder, provider]);

    expect(observedAdvisoryWait).toBe(true);
    expect(beforeRelease).toEqual([]);
    expect(providerResult).toEqual({ status: "processed", duplicate: false });
    const [entitlement] = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlement).toMatchObject({ includedEntityLimit: 27, version: 1 });
  });

  it("uses event ID as a deterministic tie-break for equal-second deliveries", async () => {
    const secondAccountId = await createAdditionalAccount();
    const created = Math.floor(new Date("2026-08-05T00:00:00.000Z").getTime() / 1000);
    const firstLow = event(
      `evt_tie_a_${enterpriseAccountId}`,
      "customer.subscription.updated",
      created,
    );
    const firstHigh = event(
      `evt_tie_z_${enterpriseAccountId}`,
      "customer.subscription.updated",
      created,
    );
    await applyEnterpriseStripeSubscription(firstLow, snapshot({ quantity: 13 }));
    await applyEnterpriseStripeSubscription(firstHigh, snapshot({ quantity: 31 }));

    const secondHigh = event(
      `evt_tie_z_${secondAccountId}`,
      "customer.subscription.updated",
      created,
    );
    const secondLow = event(
      `evt_tie_a_${secondAccountId}`,
      "customer.subscription.updated",
      created,
    );
    await applyEnterpriseStripeSubscription(
      secondHigh,
      snapshot({ enterpriseAccountId: secondAccountId, quantity: 31 }),
    );
    await expect(
      applyEnterpriseStripeSubscription(
        secondLow,
        snapshot({ enterpriseAccountId: secondAccountId, quantity: 13 }),
      ),
    ).resolves.toMatchObject({ status: "ignored", failureCode: "stale_event" });

    const states = await dbAdmin
      .select({
        enterpriseAccountId: accountEntitlements.enterpriseAccountId,
        includedEntityLimit: accountEntitlements.includedEntityLimit,
      })
      .from(accountEntitlements)
      .where(
        inArray(accountEntitlements.enterpriseAccountId, [enterpriseAccountId, secondAccountId]),
      );
    expect(states).toHaveLength(2);
    expect(states.every((state) => state.includedEntityLimit === 31)).toBe(true);

    const subscriptions = await dbAdmin
      .select({
        enterpriseAccountId: enterpriseBillingSubscriptions.enterpriseAccountId,
        lastProviderEventId: enterpriseBillingSubscriptions.lastProviderEventId,
      })
      .from(enterpriseBillingSubscriptions)
      .where(
        inArray(enterpriseBillingSubscriptions.enterpriseAccountId, [
          enterpriseAccountId,
          secondAccountId,
        ]),
      );
    expect(subscriptions).toHaveLength(2);
    expect(
      subscriptions.every((subscription) =>
        subscription.lastProviderEventId.startsWith("evt_tie_z_"),
      ),
    ).toBe(true);
  });

  it("acknowledges an invalid signed subscription configuration without entitlement mutation", async () => {
    const created = Math.floor(new Date("2026-08-06T00:00:00.000Z").getTime() / 1000);
    const providerEvent = {
      id: `evt_invalid_price_${enterpriseAccountId}`,
      type: "customer.subscription.updated",
      created,
      data: { object: { id: `sub_${enterpriseAccountId}` } },
    } as unknown as Stripe.Event;
    const invalidSubscription = {
      id: `sub_${enterpriseAccountId}`,
      customer: `cus_${enterpriseAccountId}`,
      status: "active",
      cancel_at_period_end: false,
      metadata: { enterpriseAccountId },
      items: {
        data: [
          {
            price: { id: "price_unconfigured" },
            quantity: 12,
            current_period_start: Math.floor(periodStart.getTime() / 1000),
            current_period_end: Math.floor(periodEnd.getTime() / 1000),
          },
        ],
      },
    } as unknown as Stripe.Subscription;
    const stripe = {
      subscriptions: { retrieve: async () => invalidSubscription },
    } as unknown as Stripe;

    await expect(
      processEnterpriseStripeEvent(stripe, providerEvent, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: false,
      failureCode: "unexpected_price_configuration",
    });
    await expect(
      processEnterpriseStripeEvent(stripe, providerEvent, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: true,
      failureCode: "unexpected_price_configuration",
    });
    const [delivery] = await dbAdmin
      .select()
      .from(enterpriseBillingWebhookEvents)
      .where(eq(enterpriseBillingWebhookEvents.providerEventId, providerEvent.id));
    expect(delivery).toMatchObject({
      status: "ignored",
      failureCode: "unexpected_price_configuration",
    });

    const malformedEvent = {
      ...providerEvent,
      id: `evt_malformed_subscription_${enterpriseAccountId}`,
    } as Stripe.Event;
    const malformedStripe = {
      subscriptions: {
        retrieve: async () =>
          ({
            id: `sub_${enterpriseAccountId}`,
            metadata: { enterpriseAccountId },
          }) as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe;
    await expect(
      processEnterpriseStripeEvent(malformedStripe, malformedEvent, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: false,
      failureCode: "invalid_subscription",
    });
    const entitlements = await dbAdmin
      .select()
      .from(accountEntitlements)
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    expect(entitlements).toEqual([]);
  });

  it("grants only member-filtered subscription reads and no webhook evidence privileges", async () => {
    const created = Math.floor(new Date("2026-08-07T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      event(`evt_rls_${enterpriseAccountId}`, "customer.subscription.updated", created),
      snapshot(),
    );

    const memberRows = await asRuntimeUser(memberUserId, (tx) =>
      tx
        .select()
        .from(enterpriseBillingSubscriptions)
        .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId)),
    );
    expect(memberRows).toHaveLength(1);
    const outsiderRows = await asRuntimeUser(outsiderUserId, (tx) =>
      tx
        .select()
        .from(enterpriseBillingSubscriptions)
        .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId)),
    );
    expect(outsiderRows).toEqual([]);

    const privilegeResult = await dbAdmin.execute(sql`
      SELECT
        has_table_privilege('buwiz_app', 'enterprise_billing_subscriptions', 'SELECT') AS "subscriptionSelect",
        has_table_privilege('buwiz_app', 'enterprise_billing_subscriptions', 'UPDATE') AS "subscriptionUpdate",
        has_table_privilege('buwiz_app', 'enterprise_billing_subscriptions', 'TRUNCATE') AS "subscriptionTruncate",
        has_table_privilege('buwiz_app', 'enterprise_billing_webhook_events', 'SELECT') AS "webhookSelect",
        has_table_privilege('buwiz_app', 'enterprise_billing_webhook_events', 'INSERT') AS "webhookInsert",
        has_table_privilege('buwiz_app', 'enterprise_billing_webhook_events', 'TRUNCATE') AS "webhookTruncate"
    `);
    const [privileges] = privilegeResult as unknown as Array<{
      subscriptionSelect: boolean;
      subscriptionUpdate: boolean;
      subscriptionTruncate: boolean;
      webhookSelect: boolean;
      webhookInsert: boolean;
      webhookTruncate: boolean;
    }>;
    expect(privileges).toEqual({
      subscriptionSelect: true,
      subscriptionUpdate: false,
      subscriptionTruncate: false,
      webhookSelect: false,
      webhookInsert: false,
      webhookTruncate: false,
    });

    await expect(
      asRuntimeUser(memberUserId, (tx) =>
        tx
          .update(enterpriseBillingSubscriptions)
          .set({ quantity: 99 })
          .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId))
          .returning({ id: enterpriseBillingSubscriptions.id }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    const [unchangedSubscription] = await dbAdmin
      .select({ quantity: enterpriseBillingSubscriptions.quantity })
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId));
    expect(unchangedSubscription.quantity).toBe(12);
    await expect(
      asRuntimeUser(memberUserId, (tx) => tx.select().from(enterpriseBillingWebhookEvents)),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      asRuntimeUser(memberUserId, (tx) =>
        tx.insert(enterpriseBillingWebhookEvents).values({
          providerEventId: `evt_runtime_insert_${enterpriseAccountId}`,
          eventType: "customer.subscription.updated",
          providerCreatedAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      asRuntimeUser(memberUserId, (tx) =>
        tx.execute(sql`TRUNCATE TABLE enterprise_billing_webhook_events`),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
