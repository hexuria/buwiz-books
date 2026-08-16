import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { documents } from "../../src/db/schema/documents";
import { eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Document Owner-Based ABAC (RLS)", () => {
  let ORG_A: string;
  let ORG_B: string;
  let USER_A1: string; // Owner in Org A
  let USER_A2: string; // Another member in Org A
  let ADMIN_A: string; // Admin in Org A
  let USER_B1: string; // Member in Org B

  let DOC_A1: string;
  let DOC_B1: string;

  let db: any;
  let sql: postgres.Sql;

  async function withTestContext<T>(
    orgId: string,
    userId: string,
    role: string,
    fn: (tx: any) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      await tx.execute(drizzleSql`SELECT set_config('app.user_role', ${role}, true)`);
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
    USER_A1 = crypto.randomUUID();
    USER_A2 = crypto.randomUUID();
    ADMIN_A = crypto.randomUUID();
    USER_B1 = crypto.randomUUID();
    DOC_A1 = crypto.randomUUID();
    DOC_B1 = crypto.randomUUID();

    // Seed data directly bypassing RLS (app.current_organization_id IS NULL)
    await db.insert(documents).values([
      {
        id: DOC_A1,
        organizationId: ORG_A,
        uploadedById: USER_A1,
        originalFilename: "org-a-doc.pdf",
        storagePath: "docs/org-a-doc.pdf",
        fileType: "pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
      },
      {
        id: DOC_B1,
        organizationId: ORG_B,
        uploadedById: USER_B1,
        originalFilename: "org-b-doc.pdf",
        storagePath: "docs/org-b-doc.pdf",
        fileType: "pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
      },
    ]);
  });

  // ---- SELECT policies ----

  it("should allow any org member to SELECT their org's documents", async () => {
    // Owner can read
    await withTestContext(ORG_A, USER_A1, "member", async (tx) => {
      const docs = await tx.select().from(documents);
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe(DOC_A1);
    });

    // Other member in same org can also read
    await withTestContext(ORG_A, USER_A2, "member", async (tx) => {
      const docs = await tx.select().from(documents);
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe(DOC_A1);
    });
  });

  it("should prevent cross-org SELECT (Org B member cannot see Org A docs)", async () => {
    await withTestContext(ORG_B, USER_B1, "member", async (tx) => {
      const docs = await tx.select().from(documents);
      // Should only see Org B's document, not Org A's
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe(DOC_B1);
      expect(docs[0].organizationId).toBe(ORG_B);
    });

    // Explicitly try to SELECT Org A's doc from Org B context
    await withTestContext(ORG_B, USER_B1, "member", async (tx) => {
      const result = await tx.select().from(documents).where(eq(documents.id, DOC_A1));
      expect(result).toHaveLength(0);
    });
  });

  // ---- UPDATE policies ----

  it("should prevent non-owners from UPDATEing the document", async () => {
    await withTestContext(ORG_A, USER_A2, "member", async (tx) => {
      const updateResult = await tx
        .update(documents)
        .set({ displayTitle: "updated by non-owner" })
        .where(eq(documents.id, DOC_A1))
        .returning();

      // RLS hides the row for UPDATE, so 0 rows affected
      expect(updateResult).toHaveLength(0);
    });

    // Verify it wasn't updated
    const verify = await db.select().from(documents).where(eq(documents.id, DOC_A1));
    expect(verify[0].displayTitle).not.toBe("updated by non-owner");
  });

  it("should allow owners to UPDATE the document", async () => {
    await withTestContext(ORG_A, USER_A1, "member", async (tx) => {
      const updateResult = await tx
        .update(documents)
        .set({ displayTitle: "updated by owner" })
        .where(eq(documents.id, DOC_A1))
        .returning();

      expect(updateResult).toHaveLength(1);
      expect(updateResult[0].displayTitle).toBe("updated by owner");
    });
  });

  it("should allow admins to UPDATE the document even if not owner", async () => {
    await withTestContext(ORG_A, ADMIN_A, "admin", async (tx) => {
      const updateResult = await tx
        .update(documents)
        .set({ displayTitle: "updated by admin" })
        .where(eq(documents.id, DOC_A1))
        .returning();

      expect(updateResult).toHaveLength(1);
      expect(updateResult[0].displayTitle).toBe("updated by admin");
    });
  });

  it("should prevent cross-org UPDATE (Org B member cannot update Org A docs)", async () => {
    await withTestContext(ORG_B, USER_B1, "admin", async (tx) => {
      // Even as admin in Org B, should not be able to update Org A's doc
      const updateResult = await tx
        .update(documents)
        .set({ displayTitle: "cross-org attack" })
        .where(eq(documents.id, DOC_A1))
        .returning();

      expect(updateResult).toHaveLength(0);
    });

    // Verify untouched
    const verify = await db.select().from(documents).where(eq(documents.id, DOC_A1));
    expect(verify[0].displayTitle).not.toBe("cross-org attack");
  });

  // ---- DELETE policies ----

  it("should prevent non-owners from DELETEing the document", async () => {
    await withTestContext(ORG_A, USER_A2, "member", async (tx) => {
      const deleteResult = await tx.delete(documents).where(eq(documents.id, DOC_A1)).returning();
      expect(deleteResult).toHaveLength(0);
    });

    // Verify it wasn't deleted
    const verify = await db.select().from(documents).where(eq(documents.id, DOC_A1));
    expect(verify).toHaveLength(1);
  });

  it("should allow owners to DELETE the document", async () => {
    await withTestContext(ORG_A, USER_A1, "member", async (tx) => {
      const deleteResult = await tx.delete(documents).where(eq(documents.id, DOC_A1)).returning();
      expect(deleteResult).toHaveLength(1);
    });

    // Verify it was deleted
    const verify = await db.select().from(documents).where(eq(documents.id, DOC_A1));
    expect(verify).toHaveLength(0);
  });

  it("should allow admins to DELETE the document even if not owner", async () => {
    await withTestContext(ORG_A, ADMIN_A, "admin", async (tx) => {
      const deleteResult = await tx.delete(documents).where(eq(documents.id, DOC_A1)).returning();
      expect(deleteResult).toHaveLength(1);
    });

    const verify = await db.select().from(documents).where(eq(documents.id, DOC_A1));
    expect(verify).toHaveLength(0);
  });

  it("should prevent cross-org DELETE (Org B admin cannot delete Org A docs)", async () => {
    await withTestContext(ORG_B, USER_B1, "admin", async (tx) => {
      const deleteResult = await tx.delete(documents).where(eq(documents.id, DOC_A1)).returning();
      expect(deleteResult).toHaveLength(0);
    });

    // Verify still exists
    const verify = await db.select().from(documents).where(eq(documents.id, DOC_A1));
    expect(verify).toHaveLength(1);
  });
});
