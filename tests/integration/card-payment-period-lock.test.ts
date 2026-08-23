import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { organizationAccountingSettings } from "../../src/db/schema/inbox";
import { invoices } from "../../src/db/schema/invoices";
import { parties } from "../../src/db/schema/parties";
import { journalHeaders } from "../../src/db/schema/journals";
import { COA_PRESETS } from "../../src/lib/coa/presets";
import { planCoaPreset } from "../../src/lib/coa/plan-preset";
import { executeCoaPlan } from "../../src/lib/coa/execute-plan";
import { loadCoaSnapshot } from "../../src/lib/coa/snapshot";
import { recordCardInvoicePayment } from "../../src/lib/invoice-payments";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The card-capture path was the only posting path with no period-close check:
 * a Stripe/PayPal webhook replay after month close posted cash and A/R into
 * the locked period, on the admin connection, so RLS could not catch it
 * either.
 *
 * Policy (audit checkpoint C2): a captured payment is a fact — money moved —
 * so a locked period never REJECTS it. The journal posts on the first open
 * day, the memo says so, and the lineage keeps the true capture date.
 *
 * Also pinned: the capture DAY is the org's calendar day, not UTC's. A
 * 07:00 Manila capture on 1 September is 31 August in UTC — the prior
 * period.
 */
describeDb("card payment period lock", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  async function setupOrg(opts: { closedThrough: string | null; timezone: string }) {
    const suffix = randomUUID();
    const orgId = `cardlock-org-${suffix}`;
    await db.insert(organization).values({
      id: orgId,
      name: "Card Lock Test Org",
      slug: `cardlock-${suffix}`,
      closedThrough: opts.closedThrough,
    });
    await db.insert(organizationAccountingSettings).values({
      organizationId: orgId,
      baseCurrency: "USD",
      timezone: opts.timezone,
    });
    // The preset guarantees the AR + deposit mappings the poster resolves.
    // executeCoaPlan asserts a real org context (same pattern as the coa
    // integration suites).
    await db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      const snapshot = await loadCoaSnapshot(tx, orgId);
      const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
        onConflict: "renumber",
      });
      await executeCoaPlan(tx, orgId, plan, "test");
    });
    const [customer] = await db
      .insert(parties)
      .values({ organizationId: orgId, name: "Card Lock Customer", partyType: "customer" })
      .returning();
    const [invoice] = await db
      .insert(invoices)
      .values({
        organizationId: orgId,
        invoiceNumber: `INV-${suffix.slice(0, 8)}`,
        customerId: customer.id,
        issueDate: "2026-07-10",
        dueDate: "2026-08-10",
        subtotal: "100.00",
        total: "100.00",
        balanceDue: "100.00",
        status: "sent",
      })
      .returning();
    return { orgId, invoice };
  }

  it("rolls a capture in a locked period forward to the first open day", async () => {
    const { orgId, invoice } = await setupOrg({
      closedThrough: "2026-07-31",
      timezone: "UTC",
    });

    const result = await recordCardInvoicePayment({
      db,
      invoiceId: invoice.id,
      amount: 100,
      paidVia: "stripe",
      externalRef: `cap-${randomUUID()}`,
      occurredAt: new Date("2026-07-20T10:00:00.000Z"),
    });

    const [header] = await db
      .select({
        transactionDate: journalHeaders.transactionDate,
        memo: journalHeaders.memo,
        status: journalHeaders.status,
      })
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.journalHeaderId));

    // Never rejected — posted, but on the first open day, and the memo
    // preserves what actually happened.
    expect(header.status).toBe("posted");
    expect(header.transactionDate).toBe("2026-08-01");
    expect(header.memo).toContain("captured 2026-07-20");
    expect(header.memo).toContain("period locked through 2026-07-31");

    const [paid] = await db
      .select({ status: invoices.status, balanceDue: invoices.balanceDue })
      .from(invoices)
      .where(eq(invoices.id, invoice.id));
    expect(paid.status).toBe("paid");
    expect(Number(paid.balanceDue)).toBe(0);
  });

  it("posts on the capture day when the period is open, using the org's calendar", async () => {
    const { orgId, invoice } = await setupOrg({
      closedThrough: null,
      timezone: "Asia/Manila",
    });

    const result = await recordCardInvoicePayment({
      db,
      invoiceId: invoice.id,
      amount: 100,
      paidVia: "paypal",
      externalRef: `cap-${randomUUID()}`,
      // 23:00 UTC on 31 Aug is already 1 September in Manila.
      occurredAt: new Date("2026-08-31T23:00:00.000Z"),
    });

    const [header] = await db
      .select({ transactionDate: journalHeaders.transactionDate, memo: journalHeaders.memo })
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.journalHeaderId));
    expect(header.transactionDate).toBe("2026-09-01");
    expect(header.memo).not.toContain("period locked");
  });
});
