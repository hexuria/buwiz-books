import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { organization } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import { ensureDocument, hashDocumentContent } from "@/lib/documents/ensure-document";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function fakeStorage(uploadBarrier?: () => Promise<void>) {
  const uploadedKeys: string[] = [];
  const deletedKeys: string[] = [];
  return {
    uploadedKeys,
    deletedKeys,
    adapter: {
      isConfigured: () => true,
      upload: async (key: string) => {
        uploadedKeys.push(key);
        await uploadBarrier?.();
        return { r2Key: key, r2Bucket: "test-bucket" };
      },
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    },
  };
}

describeDb("content-addressed document ingestion", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sqlClient: postgres.Sql;
  let organizationId: string;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  beforeEach(async () => {
    organizationId = `ensure-document-${randomUUID()}`;
    await db.insert(organization).values({
      id: organizationId,
      name: "Ensure Document Test",
      slug: organizationId,
    });
  });

  it("reuses an existing organization-scoped document without uploading again", async () => {
    const bytes = Buffer.from("same receipt");
    const storage = fakeStorage();
    const input = {
      organizationId,
      filename: "receipt.pdf",
      contentType: "application/pdf",
      fileBuffer: bytes,
      documentType: "receipt" as const,
    };

    const first = await ensureDocument(db, input, storage.adapter);
    const second = await ensureDocument(db, input, storage.adapter);

    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ document: first.document, deduplicated: true });
    expect(storage.uploadedKeys).toHaveLength(1);
    expect(storage.deletedKeys).toEqual([]);
  });

  it("concurrent same-content uploads converge and clean only the losing generation", async () => {
    const bytes = Buffer.from("concurrent receipt");
    const secondConnection = await createTestDb();
    let uploadsReached = 0;
    let releaseUploads!: () => void;
    const bothUploaded = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const uploadBarrier = async () => {
      uploadsReached += 1;
      if (uploadsReached === 2) releaseUploads();
      await bothUploaded;
    };
    const firstStorage = fakeStorage(uploadBarrier);
    const secondStorage = fakeStorage(uploadBarrier);
    const input = {
      organizationId,
      filename: "receipt.pdf",
      contentType: "application/pdf",
      fileBuffer: bytes,
      documentType: "receipt" as const,
    };

    const [first, second] = await Promise.all([
      ensureDocument(db, input, firstStorage.adapter),
      ensureDocument(secondConnection.db, input, secondStorage.adapter),
    ]).finally(() => secondConnection.sql.end());

    expect(first.document.id).toBe(second.document.id);
    expect([first.deduplicated, second.deduplicated].sort()).toEqual([false, true]);

    const rows = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.contentHash, hashDocumentContent(bytes)),
        ),
      );
    expect(rows).toHaveLength(1);

    const uploadedKeys = [...firstStorage.uploadedKeys, ...secondStorage.uploadedKeys];
    const deletedKeys = [...firstStorage.deletedKeys, ...secondStorage.deletedKeys];
    expect(uploadedKeys).toHaveLength(2);
    expect(uploadsReached).toBe(2);
    expect(new Set(uploadedKeys).size).toBe(2);
    expect(deletedKeys).toHaveLength(1);
    expect(deletedKeys[0]).not.toBe(rows[0].r2Key);
  });
});
