/**
 * Document Server Functions
 * ABAC-protected API for document management with R2 storage
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import { documents, documentAttachments } from "../../db/schema/documents";
import { reconciliations } from "../../db/schema/reconciliations";
import { parties } from "../../db/schema/parties";
import { user } from "../../db/schema/auth";
import { eq, and, ilike, desc, asc, or, inArray } from "drizzle-orm";
import { deleteFromR2, getPresignedDownloadUrl, isR2Configured, existsInR2 } from "@/lib/storage";
import { ensureDocument } from "@/lib/documents/ensure-document";
import { listEntityDocumentAttachments } from "@/lib/documents/list-attachments";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import { sourceRecordDocuments } from "@/db/schema/inbox";
import { generateThumbnail, regenerateThumbnailWithAI } from "@/services/thumbnail-generator";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { createLogger } from "@/lib/logger";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
  withSessionOrgContext,
} from "@/lib/server-context";
import { runIngestTriage } from "../../lib/ai/ingest-triage";
import type { DocumentViewerData } from "@/lib/document-types";
import { parseDocumentBoundingBoxes } from "@/lib/document-types";

// ============================================================================
// Schemas
// ============================================================================

const MAX_BASE64_SIZE = Math.ceil(20 * 1024 * 1024 * 1.4); // ~20 MB file → ~28 MB base64

const uploadDocumentSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileBase64: z.string().min(1).max(MAX_BASE64_SIZE, "File exceeds maximum allowed size"),
  documentType: z
    .enum(["statement", "bill", "invoice", "receipt", "payslip", "contract", "tax_form", "other"])
    .optional()
    .default("other"),
  displayTitle: z.string().optional(),
  intakeMode: z.enum(["standalone", "evidence_only"]),
});

const getDocumentUrlSchema = z.object({
  documentId: z.string().uuid(),
  expiresIn: z.number().optional().default(3600),
});

const deleteDocumentSchema = z.object({
  documentId: z.string().uuid(),
});

const attachDocumentSchema = z.object({
  documentId: z.string().uuid(),
  linkableType: z.enum([
    "journal_header",
    "invoice",
    "bill",
    "party",
    "reconciliation",
    "financial_account",
  ]),
  linkableId: z.string().uuid(),
});

const listAttachmentsSchema = z.object({
  linkableType: z.enum([
    "journal_header",
    "invoice",
    "bill",
    "party",
    "reconciliation",
    "financial_account",
  ]),
  linkableId: z.string().uuid(),
});

const updateDocumentSchema = z.object({
  documentId: z.string().uuid(),
  displayTitle: z.string().min(1).optional(),
  summary: z.string().optional(),
  documentType: z
    .enum(["statement", "bill", "invoice", "receipt", "payslip", "contract", "tax_form", "other"])
    .optional(),
});

const listDocumentsSchema = z.object({
  search: z.string().optional(),
  documentType: z
    .enum(["statement", "bill", "invoice", "receipt", "payslip", "contract", "tax_form", "other"])
    .optional(),
  fileType: z
    .enum([
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
      "image",
      "other",
    ])
    .optional(),
  sortBy: z.enum(["createdAt", "originalFilename"]).optional().default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
});

const getDocumentSchema = z.object({
  documentId: z.string().uuid(),
});

const checkDuplicateDocumentSchema = z.object({
  filename: z.string().min(1),
});

const getDocumentViewerDataSchema = z.object({
  documentId: z.string().uuid(),
});

// ============================================================================
// Helpers
// ============================================================================

const logger = createLogger("api.documents");

/**
 * Ownership check for owner-based ABAC.
 * Admins/superusers can modify any document.
 */
function isOwnerOrAdmin(
  document: { uploadedById: string | null },
  userId: string,
  role: string,
): boolean {
  const isAdmin = role === "admin" || role === "superuser" || role === "owner";
  const isOwner = document.uploadedById === userId;
  return isAdmin || isOwner;
}

export interface DeletedDocumentRecord {
  id: string;
  objectKeys: string[];
}

