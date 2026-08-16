import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { documents, documentTypeEnum, fileTypeEnum } from "@/db/schema/documents";
import { deleteFromR2, isR2Configured, uploadToR2 } from "@/lib/storage";

type Document = typeof documents.$inferSelect;
type DocumentType = (typeof documentTypeEnum.enumValues)[number];
type FileType = (typeof fileTypeEnum.enumValues)[number];

export interface EnsureDocumentInput {
  organizationId: string;
  uploadedById?: string | null;
  filename: string;
  contentType: string;
  fileBuffer: Buffer;
  documentType?: DocumentType;
  displayTitle?: string;
  metadata?: Document["metadata"];
}

export interface EnsureDocumentResult {
  document: Document;
  deduplicated: boolean;
}

interface DocumentStorage {
  isConfigured(): boolean;
  upload(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ r2Key: string; r2Bucket: string }>;
  delete?(key: string): Promise<void>;
}

const defaultStorage: DocumentStorage = {
  isConfigured: isR2Configured,
  upload: uploadToR2,
  delete: deleteFromR2,
};

export function hashDocumentContent(fileBuffer: Buffer): string {
  return createHash("sha256").update(fileBuffer).digest("hex");
}

export function contentAddressedDocumentKey(
  organizationId: string,
  contentHash: string,
  generationId: string = randomUUID(),
): string {
  return `${organizationId}/documents/sha256/${contentHash.slice(0, 2)}/${contentHash}/${generationId}`;
}

export function documentFileType(filename: string): FileType {
  const extension = filename.split(".").pop()?.toLowerCase();
  const supported = new Set<FileType>([
    "pdf",
    "xlsx",
    "xls",
    "csv",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "zip",
    "docx",
    "doc",
  ]);
  return extension && supported.has(extension as FileType) ? (extension as FileType) : "other";
}

/**
 * Store a document once per organization and content hash.
 *
 * Database identity remains content-addressed through the partial unique index over
 * (organization_id, content_hash), while each physical object uses a generation-unique key.
 * This is deliberate: cleanup for a deleted document can never race with a same-hash re-upload
 * and delete the new generation. A concurrent losing uploader returns the winning row and
 * best-effort removes only its own unreferenced generation.
 */
export async function ensureDocument(
  db: DbExecutor,
  input: EnsureDocumentInput,
  storage: DocumentStorage = defaultStorage,
): Promise<EnsureDocumentResult> {
  const contentHash = hashDocumentContent(input.fileBuffer);
  const existing = await findDocumentByHash(db, input.organizationId, contentHash);
  if (existing) {
    return { document: existing, deduplicated: true };
  }

  if (!storage.isConfigured()) {
    throw new Error("R2 is not configured");
  }

  const storageKey = contentAddressedDocumentKey(input.organizationId, contentHash);
  const uploaded = await storage.upload(storageKey, input.fileBuffer, input.contentType);
  const storagePath = `r2://${uploaded.r2Bucket}/${uploaded.r2Key}`;

  const [created] = await db
    .insert(documents)
    .values({
      organizationId: input.organizationId,
      originalFilename: input.filename,
      displayTitle: input.displayTitle ?? input.filename,
      documentType: input.documentType ?? "other",
      fileType: documentFileType(input.filename),
      storagePath,
      fileSizeBytes: input.fileBuffer.length,
      mimeType: input.contentType,
      contentHash,
      r2Key: uploaded.r2Key,
      r2Bucket: uploaded.r2Bucket,
      metadata: input.metadata,
      uploadedById: input.uploadedById ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { document: created, deduplicated: false };
  }

  const concurrent = await findDocumentByHash(db, input.organizationId, contentHash);
  if (!concurrent) {
    throw new Error("Unable to persist uploaded document");
  }

  if (storage.delete && uploaded.r2Key !== concurrent.r2Key) {
    try {
      await storage.delete(uploaded.r2Key);
    } catch {
      // The database row is authoritative. A failed orphan cleanup is safe to retry later.
    }
  }

  return { document: concurrent, deduplicated: true };
}

async function findDocumentByHash(
  db: DbExecutor,
  organizationId: string,
  contentHash: string,
): Promise<Document | undefined> {
  const [document] = await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.organizationId, organizationId), eq(documents.contentHash, contentHash)),
    )
    .limit(1);
  return document;
}
