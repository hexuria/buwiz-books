import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { partyTypeMappings } from "../../src/db/schema/party-type-mappings";
import { eq, and, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Party Type Mappings", () => {
  let ORG_A: string;
  let ORG_B: string;

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
  });

  it("should upsert a party type mapping (insert then update)", async () => {
    // Insert
    const [inserted] = await db
      .insert(partyTypeMappings)
      .values({
        organizationId: ORG_A,
        subtype: "accounts_payable",
        readTypes: ["vendor", "lender"],
        mutateTypes: ["vendor"],
      })
      .returning();

    expect(inserted.subtype).toBe("accounts_payable");
    expect(inserted.readTypes).toEqual(["vendor", "lender"]);
    expect(inserted.mutateTypes).toEqual(["vendor"]);

    // Upsert (conflict on uq_org_subtype → update)
    const [upserted] = await db
      .insert(partyTypeMappings)
      .values({
        organizationId: ORG_A,
        subtype: "accounts_payable",
        readTypes: ["vendor", "lender", "employee"],
        mutateTypes: ["vendor", "lender"],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [partyTypeMappings.organizationId, partyTypeMappings.subtype],
        set: {
          readTypes: ["vendor", "lender", "employee"],
          mutateTypes: ["vendor", "lender"],
          updatedAt: new Date(),
        },
      })
      .returning();

    expect(upserted.readTypes).toEqual(["vendor", "lender", "employee"]);
    expect(upserted.mutateTypes).toEqual(["vendor", "lender"]);
    expect(upserted.id).toBe(inserted.id);
  });

  it("should enforce unique constraint on (org, subtype)", async () => {
    await db.insert(partyTypeMappings).values({
      organizationId: ORG_A,
      subtype: "bank_accounts",
      readTypes: ["vendor"],
      mutateTypes: ["vendor"],
    });

    await expect(
      db.insert(partyTypeMappings).values({
        organizationId: ORG_A,
        subtype: "bank_accounts",
        readTypes: ["customer"],
        mutateTypes: ["customer"],
      }),
    ).rejects.toThrow();
  });

  it("should allow the same subtype for different organizations", async () => {
    await db.insert(partyTypeMappings).values([
      {
        organizationId: ORG_A,
        subtype: "accounts_payable",
        readTypes: ["vendor"],
        mutateTypes: ["vendor"],
      },
      {
        organizationId: ORG_B,
        subtype: "accounts_payable",
        readTypes: ["vendor", "employee"],
        mutateTypes: ["vendor"],
      },
    ]);

    const orgARows = await db
      .select()
      .from(partyTypeMappings)
      .where(eq(partyTypeMappings.organizationId, ORG_A));
    const orgBRows = await db
      .select()
      .from(partyTypeMappings)
      .where(eq(partyTypeMappings.organizationId, ORG_B));

    expect(orgARows).toHaveLength(1);
    expect(orgBRows).toHaveLength(1);
    // Org B has the expanded readTypes
    expect(orgBRows[0].readTypes).toContain("employee");
  });

  it("should delete a single subtype override (revert to default)", async () => {
    await db.insert(partyTypeMappings).values({
      organizationId: ORG_A,
      subtype: "accounts_payable",
      readTypes: ["vendor"],
      mutateTypes: ["vendor"],
    });

    await db
      .delete(partyTypeMappings)
      .where(
        and(
          eq(partyTypeMappings.organizationId, ORG_A),
          eq(partyTypeMappings.subtype, "accounts_payable"),
        ),
      );

    const after = await db
      .select()
      .from(partyTypeMappings)
      .where(eq(partyTypeMappings.organizationId, ORG_A));
    expect(after).toHaveLength(0);
  });

  it("should reset all overrides for an organization", async () => {
    await db.insert(partyTypeMappings).values([
      {
        organizationId: ORG_A,
        subtype: "accounts_payable",
        readTypes: ["vendor"],
        mutateTypes: ["vendor"],
      },
      {
        organizationId: ORG_A,
        subtype: "bank_accounts",
        readTypes: ["vendor", "lender"],
        mutateTypes: ["vendor"],
      },
    ]);

    // Reset all for ORG_A
    await db.delete(partyTypeMappings).where(eq(partyTypeMappings.organizationId, ORG_A));

    const after = await db
      .select()
      .from(partyTypeMappings)
      .where(eq(partyTypeMappings.organizationId, ORG_A));
    expect(after).toHaveLength(0);
  });

  it("should enforce cross-org isolation via RLS", async () => {
    await db.insert(partyTypeMappings).values([
      {
        organizationId: ORG_A,
        subtype: "org_a_subtype",
        readTypes: ["vendor"],
        mutateTypes: ["vendor"],
      },
      {
        organizationId: ORG_B,
        subtype: "org_b_subtype",
        readTypes: ["customer"],
        mutateTypes: ["customer"],
      },
    ]);

    await withOrgContext(ORG_A, async (tx) => {
      const rows = await tx.select().from(partyTypeMappings);
      expect(rows).toHaveLength(1);
      expect(rows[0].subtype).toBe("org_a_subtype");
    });

    await withOrgContext(ORG_B, async (tx) => {
      const rows = await tx.select().from(partyTypeMappings);
      expect(rows).toHaveLength(1);
      expect(rows[0].subtype).toBe("org_b_subtype");
    });
  });

  it("should store and retrieve JSONB arrays correctly", async () => {
    const readTypes = ["vendor", "customer", "employee", "shareholder", "lender"];
    const mutateTypes = ["vendor", "customer"];

    const [row] = await db
      .insert(partyTypeMappings)
      .values({
        organizationId: ORG_A,
        subtype: "jsonb_test",
        readTypes,
        mutateTypes,
      })
      .returning();

    expect(row.readTypes).toEqual(readTypes);
    expect(row.mutateTypes).toEqual(mutateTypes);
    expect(Array.isArray(row.readTypes)).toBe(true);
    expect(Array.isArray(row.mutateTypes)).toBe(true);
  });
});