/**
 * Delete document metadata while holding a row lock on the referenced document.
 *
 * PostgreSQL foreign-key inserts take a key-share lock on the document row.
 * Holding FOR UPDATE through link revalidation and deletion therefore ensures a
 * concurrent source/attachment insert either commits before these checks (and
 * blocks deletion) or waits until deletion commits and then fails its FK.
 *
 * Callers must run this inside a database transaction.
 */
export async function deleteUnlinkedDocumentRecord(
  db: DbExecutor,
  input: {
    organizationId: string;
    documentId: string;
    userId: string;
    role: string;
  },
): Promise<DeletedDocumentRecord> {
  const { organizationId, documentId, userId, role } = input;
  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
    .for("update")
    .limit(1);

  if (!document) throw new Error("Document not found");
  if (!isOwnerOrAdmin(document, userId, role)) {
    throw new Error("You can only delete your own documents");
  }

  const [linkedRecon] = await db
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.statementDocumentId, documentId),
        eq(reconciliations.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (linkedRecon) {
    throw new Error(
      "Cannot delete this document because it is currently used as a bank statement in a reconciliation. Please go to the Reconciliation page and remove it from there.",
    );
  }

  const [linkedSourceEvidence] = await db
    .select({ sourceRecordId: sourceRecordDocuments.sourceRecordId })
    .from(sourceRecordDocuments)
    .where(
      and(
        eq(sourceRecordDocuments.organizationId, organizationId),
        eq(sourceRecordDocuments.documentId, documentId),
      ),
    )
    .limit(1);
  if (linkedSourceEvidence) {
    throw new Error(
      "This document is retained as transaction source evidence and cannot be deleted. Reject the source to exclude it from posting while preserving the audit trail.",
    );
  }

  const [linkedAttachment] = await db
    .select({ id: documentAttachments.id })
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, organizationId),
        eq(documentAttachments.documentId, documentId),
      ),
    )
    .limit(1);
  if (linkedAttachment) {
    throw new Error(
      "Cannot delete this document because it is linked to another record. Unlink it from that record before deleting it.",
    );
  }

  const [deleted] = await db
    .delete(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
    .returning({ id: documents.id });
  if (!deleted) throw new Error("Document changed while it was being deleted.");

  return {
    id: deleted.id,
    objectKeys: [
      document.r2Key,
      document.thumbnailR2Key,
      document.previewImageR2Key,
      ...(document.previewPageR2Keys ?? []),
    ].filter((key): key is string => Boolean(key)),
  };
}

// ============================================================================
// Check Duplicate Document
// ============================================================================

/**
 * Check if a document with the same filename already exists.
 * Returns the existing document info if found.
 */
export const checkDuplicateDocument = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof checkDuplicateDocumentSchema>) =>
    checkDuplicateDocumentSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const input = checkDuplicateDocumentSchema.parse(rawData);

      if (!input.filename) return { exists: false };

      const [existing] = await db
        .select({
          id: documents.id,
          displayTitle: documents.displayTitle,
          originalFilename: documents.originalFilename,
          createdAt: documents.createdAt,
          fileSizeBytes: documents.fileSizeBytes,
        })
        .from(documents)
        .where(
          and(eq(documents.organizationId, orgId), eq(documents.originalFilename, input.filename)),
        )
        .limit(1);

      if (existing) {
        return {
          exists: true,
          existingDocument: {
            id: existing.id,
            displayTitle: existing.displayTitle,
            originalFilename: existing.originalFilename,
            createdAt: existing.createdAt,
            fileSizeBytes: existing.fileSizeBytes,
          },
        };
      }

      return { exists: false };
    });
  });

// ============================================================================
// Upload Document
// ============================================================================

/**
 * Upload a document to R2 storage
 * Requires: document:upload permission
 */
