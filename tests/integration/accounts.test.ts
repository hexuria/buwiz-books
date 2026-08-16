import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { eq } from "drizzle-orm";
import postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Account Integration Tests", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // Tests run in parallel, do not truncate db here
  });

  it("should create a new account in the database", async () => {
    const orgId = crypto.randomUUID();
    const newAccount = {
      organizationId: orgId,
      name: "Business Checking",
      accountNumber: `11001-${crypto.randomUUID().slice(0, 4)}`,
      accountType: "asset" as const,
      subtype: "bank_accounts" as const,
    };

    const inserted = await db.insert(accounts).values(newAccount).returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].name).toBe("Business Checking");
    expect(inserted[0].id).toBeDefined();

    // Verify it exists by querying
    const found = await db.query.accounts.findFirst({
      where: eq(accounts.id, inserted[0].id),
    });

    expect(found).toBeDefined();
    expect(found?.accountNumber).toBe(newAccount.accountNumber);
  });

  it("should enforce unique account numbers if applicable", async () => {
    const orgId = crypto.randomUUID();
    await db.insert(accounts).values({
      organizationId: orgId,
      name: "Savings",
      accountNumber: `12000-${crypto.randomUUID().slice(0, 4)}`,
      accountType: "asset" as const,
    });

    const secondAccount = await db
      .insert(accounts)
      .values({
        organizationId: orgId,
        name: "Payroll",
        accountNumber: `12001-${crypto.randomUUID().slice(0, 4)}`,
        accountType: "asset" as const,
      })
      .returning();

    expect(secondAccount).toHaveLength(1);
  });
});
