// ============================================================================
// Program 2 P11 — reporting + invoice-lifecycle polish, pinned against a
// real database:
//
//   • D5 (deliberate policy change): the BALANCE SHEET is point-in-time about
//     voids — a journal voided AFTER the as-of date still existed on that
//     date, exactly as AP/AR aging always computed it, so control accounts
//     tie to aging at any as-of date. Period reports (P&L) deliberately keep
//     retroactive voids; the divergence is the policy, not an accident.
//   • The overdue sweep is a real mutation: sent/viewed past-due invoices
//     transition, everything else is untouched, and re-running is a no-op.
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { invoices } from "../../src/db/schema/invoices";
import { parties } from "../../src/db/schema/parties";
import { computeBalanceSheet, computeProfitLoss } from "../../src/services/reports";
import { sweepOverdueInvoices } from "../../src/lib/invoices/overdue";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("balance sheet voided handling (D5 point-in-time)", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `d5-reports-${randomUUID()}`;
  let cashId: string;
  let expenseId: string;
  let headerId: string;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "D5 Reports Org",
      slug: `d5r-${randomUUID().slice(0, 8)}`,
    });
    const [cash] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Cash",
        accountNumber: "11100",
        accountType: "asset",
        subtype: "bank_accounts",
      })
      .returning({ id: accounts.id });
    cashId = cash.id;
    const [expense] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Ops",
        accountNumber: "61100",
        accountType: "expense",
      })
      .returning({ id: accounts.id });
    expenseId = expense.id;

    // Post 100.00 on June 15, then void it on July 5. The June 30 view is
    // the point-in-time question; July 31 is the after-void view.
    headerId = await db.transaction(async (tx: any) => {
      const [header] = await tx
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionNumber: `TXN-${randomUUID().slice(0, 8)}`,
          transactionDate: "2026-06-15",
          transactionType: "journal",
          source: "manual",
          functionalCurrency: "USD",
          totalAmount: "100.00",
          status: "posted",
          postedAt: new Date("2026-06-15T10:00:00Z"),
        })
        .returning({ id: journalHeaders.id });
      await tx.insert(journalLines).values([
        { journalHeaderId: header.id, accountId: expenseId, debit: "100.00", sortOrder: 0 },
        { journalHeaderId: header.id, accountId: cashId, credit: "100.00", sortOrder: 1 },
      ]);
      return header.id as string;
    });
    await db
      .update(journalHeaders)
      .set({ status: "voided", voidedAt: new Date("2026-07-05T12:00:00Z") })
      .where(eq(journalHeaders.id, headerId));
  });

  afterAll(async () => {
    await sql.end();
  });

  it("as-of BEFORE the void: the journal still counts (ties to aging)", async () => {
    const bs = await computeBalanceSheet(ORG, "2026-06-30", "none", db);
    // The only activity is a 100.00 credit to Cash: assets stand at -100 on
    // June 30 because the void had not happened yet on that date.
    expect(bs.totalAssets).toBeCloseTo(-100, 2);
  });

  it("as-of AFTER the void: the journal is gone", async () => {
    const bs = await computeBalanceSheet(ORG, "2026-07-31", "none", db);
    expect(Math.abs(bs.totalAssets)).toBeLessThan(0.005);
  });

  it("P&L deliberately keeps retroactive voids (D5 divergence is scoped to the balance sheet)", async () => {
    const pl = await computeProfitLoss(ORG, "2026-06-01", "2026-06-30", "none", db);
    // The voided expense must NOT contribute to June's P&L even though the
    // void happened in July — period reports stay "voids never happened".
    expect(pl.netIncome).toBeCloseTo(0, 2);
    expect(pl.expenses.total).toBeCloseTo(0, 2);
  });
});

describeDb("overdue invoice sweep (list reads stopped writing)", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `overdue-${randomUUID()}`;
  let customerId: string;

  async function seedInvoice(status: string, dueDate: string): Promise<string> {
    const [row] = await db
      .insert(invoices)
      .values({
        organizationId: ORG,
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        customerId,
        issueDate: "2026-06-01",
        dueDate,
        status,
        subtotal: "50.00",
        total: "50.00",
        balanceDue: "50.00",
      })
      .returning({ id: invoices.id });
    return row.id;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "Overdue Sweep Org",
      slug: `ovd-${randomUUID().slice(0, 8)}`,
    });
    const [customer] = await db
      .insert(parties)
      .values({ organizationId: ORG, name: "Sweep Customer", partyType: "customer" })
      .returning({ id: parties.id });
    customerId = customer.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("transitions exactly the sent/viewed past-due set, idempotently", async () => {
    const sentPast = await seedInvoice("sent", "2026-07-01");
    const viewedPast = await seedInvoice("viewed", "2026-07-15");
    const paidPast = await seedInvoice("paid", "2026-07-01");
    const draftPast = await seedInvoice("draft", "2026-07-01");
    const sentFuture = await seedInvoice("sent", "2030-01-01");

    const transitioned = await sweepOverdueInvoices(db, ORG, "2026-08-24");
    expect(transitioned).toBe(2);

    const byId = new Map(
      (
        await db
          .select({ id: invoices.id, status: invoices.status })
          .from(invoices)
          .where(eq(invoices.organizationId, ORG))
      ).map((r: { id: string; status: string }) => [r.id, r.status]),
    );
    expect(byId.get(sentPast)).toBe("overdue");
    expect(byId.get(viewedPast)).toBe("overdue");
    expect(byId.get(paidPast)).toBe("paid");
    expect(byId.get(draftPast)).toBe("draft");
    expect(byId.get(sentFuture)).toBe("sent");

    // Idempotent: nothing left to transition.
    expect(await sweepOverdueInvoices(db, ORG, "2026-08-24")).toBe(0);
  });

  it("never crosses the org boundary", async () => {
    const OTHER = `overdue-other-${randomUUID()}`;
    await db.insert(organization).values({
      id: OTHER,
      name: "Other Org",
      slug: `ovo-${randomUUID().slice(0, 8)}`,
    });
    const [otherCustomer] = await db
      .insert(parties)
      .values({ organizationId: OTHER, name: "Other Customer", partyType: "customer" })
      .returning({ id: parties.id });
    const [otherInvoice] = await db
      .insert(invoices)
      .values({
        organizationId: OTHER,
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        customerId: otherCustomer.id,
        issueDate: "2026-06-01",
        dueDate: "2026-07-01",
        status: "sent",
        subtotal: "50.00",
        total: "50.00",
        balanceDue: "50.00",
      })
      .returning({ id: invoices.id });

    await sweepOverdueInvoices(db, ORG, "2026-08-24");
    const [other] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, otherInvoice.id));
    expect(other.status).toBe("sent");
  });
});