export const uploadDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof uploadDocumentSchema>) => uploadDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "upload",
      { routeKey: "document:upload", limit: 20, windowMs: 300_000 },
      async ({ userId, orgId, db, role }) => {
        const data = uploadDocumentSchema.parse(rawData);

        const fileBuffer = Buffer.from(data.fileBase64, "base64");
        const result = await ensureDocument(db, {
          organizationId: orgId,
          uploadedById: userId,
          filename: data.filename,
          contentType: data.contentType,
          fileBuffer,
          documentType: data.documentType,
          displayTitle: data.displayTitle,
        });
        const intake =
          data.intakeMode === "standalone"
            ? await intakeStandaloneDocument(
                { db, orgId, userId },
                {
                  documentId: result.document.id,
                  filename: data.filename,
                  contentType: data.contentType,
                  documentType: data.documentType,
                  fallbackDate: new Date().toISOString().slice(0, 10),
                },
              )
            : null;

        if (!result.deduplicated) {
          generateThumbnail(result.document.id, orgId).catch((error) =>
            logger.error("Fire-and-forget thumbnail generation failed", {
              error,
              documentId: result.document.id,
              orgId,
            }),
          );

          // Ingest triage: one cheap classification with filename + mime +
          // text preview, cached on metadata.triage; confident kinds become
          // document_type proposals (confirm-first). Replaces the old
          // filename-only classifyDocument fire-and-forget.
          runIngestTriage({
            orgId,
            userId,
            role,
            documentId: result.document.id,
            filename: data.filename,
            mimeType: data.contentType,
            fileBase64: data.fileBase64,
          }).catch((error: unknown) =>
            logger.error("Fire-and-forget ingest triage failed", {
              error,
              documentId: result.document.id,
              orgId,
            }),
          );
        }

        if (result.deduplicated) {
          logger.info("Duplicate upload — reusing existing document", {
            documentId: result.document.id,
            contentHash: result.document.contentHash,
          });
        }

        return {
          success: true,
          ...result,
          intake:
            intake === null
              ? null
              : {
                  skipped: intake.candidate === null,
                  skipReason: intake.candidate === null ? intake.skipReason : null,
                  sourceRecordId: intake.sourceRecord?.id ?? null,
                  candidateId: intake.candidate?.id ?? null,
                  inboxItemId: intake.inboxItem?.id ?? null,
                  deduplicated: intake.deduplicated,
                  extractionStatus: intake.extractionStatus,
                  processingJobId: intake.processingJobId,
                },
        };
      },
    ) as any;
  });

// ============================================================================
// Get Document Download URL
// ============================================================================

/**
 * Get a presigned download URL for a document
 * Requires: document:view permission
 */
export const getDocumentUrl = createServerFn({ method: "GET" })
  .inputValidator((data) => getDocumentUrlSchema.parse(data))
  .handler(async ({ data }) => {
    return withPermissionOrgContext("document", "view", async ({ orgId, db }) => {
      const [document] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)))
        .limit(1);

      if (!document) {
        throw new Error("Document not found");
      }

      if (document.r2Key && isR2Configured()) {
        const exists = await existsInR2(document.r2Key);
        if (!exists) {
          return { url: null, expiresIn: null };
        }

        const url = await getPresignedDownloadUrl(document.r2Key, {
          expiresIn: data.expiresIn,
        });
        return { url, expiresIn: data.expiresIn };
      }

      return { url: document.storagePath, expiresIn: null };
    });
  });

// ============================================================================
// Delete Document
// ============================================================================

/**
 * Delete a document from R2 storage and database
 * Requires: document:delete permission
 * Members can only delete their own documents; admins can delete any.
 */
export const deleteDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof deleteDocumentSchema>) => deleteDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    const deletion = await withMutationPermissionOrgContext(
      "document",
      "delete",
      { routeKey: "document:delete", limit: 30, windowMs: 60_000 },
      async ({ userId, role, orgId, db }) => {
        const data = deleteDocumentSchema.parse(rawData);
        return {
          orgId,
          deleted: await deleteUnlinkedDocumentRecord(db, {
            organizationId: orgId,
            documentId: data.documentId,
            userId,
            role,
          }),
        };
      },
    );

    // The organization transaction has committed at this point. Storage cleanup
    // is intentionally best effort and post-commit: a database rollback can
    // never leave live metadata pointing at an object we already removed.
    if (isR2Configured()) {
      for (const objectKey of deletion.deleted.objectKeys) {
        try {
          await deleteFromR2(objectKey);
        } catch (error) {
          logger.warn("Failed to clean up object for a deleted document", {
            error,
            documentId: deletion.deleted.id,
            orgId: deletion.orgId,
            objectKey,
          });
        }
      }
    }

    return { success: true };
  });

