import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { categoryMappings } from "../../src/db/schema/category-mappings";
import { accounts } from "../../src/db/schema/accounts";
import { eq, and, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Category Mappings", () => {
  let ORG_A: string;
  let ORG_B: string;
  let ACCT_A1: string;
  let ACCT_A2: string;
  let ACCT_B1: string;

  let db: any;
  let sql: postgres.Sql;

  async function withOrgContext<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
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
    ORG_A = crypto.randomUUID();
    ORG_B = crypto.randomUUID();
    ACCT_A1 = crypto.randomUUID();
    ACCT_A2 = crypto.randomUUID();
    ACCT_B1 = crypto.randomUUID();

    await db.insert(accounts).values([
      {
        id: ACCT_A1,
        organizationId: ORG_A,
        name: "Default Expense",
        accountNumber: "5001",
        accountType: "expense",
      },
      {
        id: ACCT_A2,
        organizationId: ORG_A,
        name: "Accounts Payable",
        accountNumber: "2001",
        accountType: "liability",
      },
      {
        id: ACCT_B1,
        organizationId: ORG_B,
        name: "Org B Expense",
        accountNumber: "5001",
        accountType: "expense",
      },
    ]);
  });

  it("should upsert a category mapping (insert then update)", async () => {
    // Insert
    const [inserted] = await db
      .insert(categoryMappings)
      .values({
        organizationId: ORG_A,
        mappingType: "bank",
        sourceKey: "default_expense",
        targetCategoryId: ACCT_A1,
      })
      .returning();

    expect(inserted.sourceKey).toBe("default_expense");
    expect(inserted.targetCategoryId).toBe(ACCT_A1);

    // Upsert (conflict on uq_org_mapping → update)
    const [upserted] = await db
      .insert(categoryMappings)
      .values({
        organizationId: ORG_A,
        mappingType: "bank",
        sourceKey: "default_expense",
        targetCategoryId: ACCT_A2,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          categoryMappings.organizationId,
          categoryMappings.mappingType,
          categoryMappings.sourceKey,
        ],
        set: {
          targetCategoryId: ACCT_A2,
          updatedAt: new Date(),
        },
      })
      .returning();

    expect(upserted.targetCategoryId).toBe(ACCT_A2);
    // Should be the same row (id unchanged)
    expect(upserted.id).toBe(inserted.id);
  });

  it("should enforce unique constraint on (org, mappingType, sourceKey)", async () => {
    await db.insert(categoryMappings).values({
      organizationId: ORG_A,
      mappingType: "bill",
      sourceKey: "accounts_payable",
      targetCategoryId: ACCT_A1,
    });

    // Inserting a duplicate without onConflict should throw
    await expect(
      db.insert(categoryMappings).values({
        organizationId: ORG_A,
        mappingType: "bill",
        sourceKey: "accounts_payable",
        targetCategoryId: ACCT_A2,
      }),
    ).rejects.toThrow();
  });

  it("should allow the same sourceKey for different mappingTypes", async () => {
    await db.insert(categoryMappings).values([
      {
        organizationId: ORG_A,
        mappingType: "bank",
        sourceKey: "default_expense",
        targetCategoryId: ACCT_A1,
      },
      {
        organizationId: ORG_A,
        mappingType: "invoice",
        sourceKey: "default_expense",
        targetCategoryId: ACCT_A2,
      },
    ]);

    const rows = await db
      .select()
      .from(categoryMappings)
      .where(
        and(
          eq(categoryMappings.organizationId, ORG_A),
          eq(categoryMappings.sourceKey, "default_expense"),
        ),
      );

    expect(rows).toHaveLength(2);
  });

  it("should delete a single mapping (revert to default)", async () => {
    await db.insert(categoryMappings).values({
      organizationId: ORG_A,
      mappingType: "bank",
      sourceKey: "default_expense",
      targetCategoryId: ACCT_A1,
    });

    await db
      .delete(categoryMappings)
      .where(
        and(
          eq(categoryMappings.organizationId, ORG_A),
          eq(categoryMappings.mappingType, "bank"),
          eq(categoryMappings.sourceKey, "default_expense"),
        ),
      );

    const after = await db
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.organizationId, ORG_A));
    expect(after).toHaveLength(0);
  });

  it("should reset all mappings for a type", async () => {
    await db.insert(categoryMappings).values([
      {
        organizationId: ORG_A,
        mappingType: "bank",
        sourceKey: "key1",
        targetCategoryId: ACCT_A1,
      },
      {
        organizationId: ORG_A,
        mappingType: "bank",
        sourceKey: "key2",
        targetCategoryId: ACCT_A2,
      },
      {
        organizationId: ORG_A,
        mappingType: "invoice",
        sourceKey: "key3",
        targetCategoryId: ACCT_A1,
      },
    ]);

    // Reset only "bank" type
    await db
      .delete(categoryMappings)
      .where(
        and(eq(categoryMappings.organizationId, ORG_A), eq(categoryMappings.mappingType, "bank")),
      );

    const remaining = await db
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.organizationId, ORG_A));

    expect(remaining).toHaveLength(1);
    expect(remaining[0].mappingType).toBe("invoice");
  });

  it("should enforce cross-org isolation via RLS", async () => {
    await db.insert(categoryMappings).values([
      {
        organizationId: ORG_A,
        mappingType: "bank",
        sourceKey: "org_a_key",
        targetCategoryId: ACCT_A1,
      },
      {
        organizationId: ORG_B,
        mappingType: "bank",
        sourceKey: "org_b_key",
        targetCategoryId: ACCT_B1,
      },
    ]);

    await withOrgContext(ORG_A, async (tx) => {
      const rows = await tx.select().from(categoryMappings);
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceKey).toBe("org_a_key");
    });

    await withOrgContext(ORG_B, async (tx) => {
      const rows = await tx.select().from(categoryMappings);
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceKey).toBe("org_b_key");
    });
  });

  it("should cascade-delete mappings when the target category is deleted", async () => {
    await db.insert(categoryMappings).values({
      organizationId: ORG_A,
      mappingType: "bank",
      sourceKey: "cascade_test",
      targetCategoryId: ACCT_A1,
    });

    // Delete the target account
    await db.delete(accounts).where(eq(accounts.id, ACCT_A1));

    const after = await db
      .select()
      .from(categoryMappings)
      .where(
        and(
          eq(categoryMappings.organizationId, ORG_A),
          eq(categoryMappings.sourceKey, "cascade_test"),
        ),
      );
    expect(after).toHaveLength(0);
  });
});
