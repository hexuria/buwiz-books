import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { documents } from "../../src/db/schema/documents";
import { reconciliations } from "../../src/db/schema/reconciliations";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { eq } from "drizzle-orm";
import postgres from "postgres";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Document Deletion Safeguard Logic", () => {
  let db: any;
  let sql: postgres.Sql;
  const orgId = "test-org-id";

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // tests run in parallel, do not truncate
  });

  it("should detect if a document is linked to a reconciliation", async () => {
    // 1. Setup: Create Bank Account
    const [bank] = await db
      .insert(financialAccounts)
      .values({
        organizationId: orgId,
        accountName: "Test Bank",
        accountType: "checking",
        // subtype: "credit_cards", // Using valid subtype from enum if needed, assuming string for now based on previous file reads
        // Add other required fields if any (schema seems to have defaults or nulls)
      })
      .returning();

    // 2. Setup: Create Document
    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "statement.pdf",
        storagePath: "path/to/statement.pdf",
        // Defaults handling...
      })
      .returning();

    // 3. Setup: Create Reconciliation linked to Document
    await db.insert(reconciliations).values({
      organizationId: orgId,
      bankAccountId: bank.id,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      statementDocumentId: doc.id,
      status: "in_progress",
    });

    // 4. Test: The Safeguard Query
    // This replicates the logic added to deleteDocument
    const [linkedRecon] = await db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(eq(reconciliations.statementDocumentId, doc.id))
      .limit(1);

    expect(linkedRecon).toBeDefined();
    expect(linkedRecon.id).toBeDefined();

    // 5. Test: Unlink
    await db
      .update(reconciliations)
      .set({ statementDocumentId: null })
      .where(eq(reconciliations.statementDocumentId, doc.id));

    // 6. Test: Verify query returns nothing
    const [linkedReconAfter] = await db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(eq(reconciliations.statementDocumentId, doc.id))
      .limit(1);

    expect(linkedReconAfter).toBeUndefined();
  });
});