// ============================================================================
// Update Document
// ============================================================================

/**
 * Update a document's metadata
 * Requires: document:upload permission
 * Members can only update their own documents; admins can update any.
 */
export const updateDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof updateDocumentSchema>) => updateDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "upload",
      { routeKey: "document:update", limit: 120, windowMs: 60_000 },
      async ({ userId, role, orgId, db }) => {
        const data = updateDocumentSchema.parse(rawData);

        const [document] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)))
          .limit(1);

        if (!document) {
          throw new Error("Document not found");
        }

        if (!isOwnerOrAdmin(document, userId, role)) {
          throw new Error("You can only update your own documents");
        }

        const updateData: {
          displayTitle?: string;
          summary?: string | null;
          documentType?:
            | "statement"
            | "bill"
            | "invoice"
            | "receipt"
            | "payslip"
            | "contract"
            | "tax_form"
            | "other";
        } = {};
        if (data.displayTitle !== undefined) updateData.displayTitle = data.displayTitle;
        if (data.summary !== undefined) updateData.summary = data.summary;
        if (data.documentType !== undefined) updateData.documentType = data.documentType;

        if (Object.keys(updateData).length === 0) {
          return { success: true, document } as any;
        }

        const [updatedDocument] = await db
          .update(documents)
          .set(updateData)
          .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)))
          .returning();

        return { success: true, document: updatedDocument } as any;
      },
    ) as any;
  });

// ============================================================================
// Attach Document to Entity
// ============================================================================

/**
 * Attach a document to any entity (journal, invoice, bill, etc.)
 * Requires: document:upload permission
 */
export const attachDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof attachDocumentSchema>) => attachDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "upload",
      { routeKey: "document:attach", limit: 120, windowMs: 60_000 },
      async ({ userId, orgId, db }) => {
        const data = attachDocumentSchema.parse(rawData);

        const [document] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)))
          .limit(1);

        if (!document) {
          throw new Error("Document not found");
        }

        const [attachment] = await db
          .insert(documentAttachments)
          .values({
            organizationId: orgId,
            documentId: data.documentId,
            linkableType: data.linkableType,
            linkableId: data.linkableId,
          })
          .returning();

        const entityTypeMap: Record<string, string> = {
          journal_header: "transaction",
          invoice: "invoice",
          bill: "bill",
          party: "party",
        };
        const entityType = entityTypeMap[data.linkableType] ?? data.linkableType;

        await insertActivityLog(
          {
            orgId,
            entityType,
            entityId: data.linkableId,
            action: "attachment_added",
            actorId: userId,
            changes: {
              documentName: document.displayTitle || document.originalFilename,
              documentId: document.id,
            },
          },
          db,
        );

        return { success: true, attachment };
      },
    ) as any;
  });

// ============================================================================
// Detach Document from Entity
// ============================================================================

/**
 * Remove a document attachment from an entity
 * Requires: document:delete permission
 */
export const detachDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof attachDocumentSchema>) => attachDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "delete",
      { routeKey: "document:detach", limit: 120, windowMs: 60_000 },
      async ({ userId, orgId, db }) => {
        const data = attachDocumentSchema.parse(rawData);

        const [document] = await db
          .select({
            displayTitle: documents.displayTitle,
            originalFilename: documents.originalFilename,
          })
          .from(documents)
          .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)))
          .limit(1);

        await db
          .delete(documentAttachments)
          .where(
            and(
              eq(documentAttachments.organizationId, orgId),
              eq(documentAttachments.documentId, data.documentId),
              eq(documentAttachments.linkableType, data.linkableType),
              eq(documentAttachments.linkableId, data.linkableId),
            ),
          );

        const entityTypeMap: Record<string, string> = {
          journal_header: "transaction",
          invoice: "invoice",
          bill: "bill",
          party: "party",
        };
        const entityType = entityTypeMap[data.linkableType] ?? data.linkableType;

        await insertActivityLog(
          {
            orgId,
            entityType,
            entityId: data.linkableId,
            action: "attachment_removed",
            actorId: userId,
            changes: {
              documentName:
                document?.displayTitle || document?.originalFilename || "Unknown document",
              documentId: data.documentId,
            },
          },
          db,
        );

        return { success: true };
      },
    ) as any;
  });

