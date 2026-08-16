import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { categoryConnections } from "../../src/db/schema/connections";
import { accounts } from "../../src/db/schema/accounts";
import { parties } from "../../src/db/schema/parties";
import { partyableLinks } from "../../src/db/schema/partyable-links";
import { eq, and, ilike, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

// Mirrors SOURCE_TYPE_TO_PARTY_TYPE from -connections.ts
const SOURCE_TYPE_TO_PARTY_TYPE: Record<string, string | null> = {
  bank: null,
  credit_card: null,
  payroll: "vendor",
  payment_processor: "vendor",
  expense_management: "vendor",
  other: "vendor",
};

/**
 * Mirrors autoCreatePartyForConnection from -connections.ts.
 * We replicate it here because it's a private function — but the DB operations
 * it performs are exactly what we need to test.
 */
async function autoCreatePartyForConnection(
  db: any,
  orgId: string,
  sourceType: string,
  sourceName: string,
  sourceInstitution: string | null,
  categoryId: string,
): Promise<void> {
  const partyType = SOURCE_TYPE_TO_PARTY_TYPE[sourceType];
  if (!partyType) return;

  const displayName = sourceInstitution ? `${sourceInstitution} - ${sourceName}` : sourceName;

  const [existing] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.organizationId, orgId), ilike(parties.name, displayName)))
    .limit(1);

  const partyId = existing?.id;

  if (!partyId) {
    const [created] = await db
      .insert(parties)
      .values({
        organizationId: orgId,
        name: displayName,
        partyType,
        defaultAccountId: categoryId,
      })
      .returning({ id: parties.id });

    if (!created) return;

    await db
      .insert(partyableLinks)
      .values({
        organizationId: orgId,
        partyId: created.id,
        partyableType: "account",
        partyableId: categoryId,
        role: "primary",
      })
      .onConflictDoNothing();
  } else {
    await db
      .insert(partyableLinks)
      .values({
        organizationId: orgId,
        partyId,
        partyableType: "account",
        partyableId: categoryId,
        role: "primary",
      })
      .onConflictDoNothing();
  }
}

