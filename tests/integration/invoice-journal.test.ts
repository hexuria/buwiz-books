/**
 * Integration tests for the invoice A/R journal (createArJournalEntry) — the balanced
 * double-entry posted when an invoice is sent. Locks in the tax/discount handling and the
 * validateBalance guard against a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { parties } from "../../src/db/schema/parties";
import { invoices, invoiceLineItems } from "../../src/db/schema/invoices";
import { journalLines } from "../../src/db/schema/journals";
import { createArJournalEntry, createPaymentJournalEntry } from "../../src/lib/invoice-journal";
import { eq } from "drizzle-orm";
import type postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("createArJournalEntry", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG = crypto.randomUUID();
  const AR = crypto.randomUUID();
  const REVENUE = crypto.randomUUID();
  const TAX = crypto.randomUUID();
  const DISCOUNT = crypto.randomUUID();
  const BANK = crypto.randomUUID();
  const CUSTOMER = crypto.randomUUID();

  async function seedInvoice(opts: {
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    lineRevenueAccounts: (string | null)[];
  }) {
    const id = crypto.randomUUID();
    await db.insert(invoices).values({
      id,
      organizationId: ORG,
      invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
      customerId: CUSTOMER,
      issueDate: "2026-03-15",
      dueDate: "2026-04-15",
      subtotal: opts.subtotal,
      discountAmount: opts.discount,
      taxAmount: opts.tax,
      total: opts.total,
      balanceDue: opts.total,
    });
    const per = (Number.parseFloat(opts.subtotal) / opts.lineRevenueAccounts.length).toFixed(2);
    await db.insert(invoiceLineItems).values(
      opts.lineRevenueAccounts.map((acct, i) => ({
        invoiceId: id,
        description: `Line ${i + 1}`,
        quantity: "1",
        unitPrice: per,
        amount: per,
        revenueAccountId: acct ?? undefined,
        sortOrder: i,
      })),
    );
    return id;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(accounts).values([
      {
        id: AR,
        organizationId: ORG,
        name: "Accounts Receivable",
        accountType: "asset",
        subtype: "account_receivable",
      },
      {
        id: REVENUE,
        organizationId: ORG,
        name: "Sales Revenue",
        accountType: "revenue",
        subtype: "sales_revenue",
      },
      {
        id: TAX,
        organizationId: ORG,
        name: "Sales Tax Payable",
        accountType: "liability",
        subtype: "other_current_liabilities",
      },
      {
        id: DISCOUNT,
        organizationId: ORG,
        name: "Refunds & Discounts",
        accountType: "revenue",
        subtype: "refunds_discounts",
      },
      {
        id: BANK,
        organizationId: ORG,
        name: "Checking",
        accountType: "asset",
        subtype: "bank_accounts",
      },
    ]);
    await db
      .insert(parties)
      .values({ id: CUSTOMER, organizationId: ORG, name: "Acme Corp", partyType: "customer" });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("posts a BALANCED journal with tax and discount lines", async () => {
    // subtotal 100, discount 10, tax 8 → total 98.
    const invId = await seedInvoice({
      subtotal: "100.00",
      discount: "10.00",
      tax: "8.00",
      total: "98.00",
      lineRevenueAccounts: [REVENUE],
    });
    const headerId = await createArJournalEntry(db, ORG, "test-user", {
      id: invId,
      invoiceNumber: "INV-TEST",
      customerId: CUSTOMER,
      issueDate: "2026-03-15",
      total: "98.00",
      subtotal: "100.00",
      discountAmount: "10.00",
      taxAmount: "8.00",
    });
    expect(headerId).toBeTruthy();

    const lines = await db
      .select({
        accountId: journalLines.accountId,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, headerId!));

    const debits = lines.reduce((s: number, l: any) => s + Number.parseFloat(l.debit ?? "0"), 0);
    const credits = lines.reduce((s: number, l: any) => s + Number.parseFloat(l.credit ?? "0"), 0);
    // Balanced: DR AR 98 + DR discount 10 = 108; CR revenue 100 + CR tax 8 = 108.
    expect(Math.round(debits * 100) / 100).toBe(108);
    expect(Math.round(credits * 100) / 100).toBe(108);

    const ar = lines.find((l: any) => l.accountId === AR);
    expect(ar?.debit).toBe("98.00000000");
    const tax = lines.find((l: any) => l.accountId === TAX);
    expect(tax?.credit).toBe("8.00000000");
    const disc = lines.find((l: any) => l.accountId === DISCOUNT);
    expect(disc?.debit).toBe("10.00000000");
  });

  it("refuses when only SOME line items have a revenue account (would unbalance)", async () => {
    const invId = await seedInvoice({
      subtotal: "200.00",
      discount: "0",
      tax: "0",
      total: "200.00",
      lineRevenueAccounts: [REVENUE, null], // one line missing an account
    });
    await expect(
      createArJournalEntry(db, ORG, "test-user", {
        id: invId,
        invoiceNumber: "INV-PARTIAL",
        customerId: CUSTOMER,
        issueDate: "2026-03-15",
        total: "200.00",
        subtotal: "200.00",
        discountAmount: "0",
        taxAmount: "0",
      }),
    ).rejects.toThrow(/no revenue account/i);
  });

  it("fails closed when NO line has a revenue account", async () => {
    const invId = await seedInvoice({
      subtotal: "50.00",
      discount: "0",
      tax: "0",
      total: "50.00",
      lineRevenueAccounts: [null],
    });
    await expect(
      createArJournalEntry(db, ORG, "test-user", {
        id: invId,
        invoiceNumber: "INV-NOACCT",
        customerId: CUSTOMER,
        issueDate: "2026-03-15",
        total: "50.00",
        subtotal: "50.00",
        discountAmount: "0",
        taxAmount: "0",
      }),
    ).rejects.toThrow(/every line item needs a revenue account/i);
  });

  it("posts a balanced payment journal (DR bank / CR A/R)", async () => {
    const headerId = await createPaymentJournalEntry(
      db,
      ORG,
      "test-user",
      { id: crypto.randomUUID(), invoiceNumber: "INV-PAY", customerId: CUSTOMER },
      BANK,
      75.5,
    );
    const lines = await db
      .select({
        accountId: journalLines.accountId,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, headerId));

    const bank = lines.find((l: any) => l.accountId === BANK);
    const ar = lines.find((l: any) => l.accountId === AR);
    expect(bank?.debit).toBe("75.50000000");
    expect(ar?.credit).toBe("75.50000000");
    expect(bank?.credit).toBeNull();
    expect(ar?.debit).toBeNull();
  });
});
