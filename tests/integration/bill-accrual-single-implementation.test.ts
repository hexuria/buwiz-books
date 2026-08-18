/**
 * One bill-accrual posting, not two.
 *
 * `createApAccrualJournal` (routes/api/-bills.ts) and
 * `ensureBillAccrualJournal` (lib/manual-bill-payment.ts) posted the same
 * journal from two separate implementations. Both had to be repaired in
 * parallel for the same three defects — a missing functional currency, a
 * float-summed A/P credit that could not equal the raw debit lines it
 * offsets, and the period-lock guard. The invoice A/R posting had already
 * been through the same thing: a third copy sat dead in lib/invoice-journal.ts
 * until it was deleted.
 *
 * These assert the behaviour of the surviving service AND that the forks have
 * not grown back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { organization } from "../../src/db/schema/auth";
import { postBillAccrualJournal } from "../../src/lib/bill-journal";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("bill accrual — one implementation", () => {
  let db: any;
  let sql: postgres.Sql;
  let ORG: string;
  let expenseAccount: string;
  let apAccount: string;
  let vendorId: string;

  beforeAll(async () => {
    const conn = await createTestDb();
    db = conn.db;
    sql = conn.sql;
    ORG = crypto.randomUUID();
    // A real organization row: accounting settings and the period lock both
    // key off it by foreign key.
    await db.insert(organization).values({
      id: ORG,
      name: "Bill Accrual Test Org",
      slug: `bill-accrual-${Date.now()}`,
    });

    // Accounts must belong to THIS organization: the mapping resolver joins
    // accounts on organization_id, so borrowing the seeded org's chart would
    // silently resolve to nothing.
    const [ap] = await sql`
      INSERT INTO accounts (organization_id, account_number, name, account_type, subtype, is_active)
      VALUES (${ORG}, '2000', 'Accounts Payable', 'liability', 'accounts_payable', true)
      RETURNING id`;
    const [expense] = await sql`
      INSERT INTO accounts (organization_id, account_number, name, account_type, is_active)
      VALUES (${ORG}, '6000', 'Office Supplies', 'expense', true)
      RETURNING id`;
    apAccount = ap.id as string;
    expenseAccount = expense.id as string;

    const [party] = await sql`
      INSERT INTO parties (organization_id, name, party_type)
      VALUES (${ORG}, 'Test Vendor', 'vendor') RETURNING id`;
    vendorId = party.id as string;

    // The service resolves A/P through the mapping table.
    await sql`
      INSERT INTO category_mappings (organization_id, mapping_type, source_key, target_category_id)
      VALUES (${ORG}, 'bill', 'accounts_payable', ${apAccount})
      ON CONFLICT DO NOTHING`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function makeBill(amounts: string[]): Promise<any> {
    const total = amounts.reduce((s, a) => s + Number(a), 0).toFixed(2);
    const [bill] = await sql`
      INSERT INTO bills (organization_id, vendor_id, bill_number, bill_date, due_date, amount, balance_due, status)
      VALUES (${ORG}, ${vendorId}, ${`B-${crypto.randomUUID().slice(0, 6)}`},
              '2026-06-10', '2026-07-10', ${total}, ${total}, 'in_review')
      RETURNING *`;
    let sortOrder = 0;
    for (const amount of amounts) {
      await sql`
        INSERT INTO bill_line_items (bill_id, account_id, amount, description, sort_order)
        VALUES (${bill.id}, ${expenseAccount}, ${amount}, 'Line', ${sortOrder++})`;
    }
    return {
      ...bill,
      id: bill.id,
      billNumber: bill.bill_number,
      billDate: bill.bill_date,
      vendorId,
      journalHeaderId: null,
    };
  }

  it("posts DR expense / CR A/P and balances exactly", async () => {
    const bill = await makeBill(["100.00", "50.00"]);
    const headerId = await db.transaction((tx: any) =>
      postBillAccrualJournal(tx, { organizationId: ORG, userId: "u", bill }),
    );

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, headerId))
      .orderBy(journalLines.sortOrder);

    expect(lines).toHaveLength(3);
    expect(lines[2].accountId).toBe(apAccount);
    expect(lines[2].credit).toBe("150.00000000");

    const [totals] = await sql`
      SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines
      WHERE journal_header_id = ${headerId}`;
    expect(Number(totals.d)).toBe(Number(totals.c));
  });

  it("keeps the A/P credit exactly equal to the sum of the debit lines", async () => {
    // The invariant the consolidation protects. Both copies computed the
    // credit as a FLOAT sum passed through .toFixed(2) while the debit lines
    // used each line's stored amount, so the two sides were derived
    // differently and could disagree. They now come from one exact sum.
    //
    // `bill_line_items.amount` is decimal(15,2), so a sub-centavo LINE is
    // rounded away by Postgres on insert and cannot reach this code — the
    // exposure is float drift across many lines, which is what this exercises.
    const bill = await makeBill(Array.from({ length: 60 }, () => "0.07"));
    const headerId = await db.transaction((tx: any) =>
      postBillAccrualJournal(tx, { organizationId: ORG, userId: "u", bill }),
    );

    const [totals] = await sql`
      SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines
      WHERE journal_header_id = ${headerId}`;
    expect(totals.d).toEqual(totals.c);
    expect(Number(totals.c)).toBe(4.2);

    // And the cached header total agrees with the lines rather than being a
    // separately-rounded number.
    const [header] = await db.select().from(journalHeaders).where(eq(journalHeaders.id, headerId));
    expect(Number(header.totalAmount)).toBe(Number(totals.d));
  });

  it("stamps the organization's functional currency, not the USD column default", async () => {
    await sql`
      INSERT INTO organization_accounting_settings (organization_id, base_currency)
      VALUES (${ORG}, 'PHP')
      ON CONFLICT (organization_id) DO UPDATE SET base_currency = 'PHP'`;

    const bill = await makeBill(["25.00"]);
    const headerId = await db.transaction((tx: any) =>
      postBillAccrualJournal(tx, { organizationId: ORG, userId: "u", bill }),
    );

    const [header] = await db.select().from(journalHeaders).where(eq(journalHeaders.id, headerId));
    expect(header.functionalCurrency).toBe("PHP");
  });

  it("returns the existing journal instead of posting a second accrual", async () => {
    const bill = await makeBill(["40.00"]);
    const first = await db.transaction((tx: any) =>
      postBillAccrualJournal(tx, { organizationId: ORG, userId: "u", bill }),
    );
    const second = await db.transaction((tx: any) =>
      postBillAccrualJournal(tx, {
        organizationId: ORG,
        userId: "u",
        bill: { ...bill, journalHeaderId: first },
      }),
    );
    expect(second).toBe(first);
  });

  it("refuses to post into a closed period", async () => {
    const bill = await makeBill(["10.00"]);
    // The period lock lives on the organization row itself.
    await sql`UPDATE auth_organizations SET closed_through = '2026-12-31' WHERE id = ${ORG}`;

    await expect(
      db.transaction((tx: any) =>
        postBillAccrualJournal(tx, { organizationId: ORG, userId: "u", bill }),
      ),
    ).rejects.toThrow(/locked through/);

    await sql`UPDATE auth_organizations SET closed_through = NULL WHERE id = ${ORG}`;
  });

  describe("the forks stay gone", () => {
    it("has no second bill-accrual implementation in the route or payment modules", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const read = (p: string) => readFileSync(resolve(import.meta.dirname, "../../", p), "utf8");

      const route = read("src/routes/api/-bills.ts");
      const payment = read("src/lib/manual-bill-payment.ts");

      expect(route).not.toContain("createApAccrualJournal");
      expect(payment).not.toContain("ensureBillAccrualJournal");
      // Both must go through the shared service.
      expect(route).toContain("postBillAccrualJournal");
      expect(payment).toContain("postBillAccrualJournal");
    });

    it("leaves exactly one module inserting a bill-accrual header", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const read = (p: string) => readFileSync(resolve(import.meta.dirname, "../../", p), "utf8");
      const owners = [
        "src/routes/api/-bills.ts",
        "src/lib/manual-bill-payment.ts",
        "src/lib/bill-journal.ts",
      ].filter((p) => read(p).includes("idempotencyKey: `bill-accrual:"));

      expect(owners).toEqual(["src/lib/bill-journal.ts"]);
    });
  });
});