// ============================================================================
// List Document Attachments for Entity
// ============================================================================

/**
 * List all documents attached to a specific entity
 * Requires: document:view permission
 */
export const listDocumentAttachments = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("document", "view", async ({ orgId, db }) => {
      const data = listAttachmentsSchema.parse(rawData);

      return {
        attachments: await listEntityDocumentAttachments(db, orgId, data),
      } as any;
    });
  },
);

// ============================================================================
// List Documents
// ============================================================================

/**
 * List all documents for the active organization with optional filters
 * Requires: document:view permission
 */
export const listDocuments = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listDocumentsSchema>) =>
    listDocumentsSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    try {
      return await withSessionOrgContext(async ({ orgId, db }) => {
        const data = listDocumentsSchema.parse(rawData ?? {});

        const conditions = [eq(documents.organizationId, orgId)];

        if (data.search) {
          const pattern = `%${data.search}%`;
          conditions.push(
            or(ilike(documents.originalFilename, pattern), ilike(documents.displayTitle, pattern))!,
          );
        }

        if (data.documentType) {
          conditions.push(eq(documents.documentType, data.documentType));
        }

        if (data.fileType) {
          if (data.fileType === "image") {
            conditions.push(inArray(documents.fileType, ["jpg", "jpeg", "png", "gif", "webp"]));
          } else {
            conditions.push(eq(documents.fileType, data.fileType));
          }
        }

        const orderColumn =
          data.sortBy === "originalFilename" ? documents.originalFilename : documents.createdAt;
        const orderDir = data.sortOrder === "asc" ? asc(orderColumn) : desc(orderColumn);

        const results = await db
          .select({
            id: documents.id,
            originalFilename: documents.originalFilename,
            displayTitle: documents.displayTitle,
            documentType: documents.documentType,
            fileType: documents.fileType,
            fileSizeBytes: documents.fileSizeBytes,
            mimeType: documents.mimeType,
            thumbnailR2Key: documents.thumbnailR2Key,
            uploadedById: documents.uploadedById,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
            storagePath: documents.storagePath,
            r2Key: documents.r2Key,
            r2Bucket: documents.r2Bucket,
            organizationId: documents.organizationId,
            ocrBoundingBoxes: documents.ocrBoundingBoxes,
            uploaderName: user.name,
            uploaderImage: user.image,
          })
          .from(documents)
          .leftJoin(user, eq(documents.uploadedById, user.id))
          .where(and(...conditions))
          .orderBy(orderDir);

        return { documents: results };
      });
    } catch (error) {
      logger.error("Failed to list documents", { error });
      return { documents: [] };
    }
  });

// ============================================================================
// Get Document (Single)
// ============================================================================

/**
 * Get a single document by ID with its linked attachments
 * Requires: document:view permission
 */