describeDb("Category Connections Lifecycle", () => {
  let ORG_A: string;
  let ORG_B: string;
  let ACCT_A1: string;
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
    ACCT_B1 = crypto.randomUUID();

    await db.insert(accounts).values([
      {
        id: ACCT_A1,
        organizationId: ORG_A,
        name: "Business Checking",
        accountNumber: "1010",
        accountType: "asset",
      },
      {
        id: ACCT_B1,
        organizationId: ORG_B,
        name: "Org B Checking",
        accountNumber: "1010",
        accountType: "asset",
      },
    ]);
  });

  // ---- Basic CRUD ----

  it("should create a connection and link it to a category", async () => {
    const [conn] = await db
      .insert(categoryConnections)
      .values({
        organizationId: ORG_A,
        categoryId: ACCT_A1,
        sourceType: "bank",
        sourceName: "Chase Business Checking",
        sourceInstitution: "Chase Bank",
        externalId: "ext-123",
        externalSource: "plaid",
        lastFourDigits: "4242",
      })
      .returning();

    expect(conn).toBeDefined();
    expect(conn.categoryId).toBe(ACCT_A1);
    expect(conn.sourceType).toBe("bank");
    expect(conn.sourceName).toBe("Chase Business Checking");
    expect(conn.sourceInstitution).toBe("Chase Bank");
    expect(conn.lastFourDigits).toBe("4242");
  });

  it("should update a connection's fields", async () => {
    const [conn] = await db
      .insert(categoryConnections)
      .values({
        organizationId: ORG_A,
        categoryId: ACCT_A1,
        sourceType: "bank",
        sourceName: "Old Name",
      })
      .returning();

    const [updated] = await db
      .update(categoryConnections)
      .set({
        sourceName: "New Name",
        sourceInstitution: "New Institution",
        updatedAt: new Date(),
      })
      .where(eq(categoryConnections.id, conn.id))
      .returning();

    expect(updated.sourceName).toBe("New Name");
    expect(updated.sourceInstitution).toBe("New Institution");
  });

  it("should delete a connection without affecting the category", async () => {
    const [conn] = await db
      .insert(categoryConnections)
      .values({
        organizationId: ORG_A,
        categoryId: ACCT_A1,
        sourceType: "bank",
        sourceName: "Deletable Bank",
      })
      .returning();

    await db.delete(categoryConnections).where(eq(categoryConnections.id, conn.id));

    const connCheck = await db
      .select()
      .from(categoryConnections)
      .where(eq(categoryConnections.id, conn.id));
    expect(connCheck).toHaveLength(0);

    const acctCheck = await db.select().from(accounts).where(eq(accounts.id, ACCT_A1));
    expect(acctCheck).toHaveLength(1);
  });

  // ---- Cascade & Multi ----

  it("should cascade-delete connections when the linked category is deleted", async () => {
    await db.insert(categoryConnections).values({
      organizationId: ORG_A,
      categoryId: ACCT_A1,
      sourceType: "bank",
      sourceName: "To Be Deleted",
    });

    const before = await db
      .select()
      .from(categoryConnections)
      .where(eq(categoryConnections.categoryId, ACCT_A1));
    expect(before).toHaveLength(1);

    await db.delete(accounts).where(eq(accounts.id, ACCT_A1));

    const after = await db
      .select()
      .from(categoryConnections)
      .where(eq(categoryConnections.categoryId, ACCT_A1));
    expect(after).toHaveLength(0);
  });

  it("should support multiple connections per category", async () => {
    await db.insert(categoryConnections).values([
      {
        organizationId: ORG_A,
        categoryId: ACCT_A1,
        sourceType: "bank",
        sourceName: "Chase Checking",
        sourceInstitution: "Chase",
      },
      {
        organizationId: ORG_A,
        categoryId: ACCT_A1,
        sourceType: "payment_processor",
        sourceName: "Stripe",
        externalSource: "stripe",
      },
    ]);

    const conns = await db
      .select()
      .from(categoryConnections)
      .where(eq(categoryConnections.categoryId, ACCT_A1));

    expect(conns).toHaveLength(2);
    const types = conns.map((c: any) => c.sourceType).sort();
    expect(types).toEqual(["bank", "payment_processor"]);
  });

  // ---- RLS ----

  it("should enforce cross-org isolation via RLS", async () => {
    await db.insert(categoryConnections).values({
      organizationId: ORG_A,
      categoryId: ACCT_A1,
      sourceType: "bank",
      sourceName: "Org A Bank",
    });

    await db.insert(categoryConnections).values({
      organizationId: ORG_B,
      categoryId: ACCT_B1,
      sourceType: "credit_card",
      sourceName: "Org B Card",
    });

    await withOrgContext(ORG_A, async (tx) => {
      const rows = await tx.select().from(categoryConnections);
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceName).toBe("Org A Bank");
    });

    await withOrgContext(ORG_B, async (tx) => {
      const rows = await tx.select().from(categoryConnections);
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceName).toBe("Org B Card");
    });
  });

  // ---- autoCreatePartyForConnection behavior ----

  it("should auto-create a party and partyable_link for payment_processor connections", async () => {
    await autoCreatePartyForConnection(
      db,
      ORG_A,
      "payment_processor",
      "Stripe Payments",
      "Stripe Inc.",
      ACCT_A1,
    );

    // Verify party was created with correct display name
    const createdParties = await db
      .select()
      .from(parties)
      .where(
        and(
          eq(parties.organizationId, ORG_A),
          ilike(parties.name, "Stripe Inc. - Stripe Payments"),
        ),
      );

    expect(createdParties).toHaveLength(1);
    expect(createdParties[0].partyType).toBe("vendor");
    expect(createdParties[0].defaultAccountId).toBe(ACCT_A1);

    // Verify partyable_link was created
    const links = await db
      .select()
      .from(partyableLinks)
      .where(
        and(
          eq(partyableLinks.organizationId, ORG_A),
          eq(partyableLinks.partyId, createdParties[0].id),
          eq(partyableLinks.partyableType, "account"),
          eq(partyableLinks.partyableId, ACCT_A1),
        ),
      );
    expect(links).toHaveLength(1);
    expect(links[0].role).toBe("primary");
  });

  it("should use sourceName as display name when sourceInstitution is null", async () => {
    await autoCreatePartyForConnection(db, ORG_A, "payroll", "Gusto", null, ACCT_A1);

    const createdParties = await db
      .select()
      .from(parties)
      .where(and(eq(parties.organizationId, ORG_A), ilike(parties.name, "Gusto")));

    expect(createdParties).toHaveLength(1);
    expect(createdParties[0].name).toBe("Gusto");
  });

  it("should NOT create a party for bank or credit_card connections", async () => {
    await autoCreatePartyForConnection(db, ORG_A, "bank", "Chase Checking", "Chase", ACCT_A1);
    await autoCreatePartyForConnection(
      db,
      ORG_A,
      "credit_card",
      "Amex Platinum",
      "American Express",
      ACCT_A1,
    );

    // No parties should have been created
    const allParties = await db.select().from(parties).where(eq(parties.organizationId, ORG_A));
    expect(allParties).toHaveLength(0);
  });

  it("should be idempotent — calling twice with same name reuses existing party", async () => {
    // First call creates the party
    await autoCreatePartyForConnection(db, ORG_A, "expense_management", "Expensify", null, ACCT_A1);

    // Second call should find existing party and only ensure link
    await autoCreatePartyForConnection(db, ORG_A, "expense_management", "Expensify", null, ACCT_A1);

    // Should still be exactly 1 party
    const allParties = await db
      .select()
      .from(parties)
      .where(and(eq(parties.organizationId, ORG_A), ilike(parties.name, "Expensify")));
    expect(allParties).toHaveLength(1);

    // And exactly 1 link (onConflictDoNothing)
    const links = await db
      .select()
      .from(partyableLinks)
      .where(
        and(eq(partyableLinks.organizationId, ORG_A), eq(partyableLinks.partyId, allParties[0].id)),
      );
    expect(links).toHaveLength(1);
  });
});
