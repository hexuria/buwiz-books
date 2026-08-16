/**
 * Document Vault Schema
 * Centralized document storage with type categorization and transaction linking
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { journalHeaders } from "./journals";

// Document type enum
export const documentTypeEnum = pgEnum("document_type", [
  "statement",
  "bill",
  "invoice",
  "receipt",
  "payslip",
  "contract",
  "tax_form",
  "other",
]);

// File type enum
export const fileTypeEnum = pgEnum("file_type", [
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
  "other",
]);

/**
 * Documents - File metadata and status
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization for RLS
    organizationId: text("organization_id").notNull(),

    // File information
    originalFilename: varchar("original_filename", { length: 500 }).notNull(),
    displayTitle: varchar("display_title", { length: 255 }),

    // AI-extracted content
    summary: text("summary"),

    // Categorization
    documentType: documentTypeEnum("document_type").default("other").notNull(),
    fileType: fileTypeEnum("file_type").default("other").notNull(),

    // Storage (legacy local path)
    storagePath: varchar("storage_path", { length: 1000 }).notNull(),
    fileSizeBytes: integer("file_size_bytes"),
    mimeType: varchar("mime_type", { length: 100 }),

    // Content hash (SHA-256, hex) for deduplication — identical uploads reuse the stored
    // object and its OCR results instead of re-uploading and re-running paid OCR.
    contentHash: varchar("content_hash", { length: 64 }),

    // R2 cloud storage
    r2Key: varchar("r2_key", { length: 1000 }), // Object key in R2 bucket
    r2Bucket: varchar("r2_bucket", { length: 100 }), // Bucket name
    thumbnailR2Key: varchar("thumbnail_r2_key", { length: 1000 }), // Thumbnail for images
    previewImageR2Key: varchar("preview_image_r2_key", { length: 1000 }), // Server-rendered PNG preview (for PDF → image viewer)
    previewPageR2Keys: jsonb("preview_page_r2_keys").$type<string[]>(), // Per-page PNG preview R2 keys (multi-page PDF support)
    pageCount: integer("page_count"), // Total number of pages in the document
    isPublic: boolean("is_public").default(false), // For public sharing URLs

    // AI-detected field bounding boxes (for interactive document viewer)
    ocrBoundingBoxes:
      jsonb("ocr_bounding_boxes").$type<
        {
          fieldId: string;
          label: string;
          text?: string;
          bbox: [number, number, number, number];
          page: number;
        }[]
      >(),

    // AI-extracted metadata
    metadata: jsonb("metadata").$type<{
      extractedDate?: string;
      extractedAmount?: string;
      extractedVendor?: string;
      extractedInvoiceNumber?: string;
      ocrText?: string;
      /** Cached structured invoice/receipt extraction keyed by document + account context. */
      billOcr?: {
        result: Record<string, unknown>;
        contextHash: string;
        cachedAt: string;
      };
      /** Matcher-only extraction used by asynchronous Inbox ingestion. */
      inboxExtraction?: {
        result: {
          economicEventClass: string;
          direction: string;
          amount: string;
          currency: string;
          date: string;
          party: string;
          reference: string;
          description: string;
        };
        version: number;
        cachedAt: string;
      };
      /**
       * Hand-off payload for the staged async statement pipeline
       * (src/lib/jobs/handlers/statement-ocr.ts). Step outputRefs stay
       * refs-only; the parsed statement and the matcher result live here so a
       * crash-resumed run can re-derive its state without re-calling the model.
       */
      statementPipeline?: {
        runId: string;
        cachedAt: string;
        source: "csv" | "ocr";
        parsed: Record<string, unknown>;
        matching?: Record<string, unknown>;
      };
      /** Upload-time ingest triage (one cheap classification, reused downstream). */
      triage?: {
        docKind: string;
        confidence: number;
        version: number;
        cachedAt: string;
      };
    }>(),

    // Cached AI transaction parse result — enables instant reuse without re-calling Gemini.
    // Written after a successful parse + entity resolution; cleared when bounding boxes change.
    aiTransactionCache: jsonb("ai_transaction_cache").$type<{
      /** The fully enriched ParsedTransactionResult (post entity resolution) */
      result: Record<string, unknown>;
      /** ISO timestamp when the cache was created */
      cachedAt: string;
      /** Fingerprint of account IDs used during the parse — for quick staleness detection */
      contextHash: string;
    }>(),

    // Upload info
    uploadedById: text("uploaded_by_id"), // FK to users (better-auth uses text IDs)

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgContentHashIndex: uniqueIndex("idx_documents_org_content_hash")
      .on(table.organizationId, table.contentHash)
      .where(sql`${table.contentHash} is not null`),
  }),
);

/**
 * Document Attachments - Links documents to transactions
 * Supports many-to-many relationships
 */
export const documentAttachments = pgTable("document_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization for RLS
  organizationId: text("organization_id").notNull(),

  // Document
  documentId: uuid("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull(),

  // Linkable entity (polymorphic association)
  linkableType: varchar("linkable_type", { length: 50 }).notNull(), // 'journal_header', 'invoice', 'bill', 'party', 'reconciliation'
  linkableId: uuid("linkable_id").notNull(),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Document Suggestions - AI-generated links between documents and transactions
 */
export const documentSuggestions = pgTable("document_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Document
  documentId: uuid("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull(),

  // Suggested transaction link
  suggestedJournalHeaderId: uuid("suggested_journal_header_id").references(() => journalHeaders.id),

  // AI confidence
  confidence: integer("confidence"), // 0-100
  reason: text("reason"), // explanation for the suggestion

  // Status (null = pending, true = accepted, false = rejected)
  accepted: boolean("accepted"),
  reviewedAt: timestamp("reviewed_at"),
  reviewedById: uuid("reviewed_by_id"), // FK to users

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Relations
export const documentsRelations = relations(documents, ({ many }) => ({
  attachments: many(documentAttachments),
  suggestions: many(documentSuggestions),
}));

export const documentAttachmentsRelations = relations(documentAttachments, ({ one }) => ({
  document: one(documents, {
    fields: [documentAttachments.documentId],
    references: [documents.id],
  }),
}));

export const documentSuggestionsRelations = relations(documentSuggestions, ({ one }) => ({
  document: one(documents, {
    fields: [documentSuggestions.documentId],
    references: [documents.id],
  }),
  suggestedJournalHeader: one(journalHeaders, {
    fields: [documentSuggestions.suggestedJournalHeaderId],
    references: [journalHeaders.id],
  }),
}));