export const getDocument = createServerFn({ method: "GET" })
  .inputValidator((data) => getDocumentSchema.parse(data))
  .handler(async ({ data }) => {
    return withPermissionOrgContext("document", "view", async ({ orgId, db }) => {
      const [document] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)))
        .limit(1);

      if (!document) {
        throw new Error("Document not found");
      }

      const attachments = await db
        .select()
        .from(documentAttachments)
        .where(
          and(
            eq(documentAttachments.organizationId, orgId),
            eq(documentAttachments.documentId, data.documentId),
          ),
        );

      const enrichedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
          if (attachment.linkableType === "party") {
            const [party] = await db
              .select({ partyType: parties.partyType })
              .from(parties)
              .where(and(eq(parties.id, attachment.linkableId), eq(parties.organizationId, orgId)))
              .limit(1);
            return { ...attachment, partyType: party?.partyType ?? null };
          }
          return { ...attachment, partyType: null };
        }),
      );

      let enrichedDocument = document;
      const docBoxes = document.ocrBoundingBoxes as unknown[] | null;
      if (!docBoxes || docBoxes.length === 0) {
        const billAttachment = attachments.find((attachment) => attachment.linkableType === "bill");
        if (billAttachment) {
          const { bills } = await import("@/db/schema/bills");
          const [linkedBill] = await db
            .select({ ocrBoundingBoxes: bills.ocrBoundingBoxes })
            .from(bills)
            .where(and(eq(bills.id, billAttachment.linkableId), eq(bills.organizationId, orgId)))
            .limit(1);
          if (
            linkedBill?.ocrBoundingBoxes &&
            (linkedBill.ocrBoundingBoxes as unknown[]).length > 0
          ) {
            enrichedDocument = { ...document, ocrBoundingBoxes: linkedBill.ocrBoundingBoxes };
          }
        }
      }

      return { document: enrichedDocument, attachments: enrichedAttachments } as any;
    });
  });

// ============================================================================
// Generate Document Thumbnail
// ============================================================================

/**
 * Manually trigger thumbnail generation for a document.
 * Requires: document:view permission
 */
export const generateDocumentThumbnail = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof getDocumentSchema>) => getDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "view",
      { routeKey: "document:thumbnail-generate", limit: 20, windowMs: 300_000 },
      async ({ orgId }) => {
        const { documentId } = rawData as { documentId: string };
        if (!documentId) throw new Error("documentId is required");

        const result = await generateThumbnail(documentId, orgId);

        if (!result.success) {
          throw new Error(result.error ?? "Thumbnail generation failed");
        }

        let thumbnailUrl: string | null = null;
        if (result.thumbnailR2Key) {
          thumbnailUrl = await getPresignedDownloadUrl(result.thumbnailR2Key);
        }

        return { success: true, thumbnailUrl, thumbnailR2Key: result.thumbnailR2Key };
      },
    ) as any;
  });

// ============================================================================
// Regenerate Thumbnail with AI (Manual)
// ============================================================================

/**
 * Manually regenerate a document thumbnail using Gemini AI.
 * Only available when enableImageGeneration is on in org settings.
 */
export const regenerateDocumentThumbnailWithAI = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof getDocumentSchema>) => getDocumentSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "view",
      { routeKey: "document:thumbnail-regenerate-ai", limit: 10, windowMs: 300_000 },
      async ({ orgId }) => {
        const { documentId } = rawData as { documentId: string };
        if (!documentId) throw new Error("documentId is required");

        const result = await regenerateThumbnailWithAI(documentId, orgId);

        if (!result.success) {
          throw new Error(result.error ?? "AI thumbnail generation failed");
        }

        let thumbnailUrl: string | null = null;
        if (result.thumbnailR2Key) {
          thumbnailUrl = await getPresignedDownloadUrl(result.thumbnailR2Key);
        }

        return { success: true, thumbnailUrl, thumbnailR2Key: result.thumbnailR2Key };
      },
    ) as any;
  });

// ============================================================================
// Get Document Thumbnail URL
// ============================================================================

/**
 * Get a presigned URL for a document's thumbnail.
 * Requires: document:view permission
 */
export const getDocumentThumbnailUrl = createServerFn({ method: "GET" })
  .inputValidator((data) => getDocumentSchema.parse(data))
  .handler(async ({ data }) => {
    return withPermissionOrgContext("document", "view", async ({ orgId, db }) => {
      const { documentId } = data;

      const [doc] = await db
        .select({ thumbnailR2Key: documents.thumbnailR2Key })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);

      if (!doc) throw new Error("Document not found");
      if (!doc.thumbnailR2Key) return { url: null };

      const url = await getPresignedDownloadUrl(doc.thumbnailR2Key);
      return { url };
    });
  });

