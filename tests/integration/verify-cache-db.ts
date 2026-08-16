import { createTestDb } from "../utils/db-utils";
import { documents } from "../../src/db/schema/documents";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { organization } from "../../src/db/schema/auth";

async function run() {
  const { db } = await createTestDb();

  // 1. Create a dummy org
  const orgId = randomUUID();
  await db.insert(organization).values({
    id: orgId,
    name: "Test Org",
    slug: "test-org-" + Date.now(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 2. Create a dummy document
  const docId = randomUUID();
  await db.insert(documents).values({
    id: docId,
    organizationId: orgId,
    r2Key: "test-key",
    originalFilename: "test.pdf",
    uploadedById: "test-user",
    storagePath: "/test/path.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 1024,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 3. Cache a transaction result using the DB directly (simulating the server function)
  const fakeResult = { transactionType: "pay_out", amount: "100.00" };
  await db
    .update(documents)
    .set({
      aiTransactionCache: {
        result: fakeResult,
        cachedAt: new Date().toISOString(),
        contextHash: "abc123hash",
      },
    })
    .where(eq(documents.id, docId));

  // 4. Retrieve it to ensure JSONB is working
  const [doc] = await db
    .select({ aiTransactionCache: documents.aiTransactionCache })
    .from(documents)
    .where(eq(documents.id, docId));

  console.log("Cached result retrieved from DB:");
  console.log(JSON.stringify(doc.aiTransactionCache, null, 2));

  process.exit(0);
}

run().catch(console.error);
