import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { dbAdmin, withUserContext } from "../../src/db";
import { member, organization, user } from "../../src/db/schema/auth";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
  enterpriseBillingCheckoutSessions,
  enterpriseBillingSubscriptions,
  enterpriseBillingWebhookEvents,
  organizationGroupEntities,
  organizationGroupMembers,
  organizationGroups,
} from "../../src/db/schema/business-groups";
import {
  createEnterpriseCheckoutSession,
  createEnterprisePortalSession,
  getEnterpriseBillingOverview,
  reserveEnterpriseCheckout,
} from "../../src/lib/enterprise/billing";
import { BusinessGroupAccessError } from "../../src/lib/enterprise/entitlement-state";
import {
  applyEnterpriseStripeSubscription,
  processEnterpriseStripeEvent,
  type EnterpriseStripeSubscriptionSnapshot,
} from "../../src/lib/enterprise/stripe-entitlements";

describe("Enterprise billing checkout", () => {
  let enterpriseAccountId: string;
  let ownerUserId: string;
  let billingUserId: string;
  let groupAdminUserId: string;
  let stripe: Stripe;
  let checkoutCreate: ReturnType<typeof vi.fn>;
  let checkoutRetrieve: ReturnType<typeof vi.fn>;
  let portalCreate: ReturnType<typeof vi.fn>;
  let organizationIds: string[];

  beforeEach(async () => {
    process.env.BETTER_AUTH_URL = "https://books.example.test";
    process.env.STRIPE_ENTERPRISE_PRICE_ID = "price_enterprise";
    process.env.STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID = "bpc_enterprise_controlled";
    organizationIds = [];
    const suffix = crypto.randomUUID();
    ownerUserId = `billing-owner-${suffix}`;
    billingUserId = `billing-admin-${suffix}`;
    groupAdminUserId = `billing-group-admin-${suffix}`;
    await dbAdmin.insert(user).values([
      {
        id: ownerUserId,
        name: "Billing Owner",
        email: `${ownerUserId}@test.local`,
        emailVerified: true,
      },
      {
        id: billingUserId,
        name: "Billing Admin",
        email: `${billingUserId}@test.local`,
        emailVerified: true,
      },
      {
        id: groupAdminUserId,
        name: "Group Admin",
        email: `${groupAdminUserId}@test.local`,
        emailVerified: true,
      },
    ]);
    const [account] = await dbAdmin
      .insert(enterpriseAccounts)
      .values({
        name: `Checkout account ${suffix}`,
        billingContactEmail: `billing-${suffix}@test.local`,
        createdBy: ownerUserId,
      })
      .returning({ id: enterpriseAccounts.id });
    enterpriseAccountId = account.id;
    await dbAdmin.insert(enterpriseAccountMembers).values([
      { enterpriseAccountId, userId: ownerUserId, role: "owner" },
      { enterpriseAccountId, userId: billingUserId, role: "billing_admin" },
      { enterpriseAccountId, userId: groupAdminUserId, role: "group_admin" },
    ]);

    checkoutCreate = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({
      id: `cs_${params.metadata!.checkoutReservationId}`,
      url: `https://checkout.stripe.test/${params.metadata!.checkoutReservationId}`,
      expires_at: params.expires_at!,
    }));
    checkoutRetrieve = vi.fn();
    portalCreate = vi.fn(async () => ({
      url: "https://billing.stripe.test/session",
    }));
    stripe = {
      checkout: {
        sessions: { create: checkoutCreate, retrieve: checkoutRetrieve },
      },
      billingPortal: { sessions: { create: portalCreate } },
    } as unknown as Stripe;
  });

  afterEach(async () => {
    await dbAdmin.delete(enterpriseAccounts).where(eq(enterpriseAccounts.id, enterpriseAccountId));
    if (organizationIds.length > 0) {
      await dbAdmin.delete(organization).where(inArray(organization.id, organizationIds));
    }
    await dbAdmin
      .delete(user)
      .where(sql`${user.id} in (${ownerUserId}, ${billingUserId}, ${groupAdminUserId})`);
  });

  function subscriptionSnapshot(
    overrides: Partial<EnterpriseStripeSubscriptionSnapshot> = {},
  ): EnterpriseStripeSubscriptionSnapshot {
    return {
      enterpriseAccountId,
      customerId: `cus_${enterpriseAccountId}`,
      subscriptionId: `sub_${enterpriseAccountId}`,
      priceId: "price_enterprise",
      quantity: 12,
      providerStatus: "active",
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      ...overrides,
    };
  }

  function providerEvent(id: string, type: Stripe.Event.Type, created: number) {
    return { id, type, created } as Pick<Stripe.Event, "id" | "type" | "created">;
  }

  function checkoutEvent(
    reservation: typeof enterpriseBillingCheckoutSessions.$inferSelect,
    type: "checkout.session.completed" | "checkout.session.expired",
  ): Stripe.Event {
    return {
      id: `evt_${type.replaceAll(".", "_")}_${crypto.randomUUID()}`,
      type,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: reservation.providerSessionId ?? `cs_${reservation.id}`,
          mode: "subscription",
          client_reference_id: enterpriseAccountId,
          subscription: type === "checkout.session.completed" ? `sub_${enterpriseAccountId}` : null,
          metadata: {
            enterpriseAccountId,
            checkoutReservationId: reservation.id,
          },
        },
      },
    } as unknown as Stripe.Event;
  }

  it("allows only owner and billing-admin account roles to inspect billing", async () => {
    await expect(
      withUserContext(ownerUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, ownerUserId),
      ),
    ).resolves.toMatchObject({ management: "none", canStartCheckout: true });
    await expect(
      withUserContext(billingUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, billingUserId),
      ),
    ).resolves.toMatchObject({ role: "billing_admin", canStartCheckout: true });
    await expect(
      withUserContext(groupAdminUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, groupAdminUserId),
      ),
    ).rejects.toBeInstanceOf(BusinessGroupAccessError);
  });

  it("freezes a two-hour provider window from an injected reservation time", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const reservation = await reserveEnterpriseCheckout({
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 12,
      now,
    });

    expect(reservation.expiresAt.toISOString()).toBe("2026-08-01T14:00:00.000Z");
  });

  it("reuses one account reservation and one Stripe idempotency key", async () => {
    const input = {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 12,
    };
    const [first, concurrent] = await Promise.all([
      createEnterpriseCheckoutSession(stripe, input),
      createEnterpriseCheckoutSession(stripe, {
        ...input,
        requestedQuantity: 25,
      }),
    ]);
    expect(first.url).toBe(concurrent.url);
    expect(first.quantity).toBe(concurrent.quantity);
    expect([12, 25]).toContain(first.quantity);

    const idempotencyKeys = checkoutCreate.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(1);
    const resumed = await createEnterpriseCheckoutSession(stripe, input);
    expect(resumed).toMatchObject({
      url: first.url,
      reused: true,
      quantity: first.quantity,
    });

    const reservations = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      status: "open",
      requestedQuantity: first.quantity,
    });
  });

  it("retries the exact frozen Stripe request across billing admins and config changes", async () => {
    const firstAttemptAt = Date.now();
    let attempt = 0;
    checkoutCreate.mockImplementation(async (params: Stripe.Checkout.SessionCreateParams) => {
      const remainingSeconds = params.expires_at! - Math.floor(Date.now() / 1000);
      if (remainingSeconds < 30 * 60) throw new Error("stripe_expires_at_too_soon");
      attempt += 1;
      if (attempt === 1) throw new Error("provider_timeout_after_request");
      return {
        id: `cs_${params.metadata!.checkoutReservationId}`,
        url: `https://checkout.stripe.test/${params.metadata!.checkoutReservationId}`,
        expires_at: params.expires_at!,
      };
    });
    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 12,
      }),
    ).rejects.toThrow("provider_timeout_after_request");

    await dbAdmin
      .update(enterpriseAccounts)
      .set({ billingContactEmail: "rotated-billing@test.local" })
      .where(eq(enterpriseAccounts.id, enterpriseAccountId));
    process.env.BETTER_AUTH_URL = "https://rotated.example.test";
    process.env.STRIPE_ENTERPRISE_PRICE_ID = "price_rotated";

    const delayedClock = vi.spyOn(Date, "now").mockReturnValue(firstAttemptAt + 90_000);
    try {
      await expect(
        createEnterpriseCheckoutSession(stripe, {
          enterpriseAccountId,
          userId: billingUserId,
          requestedQuantity: 25,
        }),
      ).resolves.toMatchObject({ quantity: 12 });
    } finally {
      delayedClock.mockRestore();
    }

    expect(checkoutCreate).toHaveBeenCalledTimes(2);
    expect(checkoutCreate.mock.calls[1][0]).toEqual(checkoutCreate.mock.calls[0][0]);
    expect(checkoutCreate.mock.calls[1][1]).toEqual(checkoutCreate.mock.calls[0][1]);
    expect(checkoutCreate.mock.calls[1][0]).toMatchObject({
      customer_email: expect.stringContaining("billing-"),
      success_url: expect.stringContaining("books.example.test"),
      line_items: [{ price: "price_enterprise", quantity: 12 }],
    });
  });

  it("never opens a provider-cached Checkout Session that is already expired", async () => {
    checkoutCreate.mockImplementationOnce(async (params: Stripe.Checkout.SessionCreateParams) => {
      const providerSessionId = `cs_expired_${params.metadata!.checkoutReservationId}`;
      checkoutRetrieve.mockResolvedValueOnce({
        id: providerSessionId,
        status: "expired",
        url: null,
        client_reference_id: enterpriseAccountId,
        metadata: params.metadata,
      });
      return {
        id: providerSessionId,
        url: `https://checkout.stripe.test/expired/${params.metadata!.checkoutReservationId}`,
        expires_at: Math.floor(Date.now() / 1000) - 1,
      };
    });

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 12,
      }),
    ).rejects.toMatchObject({ code: "BILLING_ACTIVATION_PENDING" });
    const [expired] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    expect(expired).toMatchObject({
      status: "expired",
      providerSessionId: `cs_expired_${expired.id}`,
      providerSessionUrl: null,
    });

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: billingUserId,
        requestedQuantity: 12,
      }),
    ).resolves.toMatchObject({ reused: false });
  });

  it("preserves completed provider truth when a cached creation response has an old expiry", async () => {
    checkoutCreate.mockImplementationOnce(async (params: Stripe.Checkout.SessionCreateParams) => {
      const providerSessionId = `cs_complete_${params.metadata!.checkoutReservationId}`;
      checkoutRetrieve.mockResolvedValueOnce({
        id: providerSessionId,
        status: "complete",
        url: null,
        mode: "subscription",
        subscription: `sub_complete_${enterpriseAccountId}`,
        client_reference_id: enterpriseAccountId,
        metadata: params.metadata,
      });
      return {
        id: providerSessionId,
        url: `https://checkout.stripe.test/complete/${params.metadata!.checkoutReservationId}`,
        expires_at: Math.floor(Date.now() / 1000) - 1,
      };
    });

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 12,
      }),
    ).rejects.toMatchObject({ code: "BILLING_ACTIVATION_PENDING" });
    let [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    expect(reservation).toMatchObject({
      status: "completed",
      providerSessionId: `cs_complete_${reservation.id}`,
      providerSessionUrl: null,
    });

    const created = Math.floor(Date.now() / 1000);
    await expect(
      applyEnterpriseStripeSubscription(
        providerEvent(
          `evt_complete_cached_${enterpriseAccountId}`,
          "customer.subscription.created",
          created,
        ),
        subscriptionSnapshot({
          checkoutReservationId: reservation.id,
          subscriptionId: `sub_complete_${enterpriseAccountId}`,
        }),
      ),
    ).resolves.toMatchObject({ status: "processed" });
    [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(reservation.status).toBe("consumed");
  });

  it("lets a signed completion bind an unpersisted provider Session without state regression", async () => {
    checkoutCreate.mockImplementationOnce(async (params: Stripe.Checkout.SessionCreateParams) => {
      const reservationId = String(params.metadata!.checkoutReservationId);
      const [reservation] = await dbAdmin
        .select()
        .from(enterpriseBillingCheckoutSessions)
        .where(eq(enterpriseBillingCheckoutSessions.id, reservationId));
      expect(reservation).toMatchObject({
        status: "creating",
        providerSessionId: null,
      });
      await processEnterpriseStripeEvent(
        stripe,
        checkoutEvent(reservation, "checkout.session.completed"),
        "price_enterprise",
      );
      return {
        id: `cs_${reservationId}`,
        url: `https://checkout.stripe.test/${reservationId}`,
        expires_at: params.expires_at!,
      };
    });

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 8,
      }),
    ).rejects.toMatchObject({ code: "BILLING_ACTIVATION_PENDING" });

    const [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    expect(reservation).toMatchObject({
      status: "completed",
      providerSessionId: `cs_${reservation.id}`,
      providerSessionUrl: null,
    });
  });

  it("serializes overlapping direct Checkout recovery and provider reconciliation without deadlock", async () => {
    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 12,
    });
    const [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    await dbAdmin
      .update(enterpriseBillingCheckoutSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    checkoutRetrieve.mockResolvedValueOnce({
      id: reservation.providerSessionId,
      status: "complete",
      mode: "subscription",
      subscription: `sub_overlap_${enterpriseAccountId}`,
      client_reference_id: enterpriseAccountId,
      metadata: {
        enterpriseAccountId,
        checkoutReservationId: reservation.id,
      },
    });

    let releaseAllowance!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseAllowance = resolve;
    });
    let signalAllowanceHeld!: () => void;
    const allowanceHeld = new Promise<void>((resolve) => {
      signalAllowanceHeld = resolve;
    });
    const allowanceBlocker = dbAdmin.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`business-groups:${enterpriseAccountId}`}, 0))`,
      );
      signalAllowanceHeld();
      await releaseSignal;
    });
    await allowanceHeld;

    let directSettled = false;
    let providerSettled = false;
    const direct = createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: billingUserId,
      requestedQuantity: 12,
    }).finally(() => {
      directSettled = true;
    });
    const provider = applyEnterpriseStripeSubscription(
      providerEvent(
        `evt_overlap_${enterpriseAccountId}`,
        "customer.subscription.created",
        Math.floor(Date.now() / 1000),
      ),
      subscriptionSnapshot({
        checkoutReservationId: reservation.id,
        subscriptionId: `sub_overlap_${enterpriseAccountId}`,
      }),
    ).finally(() => {
      providerSettled = true;
    });
    const concurrentOutcomes = Promise.allSettled([direct, provider]);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(directSettled).toBe(false);
      expect(providerSettled).toBe(false);
      releaseAllowance();
      const outcomes = await Promise.race([
        concurrentOutcomes,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("checkout_provider_deadlock")), 5_000);
        }),
      ]);
      expect(outcomes[0].status).toBe("rejected");
      expect(outcomes[1]).toMatchObject({
        status: "fulfilled",
        value: { status: "processed", duplicate: false },
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseAllowance();
      await allowanceBlocker;
      await concurrentOutcomes;
    }

    const [consumed] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(consumed.status).toBe("consumed");
    const [subscription] = await dbAdmin
      .select()
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId));
    expect(subscription.externalSubscriptionId).toBe(`sub_overlap_${enterpriseAccountId}`);
  });

  it("lets a signed expiration bind an unpersisted provider Session", async () => {
    checkoutCreate.mockRejectedValueOnce(new Error("provider_timeout_after_request"));
    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 8,
      }),
    ).rejects.toThrow("provider_timeout_after_request");
    const [creating] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));

    await expect(
      processEnterpriseStripeEvent(
        stripe,
        checkoutEvent(creating, "checkout.session.expired"),
        "price_enterprise",
      ),
    ).resolves.toMatchObject({ status: "processed" });
    const [expired] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, creating.id));
    expect(expired).toMatchObject({
      status: "expired",
      providerSessionId: `cs_${creating.id}`,
    });
  });

  it("reconciles signed Checkout completion idempotently and keeps rows operator-only", async () => {
    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 8,
    });
    const [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    const event = {
      id: `evt_checkout_${reservation.id}`,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: reservation.providerSessionId,
          mode: "subscription",
          client_reference_id: enterpriseAccountId,
          subscription: `sub_${enterpriseAccountId}`,
          metadata: {
            enterpriseAccountId,
            checkoutReservationId: reservation.id,
          },
        },
      },
    } as unknown as Stripe.Event;

    await expect(processEnterpriseStripeEvent(stripe, event, "price_enterprise")).resolves.toEqual({
      status: "processed",
      duplicate: false,
    });
    await expect(processEnterpriseStripeEvent(stripe, event, "price_enterprise")).resolves.toEqual({
      status: "processed",
      duplicate: true,
    });
    const lateExpiration = {
      ...event,
      id: `evt_checkout_expired_${reservation.id}`,
      type: "checkout.session.expired",
      data: {
        object: {
          ...(event.data.object as Stripe.Checkout.Session),
          subscription: null,
        },
      },
    } as Stripe.Event;
    await expect(
      processEnterpriseStripeEvent(stripe, lateExpiration, "price_enterprise"),
    ).resolves.toMatchObject({
      status: "ignored",
      failureCode: "stale_checkout_event",
    });
    const [completed] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(completed.status).toBe("completed");

    const privilegeResult = await dbAdmin.execute(sql`
      WITH runtime_roles(role_name) AS (
        VALUES ('PUBLIC'::text), ('app_runtime'::text), ('buwiz_app'::text)
      ), privileges(privilege_name) AS (
        VALUES
          ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text),
          ('TRUNCATE'::text), ('REFERENCES'::text), ('TRIGGER'::text)
      )
      SELECT
        runtime_roles.role_name AS "roleName",
        privileges.privilege_name AS "privilegeName",
        CASE
          WHEN runtime_roles.role_name = 'PUBLIC' THEN EXISTS (
            SELECT 1
            FROM information_schema.table_privileges grants
            WHERE grants.table_schema = 'public'
              AND grants.table_name = 'enterprise_billing_checkout_sessions'
              AND grants.grantee = 'PUBLIC'
              AND grants.privilege_type = privileges.privilege_name
          )
          ELSE has_table_privilege(
            runtime_roles.role_name,
            'enterprise_billing_checkout_sessions',
            privileges.privilege_name
          )
        END AS allowed
      FROM runtime_roles
      CROSS JOIN privileges
      WHERE runtime_roles.role_name = 'PUBLIC'
        OR EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = runtime_roles.role_name
        )
      ORDER BY runtime_roles.role_name, privileges.privilege_name
    `);
    const privileges = privilegeResult as unknown as Array<{
      roleName: string;
      privilegeName: string;
      allowed: boolean;
    }>;
    expect(privileges.filter((privilege) => privilege.allowed)).toEqual([]);
    expect(new Set(privileges.map((privilege) => privilege.roleName))).toEqual(
      new Set(["PUBLIC", "app_runtime", "buwiz_app"]),
    );
    await expect(
      withUserContext(ownerUserId, async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
        return tx.select().from(enterpriseBillingCheckoutSessions);
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("quarantines permanent Checkout binding mismatches as acknowledged ignored evidence", async () => {
    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 8,
    });
    const [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    const valid = checkoutEvent(reservation, "checkout.session.completed");
    const invalidBindingId = `evt_invalid_checkout_${reservation.id}`;
    const invalidBinding = {
      ...valid,
      id: invalidBindingId,
      data: {
        object: {
          ...(valid.data.object as Stripe.Checkout.Session),
          client_reference_id: crypto.randomUUID(),
        },
      },
    } as Stripe.Event;
    await expect(
      processEnterpriseStripeEvent(stripe, invalidBinding, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: false,
      failureCode: "invalid_checkout_binding",
    });
    await expect(
      processEnterpriseStripeEvent(stripe, invalidBinding, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: true,
      failureCode: "invalid_checkout_binding",
    });

    const reservationMismatchId = `evt_checkout_mismatch_${reservation.id}`;
    const reservationMismatch = {
      ...valid,
      id: reservationMismatchId,
      data: {
        object: {
          ...(valid.data.object as Stripe.Checkout.Session),
          id: `cs_not_reserved_${reservation.id}`,
        },
      },
    } as Stripe.Event;
    await expect(
      processEnterpriseStripeEvent(stripe, reservationMismatch, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: false,
      failureCode: "checkout_reservation_mismatch",
    });
    await expect(
      processEnterpriseStripeEvent(stripe, reservationMismatch, "price_enterprise"),
    ).resolves.toEqual({
      status: "ignored",
      duplicate: true,
      failureCode: "checkout_reservation_mismatch",
    });

    const evidence = await dbAdmin
      .select({
        providerEventId: enterpriseBillingWebhookEvents.providerEventId,
        status: enterpriseBillingWebhookEvents.status,
        failureCode: enterpriseBillingWebhookEvents.failureCode,
      })
      .from(enterpriseBillingWebhookEvents)
      .where(
        inArray(enterpriseBillingWebhookEvents.providerEventId, [
          invalidBindingId,
          reservationMismatchId,
        ]),
      );
    expect(evidence).toHaveLength(2);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ignored",
          failureCode: "invalid_checkout_binding",
        }),
        expect.objectContaining({
          status: "ignored",
          failureCode: "checkout_reservation_mismatch",
        }),
      ]),
    );
    const [unchanged] = await dbAdmin
      .select({ status: enterpriseBillingCheckoutSessions.status })
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(unchanged.status).toBe("open");
  });

  it("recovers a known open reservation after Stripe verifies a missed expiration", async () => {
    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 8,
    });
    const [first] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    await dbAdmin
      .update(enterpriseBillingCheckoutSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(enterpriseBillingCheckoutSessions.id, first.id));
    checkoutRetrieve.mockResolvedValueOnce({
      id: first.providerSessionId,
      status: "expired",
      client_reference_id: enterpriseAccountId,
      metadata: {
        enterpriseAccountId,
        checkoutReservationId: first.id,
      },
    });

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: billingUserId,
        requestedQuantity: 9,
      }),
    ).resolves.toMatchObject({ quantity: 9, reused: false });

    const reservations = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    expect(reservations).toHaveLength(2);
    expect(reservations.find((row) => row.id === first.id)?.status).toBe("expired");
    expect(reservations.find((row) => row.id !== first.id)).toMatchObject({
      status: "open",
      requestedQuantity: 9,
    });
  });

  it("keeps an expired creating reservation locked for operator reconciliation", async () => {
    checkoutCreate.mockRejectedValueOnce(new Error("provider_timeout_after_request"));
    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 8,
      }),
    ).rejects.toThrow("provider_timeout_after_request");
    await dbAdmin
      .update(enterpriseBillingCheckoutSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: billingUserId,
        requestedQuantity: 8,
      }),
    ).rejects.toMatchObject({ code: "BILLING_ACTIVATION_PENDING" });
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutRetrieve).not.toHaveBeenCalled();
  });

  it("rejects a requested allowance below enabled linked-business usage before Stripe", async () => {
    const suffix = crypto.randomUUID();
    organizationIds = [`usage-a-${suffix}`, `usage-b-${suffix}`];
    await dbAdmin.insert(organization).values(
      organizationIds.map((id, index) => ({
        id,
        name: `Usage ${index + 1}`,
        slug: `usage-${index + 1}-${suffix}`,
      })),
    );
    await dbAdmin.insert(member).values(
      organizationIds.map((organizationId) => ({
        id: `usage-owner-${organizationId}`,
        userId: ownerUserId,
        organizationId,
        role: "owner",
      })),
    );
    const [fixtureEntitlement] = await dbAdmin
      .insert(accountEntitlements)
      .values({
        enterpriseAccountId,
        featureKey: "business_groups",
        status: "active",
        includedEntityLimit: organizationIds.length,
        provisioningSource: "contract",
        startsAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: accountEntitlements.id });
    await dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_user_id', ${ownerUserId}, true)`);
      const [group] = await tx
        .insert(organizationGroups)
        .values({
          enterpriseAccountId,
          name: `Usage group ${suffix}`,
          createdBy: ownerUserId,
        })
        .returning({ id: organizationGroups.id });
      await tx.insert(organizationGroupMembers).values({
        groupId: group.id,
        userId: ownerUserId,
        role: "owner",
      });
      await tx.insert(organizationGroupEntities).values(
        organizationIds.map((organizationId) => ({
          enterpriseAccountId,
          groupId: group.id,
          organizationId,
          createdBy: ownerUserId,
        })),
      );
    });
    await dbAdmin
      .delete(accountEntitlements)
      .where(eq(accountEntitlements.id, fixtureEntitlement.id));

    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 1,
      }),
    ).rejects.toMatchObject({ code: "BILLING_QUANTITY_BELOW_USAGE" });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("allows terminal-subscription replacement and consumes the completed reservation", async () => {
    const baseCreated = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      providerEvent(
        `evt_terminal_${enterpriseAccountId}`,
        "customer.subscription.deleted",
        baseCreated,
      ),
      subscriptionSnapshot({ providerStatus: "canceled" }),
    );
    await expect(
      withUserContext(ownerUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, ownerUserId),
      ),
    ).resolves.toMatchObject({ canStartCheckout: true, management: "stripe" });

    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: billingUserId,
      requestedQuantity: 12,
    });
    let [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    await processEnterpriseStripeEvent(
      stripe,
      checkoutEvent(reservation, "checkout.session.completed"),
      "price_enterprise",
    );

    await expect(
      applyEnterpriseStripeSubscription(
        providerEvent(
          `evt_replacement_${enterpriseAccountId}`,
          "customer.subscription.created",
          baseCreated + 1,
        ),
        subscriptionSnapshot({
          checkoutReservationId: reservation.id,
          subscriptionId: `sub_replacement_${enterpriseAccountId}`,
        }),
      ),
    ).resolves.toMatchObject({ status: "processed" });

    [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(reservation.status).toBe("consumed");
    const [subscription] = await dbAdmin
      .select()
      .from(enterpriseBillingSubscriptions)
      .where(eq(enterpriseBillingSubscriptions.enterpriseAccountId, enterpriseAccountId));
    expect(subscription.externalSubscriptionId).toBe(`sub_replacement_${enterpriseAccountId}`);
  });

  it("rejects subscription metadata that copies a reservation with different commercial terms", async () => {
    const baseCreated = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      providerEvent(
        `evt_terminal_mismatch_${enterpriseAccountId}`,
        "customer.subscription.deleted",
        baseCreated,
      ),
      subscriptionSnapshot({ providerStatus: "incomplete_expired" }),
    );
    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 12,
    });
    const [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));

    await expect(
      applyEnterpriseStripeSubscription(
        providerEvent(
          `evt_bad_terms_${enterpriseAccountId}`,
          "customer.subscription.created",
          baseCreated + 1,
        ),
        subscriptionSnapshot({
          checkoutReservationId: reservation.id,
          subscriptionId: `sub_bad_terms_${enterpriseAccountId}`,
          quantity: 13,
        }),
      ),
    ).resolves.toMatchObject({
      status: "ignored",
      failureCode: "checkout_reservation_mismatch",
    });
    await expect(
      applyEnterpriseStripeSubscription(
        providerEvent(
          `evt_bad_price_${enterpriseAccountId}`,
          "customer.subscription.created",
          baseCreated + 2,
        ),
        subscriptionSnapshot({
          checkoutReservationId: reservation.id,
          subscriptionId: `sub_bad_price_${enterpriseAccountId}`,
          priceId: "price_copied_metadata",
        }),
      ),
    ).resolves.toMatchObject({
      status: "ignored",
      failureCode: "checkout_reservation_mismatch",
    });
    const [unchanged] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(unchanged.status).toBe("open");
  });

  it("uses the reservation price for an in-flight subscription after configured price rotation", async () => {
    await createEnterpriseCheckoutSession(stripe, {
      enterpriseAccountId,
      userId: ownerUserId,
      requestedQuantity: 12,
    });
    const [reservation] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.enterpriseAccountId, enterpriseAccountId));
    const created = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    const subscription = {
      id: `sub_rotated_${enterpriseAccountId}`,
      customer: `cus_${enterpriseAccountId}`,
      status: "active",
      cancel_at_period_end: false,
      metadata: { enterpriseAccountId, checkoutReservationId: reservation.id },
      items: {
        data: [
          {
            price: { id: "price_enterprise" },
            quantity: 12,
            current_period_start: created,
            current_period_end: created + 2_592_000,
          },
        ],
      },
    } as unknown as Stripe.Subscription;
    const retrieveSubscription = vi.fn(async () => subscription);
    (
      stripe as unknown as {
        subscriptions: { retrieve: typeof retrieveSubscription };
      }
    ).subscriptions = { retrieve: retrieveSubscription };
    const event = {
      id: `evt_rotated_price_${enterpriseAccountId}`,
      type: "customer.subscription.created",
      created,
      data: { object: subscription },
    } as unknown as Stripe.Event;

    await expect(
      processEnterpriseStripeEvent(stripe, event, "price_rotated"),
    ).resolves.toMatchObject({ status: "processed" });
    const [consumed] = await dbAdmin
      .select()
      .from(enterpriseBillingCheckoutSessions)
      .where(eq(enterpriseBillingCheckoutSessions.id, reservation.id));
    expect(consumed.status).toBe("consumed");
  });

  it("blocks manual contracts and rechecks role changes before privileged provider calls", async () => {
    await dbAdmin.insert(accountEntitlements).values({
      enterpriseAccountId,
      featureKey: "business_groups",
      status: "active",
      includedEntityLimit: 10,
      provisioningSource: "contract",
      startsAt: new Date(),
    });
    await expect(
      createEnterpriseCheckoutSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
        requestedQuantity: 10,
      }),
    ).rejects.toMatchObject({ code: "BILLING_ALREADY_MANAGED" });
    expect(checkoutCreate).not.toHaveBeenCalled();

    await dbAdmin
      .update(enterpriseAccounts)
      .set({ externalCustomerId: `cus_manual_${enterpriseAccountId}` })
      .where(eq(enterpriseAccounts.id, enterpriseAccountId));
    await expect(
      createEnterprisePortalSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "BILLING_PORTAL_UNAVAILABLE" });
    expect(portalCreate).not.toHaveBeenCalled();

    await dbAdmin
      .update(enterpriseAccountMembers)
      .set({ role: "group_admin" })
      .where(
        sql`${enterpriseAccountMembers.enterpriseAccountId} = ${enterpriseAccountId} and ${enterpriseAccountMembers.userId} = ${billingUserId}`,
      );
    await expect(
      createEnterprisePortalSession(stripe, {
        enterpriseAccountId,
        userId: billingUserId,
      }),
    ).rejects.toBeInstanceOf(BusinessGroupAccessError);
    expect(portalCreate).not.toHaveBeenCalled();
  });

  it("does not advertise or open the billing portal for a suspended account", async () => {
    const created = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      providerEvent(
        `evt_suspended_${enterpriseAccountId}`,
        "customer.subscription.created",
        created,
      ),
      subscriptionSnapshot(),
    );
    await dbAdmin
      .update(enterpriseAccounts)
      .set({ status: "suspended" })
      .where(eq(enterpriseAccounts.id, enterpriseAccountId));

    await expect(
      withUserContext(ownerUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, ownerUserId),
      ),
    ).resolves.toMatchObject({ canOpenPortal: false, canStartCheckout: false });
    await expect(
      createEnterprisePortalSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "BILLING_ACCOUNT_SUSPENDED" });
    expect(portalCreate).not.toHaveBeenCalled();
  });

  it("pins portal creation to the controlled no-quantity-change configuration", async () => {
    const created = Math.floor(new Date("2026-08-02T00:00:00.000Z").getTime() / 1000);
    await applyEnterpriseStripeSubscription(
      providerEvent(
        `evt_portal_configuration_${enterpriseAccountId}`,
        "customer.subscription.created",
        created,
      ),
      subscriptionSnapshot(),
    );

    await expect(
      withUserContext(ownerUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, ownerUserId),
      ),
    ).resolves.toMatchObject({ canOpenPortal: true });

    await expect(
      createEnterprisePortalSession(stripe, {
        enterpriseAccountId,
        userId: ownerUserId,
      }),
    ).resolves.toEqual({ url: "https://billing.stripe.test/session" });
    expect(portalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: "bpc_enterprise_controlled" }),
    );

    delete process.env.STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID;
    await expect(
      withUserContext(ownerUserId, (tx) =>
        getEnterpriseBillingOverview(tx, enterpriseAccountId, ownerUserId),
      ),
    ).resolves.toMatchObject({ canOpenPortal: false });
    await expect(
      createEnterprisePortalSession(stripe, {
        enterpriseAccountId,
        userId: billingUserId,
      }),
    ).rejects.toMatchObject({ code: "BILLING_NOT_CONFIGURED" });
    expect(portalCreate).toHaveBeenCalledTimes(1);
  });
});