// ============================================================================
// Get Document Content as Base64 (for AI parsing of attached docs)
// ============================================================================

/**
 * Download a document's raw content from R2 and return it as base64.
 * Used by the AI panel to parse already-attached documents without re-upload.
 * Requires: document:view permission
 */
export const getDocumentContentBase64 = createServerFn({ method: "GET" })
  .inputValidator((data) => getDocumentSchema.parse(data))
  .handler(async ({ data }) => {
    return withPermissionOrgContext("document", "view", async ({ orgId, db }) => {
      const { documentId } = data;

      const [doc] = await db
        .select({
          r2Key: documents.r2Key,
          storagePath: documents.storagePath,
          mimeType: documents.mimeType,
          originalFilename: documents.originalFilename,
          ocrBoundingBoxes: documents.ocrBoundingBoxes,
          aiTransactionCache: documents.aiTransactionCache,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);

      if (!doc) throw new Error("Document not found");
      if (!doc.r2Key) throw new Error("Document has no storage key");

      if (!isR2Configured()) {
        throw new Error("R2 storage is not configured");
      }

      const { downloadFromR2 } = await import("@/lib/storage");
      const buffer = await downloadFromR2(doc.r2Key);
      const base64 = buffer.toString("base64");

      // Return cached OCR fields if available — allows callers to skip redundant bbox extraction
      const cachedOcrFields = parseDocumentBoundingBoxes(doc.ocrBoundingBoxes)
        .filter((b) => b.text && b.fieldId && b.label)
        .map((b) => ({ fieldId: b.fieldId, label: b.label, text: b.text! }));

      return {
        base64,
        mimeType: doc.mimeType || "application/octet-stream",
        filename: doc.originalFilename,
        cachedOcrFields: cachedOcrFields.length > 0 ? cachedOcrFields : undefined,
        hasCachedBboxes: cachedOcrFields.length > 0,
        aiTransactionCache: doc.aiTransactionCache ?? null,
      } as any;
    });
  });

// ============================================================================
// Cache Document Transaction Result (for instant reuse)
// ============================================================================

const cacheTransactionSchema = z.object({
  documentId: z.string().uuid(),
  result: z.record(z.string(), z.unknown()),
  contextHash: z.string(),
});

/**
 * Persist an enriched ParsedTransactionResult on the document.
 * Called fire-and-forget after a successful AI parse + entity resolution.
 * Enables instant form fill on subsequent "✨ Use" clicks — zero AI calls.
 * Requires: document:upload permission
 */
export const cacheDocumentTransactionResult = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof cacheTransactionSchema>) =>
    cacheTransactionSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "upload",
      { routeKey: "document:cache-result", limit: 120, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const data = cacheTransactionSchema.parse(rawData);

        await db
          .update(documents)
          .set({
            aiTransactionCache: {
              result: data.result,
              cachedAt: new Date().toISOString(),
              contextHash: data.contextHash,
            },
          })
          .where(and(eq(documents.id, data.documentId), eq(documents.organizationId, orgId)));

        return { success: true };
      },
    ) as any;
  });

// ============================================================================
// Clear Document Bounding Boxes (force re-scan)
// ============================================================================

/**
 * Clear cached OCR bounding boxes for a document, forcing a fresh scan next time.
 * Requires: document:view permission
 */
export const clearDocumentBoundingBoxes = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "view",
      { routeKey: "document:ocr-clear", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { documentId } = rawData as { documentId: string };
        if (!documentId) throw new Error("documentId is required");

        await db
          .update(documents)
          .set({ ocrBoundingBoxes: null, aiTransactionCache: null, updatedAt: new Date() })
          .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)));

        return { success: true };
      },
    ) as any;
  },
);

// ============================================================================
// Get Document Viewer Data (presigned URLs for viewer)
// ============================================================================

/**
 * Get all data needed to render the interactive document viewer:
 * - presigned URL for the preview image (or document itself for images)
 * - presigned URL for the original document (for "Open" link)
 * - any cached bounding boxes
 * Requires: document:view permission
 */
