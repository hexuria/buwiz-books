import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { invoices } from "../../src/db/schema/invoices";
import { parties } from "../../src/db/schema/parties";
import { eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("Cross-Organization Isolation (RLS)", () => {
  let ORG_A: string;
  let ORG_B: string;

  let ACC_A_1: string;
  let ACC_B_1: string;
  let INV_A_1: string;
  let INV_B_1: string;

  let db: any;
  let sql: postgres.Sql;

  async function withTestOrgContext<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // We do not rely on clearTestData for uniqueness now, everything gets a new UUID

    ORG_A = crypto.randomUUID();
    ORG_B = crypto.randomUUID();

    ACC_A_1 = crypto.randomUUID();
    ACC_B_1 = crypto.randomUUID();
    INV_A_1 = crypto.randomUUID();
    INV_B_1 = crypto.randomUUID();

    // Seed data directly bypassing RLS (app.current_organization_id IS NULL)

    // Org A data
    const orgACustomerId = crypto.randomUUID();
    await db.insert(parties).values({
      id: orgACustomerId,
      organizationId: ORG_A,
      name: "Org A Customer",
      partyType: "customer",
      status: "active",
    });

    await db.insert(accounts).values({
      id: ACC_A_1,
      organizationId: ORG_A,
      name: "Org A Asset",
      accountNumber: "10001",
      accountType: "asset",
    });

    await db.insert(invoices).values({
      id: INV_A_1,
      organizationId: ORG_A,
      invoiceNumber: `INV-A-${crypto.randomUUID().slice(0, 8)}`,
      customerId: orgACustomerId,
      status: "draft",
      issueDate: "2026-01-01",
      dueDate: "2026-01-31",
      subtotal: "100.00",
      total: "100.00",
      balanceDue: "100.00",
    });

    // Org B data
    const orgBCustomerId = crypto.randomUUID();
    await db.insert(parties).values({
      id: orgBCustomerId,
      organizationId: ORG_B,
      name: "Org B Customer",
      partyType: "customer",
      status: "active",
    });

    await db.insert(accounts).values({
      id: ACC_B_1,
      organizationId: ORG_B,
      name: "Org B Asset",
      accountNumber: "10002",
      accountType: "asset",
    });

    await db.insert(invoices).values({
      id: INV_B_1,
      organizationId: ORG_B,
      invoiceNumber: `INV-B-${crypto.randomUUID().slice(0, 8)}`,
      customerId: orgBCustomerId,
      status: "draft",
      issueDate: "2026-01-01",
      dueDate: "2026-01-31",
      subtotal: "200.00",
      total: "200.00",
      balanceDue: "200.00",
    });
  });

  it("should only return Org A data when in Org A context", async () => {
    await withTestOrgContext(ORG_A, async (tx) => {
      // Test accounts
      const orgAAccounts = await tx.select().from(accounts);
      expect(orgAAccounts).toHaveLength(1);
      expect(orgAAccounts[0].organizationId).toBe(ORG_A);
      expect(orgAAccounts[0].name).toBe("Org A Asset");

      // Test invoices (a newly RLS-protected table)
      const orgAInvoices = await tx.select().from(invoices);
      expect(orgAInvoices).toHaveLength(1);
      expect(orgAInvoices[0].organizationId).toBe(ORG_A);
      expect(orgAInvoices[0].invoiceNumber).toMatch(/^INV-A-/);
    });
  });

  it("should only return Org B data when in Org B context", async () => {
    await withTestOrgContext(ORG_B, async (tx) => {
      const orgBInvoices = await tx.select().from(invoices);
      expect(orgBInvoices).toHaveLength(1);
      expect(orgBInvoices[0].organizationId).toBe(ORG_B);
      expect(orgBInvoices[0].invoiceNumber).toMatch(/^INV-B-/);
    });
  });

  it("should prevent updating Org B data from Org A context", async () => {
    await withTestOrgContext(ORG_A, async (tx) => {
      // Try to maliciously update Org B's invoice
      const updateResult = await tx
        .update(invoices)
        .set({ status: "paid" })
        .where(eq(invoices.id, INV_B_1))
        .returning();

      // Should return empty array (0 rows affected) because RLS hid the row
      expect(updateResult).toHaveLength(0);
    });

    // Verify Org B invoice is still draft using raw admin connection
    const verify = await db.select().from(invoices).where(eq(invoices.id, INV_B_1));

    expect(verify[0].status).toBe("draft");
  });

  it("should prevent deleting Org B data from Org A context", async () => {
    await withTestOrgContext(ORG_A, async (tx) => {
      // Try to maliciously delete Org B's account
      const deleteResult = await tx.delete(accounts).where(eq(accounts.id, ACC_B_1)).returning();

      expect(deleteResult).toHaveLength(0);
    });

    // Verify Org B account still exists
    const verify = await db.select().from(accounts).where(eq(accounts.id, ACC_B_1));

    expect(verify).toHaveLength(1);
  });
});