export const getDocumentViewerData = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getDocumentViewerDataSchema>) =>
    getDocumentViewerDataSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("document", "view", async ({ orgId, db }) => {
      const { documentId } = getDocumentViewerDataSchema.parse(rawData);
      if (!documentId) throw new Error("documentId is required");

      const [doc] = await db
        .select({
          r2Key: documents.r2Key,
          mimeType: documents.mimeType,
          previewImageR2Key: documents.previewImageR2Key,
          previewPageR2Keys: documents.previewPageR2Keys,
          pageCount: documents.pageCount,
          ocrBoundingBoxes: documents.ocrBoundingBoxes,
          originalFilename: documents.originalFilename,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);

      if (!doc) throw new Error("Document not found");

      let resolvedBoxes = parseDocumentBoundingBoxes(doc.ocrBoundingBoxes);
      if (resolvedBoxes.length === 0) {
        const billAtt = await db
          .select({ linkableId: documentAttachments.linkableId })
          .from(documentAttachments)
          .where(
            and(
              eq(documentAttachments.organizationId, orgId),
              eq(documentAttachments.documentId, documentId),
              eq(documentAttachments.linkableType, "bill"),
            ),
          )
          .limit(1);
        if (billAtt.length > 0) {
          const { bills } = await import("@/db/schema/bills");
          const [linkedBill] = await db
            .select({ ocrBoundingBoxes: bills.ocrBoundingBoxes })
            .from(bills)
            .where(and(eq(bills.id, billAtt[0]!.linkableId), eq(bills.organizationId, orgId)))
            .limit(1);
          const linkedBillBoxes = parseDocumentBoundingBoxes(linkedBill?.ocrBoundingBoxes);
          if (linkedBillBoxes.length > 0) {
            resolvedBoxes = linkedBillBoxes;
          }
        }
      }

      const isPdf = doc.mimeType?.includes("pdf");
      if (isPdf && !doc.previewPageR2Keys?.length && doc.r2Key) {
        try {
          const { downloadFromR2 } = await import("@/lib/storage");
          const pdfBuffer = await downloadFromR2(doc.r2Key);
          const pdfBase64 = pdfBuffer.toString("base64");
          const previewMimeType = doc.mimeType ?? "application/pdf";

          const { generatePdfPreview } = await import("./-pdf-preview");
          await generatePdfPreview({
            data: { documentId, pdfBase64, mimeType: previewMimeType },
          });

          const [updated] = await db
            .select({
              previewPageR2Keys: documents.previewPageR2Keys,
              previewImageR2Key: documents.previewImageR2Key,
              pageCount: documents.pageCount,
            })
            .from(documents)
            .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
            .limit(1);
          if (updated) {
            doc.previewPageR2Keys = updated.previewPageR2Keys;
            doc.previewImageR2Key = updated.previewImageR2Key;
            doc.pageCount = updated.pageCount;
          }
        } catch (error) {
          logger.error("PDF multi-page preview generation failed for viewer data", {
            error,
            documentId,
            orgId,
          });
        }
      }

      const pageKeys =
        doc.previewPageR2Keys ?? (doc.previewImageR2Key ? [doc.previewImageR2Key] : []);
      const imageUrls: string[] = [];
      for (const key of pageKeys) {
        if (key) {
          const url = await getPresignedDownloadUrl(key);
          if (url) imageUrls.push(url);
        }
      }

      let imageUrl: string | null = imageUrls[0] ?? null;
      let documentUrl: string | null = null;

      if (doc.r2Key) {
        documentUrl = await getPresignedDownloadUrl(doc.r2Key);
        if (!imageUrl && doc.mimeType?.startsWith("image/")) {
          imageUrl = documentUrl;
          if (imageUrl) imageUrls.push(imageUrl);
        }
      }

      const viewerData: DocumentViewerData = {
        imageUrl,
        imageUrls,
        pageCount: doc.pageCount ?? (imageUrls.length || 1),
        documentUrl,
        boundingBoxes: resolvedBoxes,
        filename: doc.originalFilename,
      };

      return viewerData;
    });
  });
