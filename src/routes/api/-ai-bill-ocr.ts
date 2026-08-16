// ============================================================================
// AI Bill OCR — Server Function (Gemini 3 Flash)
// Extracts structured bill data from PDF/image uploads with
// category classification using the chart of accounts and
// recurring bill detection.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { and, eq, sql } from "drizzle-orm";
import { documents } from "../../db/schema/documents";
import { processingJobs } from "../../db/schema/inbox";
import { billOcrContextHash } from "../../lib/bill-ocr-cache";
import { GeminiRateLimitError } from "../../lib/gemini-client";
import { aiComplete } from "../../lib/ai/facade";
import { createProposal } from "../../lib/ai/proposals";
import { normalizeConfidence } from "../../lib/ai/confidence";
import { createLogger } from "../../lib/logger";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
} from "../../lib/server-context";
import { assertRolePermission } from "../../lib/auth-middleware";
import { BBOX_SCAN_JOB_TYPE, enqueueBboxScanJob } from "../../lib/jobs/handlers/bbox-scan";
import { triggerWorker } from "../../lib/jobs/trigger";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

/** Bounding box for a detected field on the document */
export interface BoundingBox {
  fieldId: string; // e.g. "vendor_name", "invoice_number", "line_item_0"
  label: string; // Human-readable label
  text?: string; // Actual extracted text content (for clipboard copy)
  bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized 0-1000
  page: number; // Page number (0-indexed)
}

export interface ParsedBillData {
  vendor: {
    name: string;
    email?: string;
    phone?: string;
    website?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
  };
  invoice: {
    invoiceNumber?: string;
    invoiceDate?: string; // YYYY-MM-DD
    dueDate?: string; // YYYY-MM-DD
    amount: number;
    notes?: string;
  };
  lineItems: Array<{
    description: string;
    quantity?: number;
    unitPrice?: number;
    amount: number;
    suggestedCategoryNumber?: string; // e.g. "60100"
    suggestedCategoryName?: string; // e.g. "Rent Expense"
  }>;
  recipient?: {
    name?: string;
    email?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
  };
  classification: {
    overallCategoryNumber?: string;
    overallCategoryName?: string;
    confidence: number; // 0.0-1.0
    isUncategorized: boolean;
    uncategorizedType?: "expense" | "liability" | "asset";
  };
  recurring: {
    isRecurring: boolean;
    frequency?: "weekly" | "monthly" | "quarterly" | "yearly";
    reasoning?: string;
  };
  boundingBoxes?: BoundingBox[];
  confidence: number;
}

/** Category context passed from the client to help AI classify */
export interface CategoryContext {
  accountNumber: string;
  name: string;
  type: string; // "expense", "liability", "revenue", "asset"
  subtype?: string;
  parentName?: string;
}

const extractBoundingBoxesSchema = z.object({
  base64Content: z.string().min(1),
  mimeType: z.string().min(1),
  page: z.number().int().min(0).optional(),
});

const logger = createLogger("api.ai-bill-ocr");

// ============================================================================
// Server Function
// ============================================================================

/**
 * Parse a bill document (PDF or image) using Gemini AI.
 * Accepts base64-encoded file content, MIME type, and optional
 * chart-of-accounts context for AI-powered category classification.
 */
export const parseBillDocument = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:bill-ocr", limit: 20, windowMs: 300_000 },
      async ({ orgId, db, role, userId }) => {
        // Two-key model: the parse pre-fills bill creation.
        assertRolePermission(role, "bill", "create");
        const { base64Content, mimeType, currentDate, categories, documentId } = rawData as {
          base64Content: string;
          mimeType: string;
          currentDate?: string;
          categories?: CategoryContext[];
          documentId?: string;
        };

        if (!base64Content || !mimeType) {
          throw new Error("base64Content and mimeType are required");
        }

        const categoryContextHash = billOcrContextHash(categories ?? []);
        let cachedDocument: typeof documents.$inferSelect | undefined;
        if (documentId) {
          await db.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${"bill-ocr:" + orgId + ":" + documentId}, 0::bigint)
            )
          `);
          [cachedDocument] = await db
            .select()
            .from(documents)
            .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
            .limit(1);
          if (!cachedDocument) {
            throw new Error("Document not found");
          }
          const cached = cachedDocument.metadata?.billOcr;
          if (cached?.contextHash === categoryContextHash) {
            // Cache hit: return the cached parse WITHOUT creating a prefill
            // proposal. Proposals are created only on fresh parses — a cache
            // hit means an earlier parse of this exact document+context
            // already recorded one, and re-creating it here would pile up
            // duplicate pending proposals for the same extraction.
            return cached.result as unknown as ParsedBillData;
          }
        }

        try {
          const result = await aiComplete<ParsedBillData>({
            task: "bill_ocr",
            input: { currentDate, categories },
            ctx: { orgId },
            media: [{ mimeType, dataBase64: base64Content }],
          });
          if (!result.ok) {
            // Do NOT cache and do NOT hand the client data it would use to
            // create a vendor + bill — bad extractions become reviewable
            // instead of silently landing as ledger data.
            logger.warn("Bill OCR output failed validation", {
              orgId,
              documentId,
              issues: result.issues,
            });
            return { status: "needs_review" as const, issues: result.issues };
          }
          const parsed: ParsedBillData = result.data;
          if (cachedDocument) {
            await db
              .update(documents)
              .set({
                metadata: {
                  ...cachedDocument.metadata,
                  billOcr: {
                    result: parsed as unknown as Record<string, unknown>,
                    contextHash: categoryContextHash,
                    cachedAt: new Date().toISOString(),
                  },
                },
                updatedAt: new Date(),
              })
              .where(and(eq(documents.id, cachedDocument.id), eq(documents.organizationId, orgId)));
          }

          // Confirm-first (ai_findings #19): record a prefill proposal so the
          // human Apply/Dismiss on the upload preview becomes review
          // provenance + feedback. Acknowledge-only kind — approving it writes
          // nothing; the permissioned bill-create route is the write path.
          // Created ONLY on fresh parses (see the cache-hit early return
          // above) to avoid duplicate proposals for the same document.
          let prefillProposalId: string | undefined;
          try {
            const proposal = await createProposal(db, {
              orgId,
              kind: "prefill",
              payload: {
                target: "bill",
                summary: {
                  vendorName: parsed.vendor?.name ?? "",
                  amount: parsed.invoice?.amount ?? null,
                  invoiceNumber: parsed.invoice?.invoiceNumber ?? null,
                  lineItemCount: parsed.lineItems?.length ?? 0,
                },
              },
              confidence: normalizeConfidence(parsed.confidence),
              sourceRef: documentId ? { entityType: "document", entityId: documentId } : undefined,
              createdBy: userId,
            });
            prefillProposalId = proposal?.id;
          } catch (proposalErr) {
            // The parse itself succeeded — don't fail the upload pipeline
            // over feedback bookkeeping.
            logger.warn("Failed to create prefill proposal for bill OCR", {
              orgId,
              documentId,
              error: proposalErr,
            });
          }

          return { ...parsed, prefillProposalId };
        } catch (err) {
          if (err instanceof GeminiRateLimitError) {
            throw new Error(err.message);
          }
          throw err;
        }
      },
    ) as any;
  },
);

// ============================================================================
// Bounding Box Extraction (separate lightweight AI call)
// ============================================================================

/**
 * Scan ONE supplied image for field bounding boxes, returning
 * [ymin, xmin, ymax, xmax] coordinates normalized to a 0-1000 scale.
 *
 * Stateless by design: it does not read or write `documents.ocr_bounding_boxes`.
 * It used to persist when given a `documentId`, which made it a third writer
 * to that column alongside the `bbox_scan` job — with its own coordinates
 * (from the model's rasterization of the raw PDF rather than the preview
 * pages the viewer shows) and its own keying. The queued job is now the only
 * writer; use `startFieldScan` to scan a whole document.
 */
export const extractBoundingBoxes = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof extractBoundingBoxesSchema>) =>
    extractBoundingBoxesSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:bounding-boxes", limit: 20, windowMs: 300_000 },
      async ({ orgId, role }) => {
        // Two-key model: bounding boxes read a supplied document.
        assertRolePermission(role, "document", "view");
        const { base64Content, mimeType, page } = extractBoundingBoxesSchema.parse(rawData);

        if (!base64Content || !mimeType) {
          throw new Error("base64Content and mimeType are required");
        }

        try {
          const result = await aiComplete<BoundingBox[]>({
            task: "bbox_scan",
            input: { page },
            ctx: { orgId },
            media: [{ mimeType, dataBase64: base64Content }],
          });
          if (!result.ok) {
            // Bounding boxes are presentation metadata — keep the graceful
            // empty-result degradation this endpoint has always had.
            logger.warn("Bounding box output failed validation", {
              orgId,
              page,
              issues: result.issues,
            });
            return [] as BoundingBox[];
          }
          const boxes: BoundingBox[] = result.data;

          if (page != null) {
            for (const box of boxes) {
              box.page = page;
            }
          }

          return boxes;
        } catch (err) {
          logger.error("Bounding box extraction failed", { error: err, orgId, page });
          return [] as BoundingBox[];
        }
      },
    ) as any;
  });

// ============================================================================
// Background field scan (server-side, all pages in one job)
// ============================================================================

const startFieldScanSchema = z.object({
  documentId: z.string().uuid(),
  pageCount: z.number().int().min(1).optional(),
});

/**
 * Queue a whole-document bounding-box scan.
 *
 * `extractBoundingBoxes` above scans ONE supplied image per call, which forces
 * the client into a serial per-page loop that re-uploads every page. This
 * enqueues `bbox_scan` instead: the worker downloads and rasterizes once,
 * scans every page, and writes the boxes in a single update.
 */
export const startFieldScan = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof startFieldScanSchema>) => startFieldScanSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:start-field-scan", limit: 20, windowMs: 300_000 },
      async ({ orgId, db, role }) => {
        // Two-key model: the scan reads a supplied document.
        assertRolePermission(role, "document", "view");
        const { documentId, pageCount } = startFieldScanSchema.parse(rawData);

        const [document] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
          .limit(1);
        if (!document) throw new Error("Document not found");

        const jobId = await enqueueBboxScanJob(db, {
          organizationId: orgId,
          documentId,
          pageCount,
        });
        return { status: "queued" as const, jobId, documentId };
      },
    );

    // Kick the worker only after the enqueue transaction committed.
    triggerWorker([BBOX_SCAN_JOB_TYPE]);
    return outcome;
  });

const fieldScanStatusSchema = z.object({
  jobId: z.string().uuid(),
  documentId: z.string().uuid(),
});

export interface FieldScanStatus {
  /**
   * `retrying` is DERIVED, not a processing_jobs status: the requeue path
   * writes `queued` for every attempt below the ceiling, so a poller reading
   * the raw column cannot tell "never started" from "failed twice, next try
   * in 20s". Deriving it here avoids touching the claim predicate and the
   * partial unique dedupe index, both of which a real status value would
   * require — and getting that index wrong would allow duplicate concurrent
   * jobs for one document.
   */
  status: "queued" | "retrying" | "running" | "completed" | "failed";
  /** Boxes currently stored on the document (populated once the job writes). */
  fieldCount: number;
  /** 1-based attempt currently recorded, when the job has failed at least once. */
  attempt?: number;
  maxAttempts?: number;
  /** When the next attempt becomes claimable (ISO), while retrying. */
  nextRunAt?: string;
  error?: string;
}

/**
 * Poll a queued field scan.
 *
 * Read-only, so it gates on aiTask:view plus document:view (two-key model).
 */
export const getFieldScanStatus = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof fieldScanStatusSchema>) =>
    fieldScanStatusSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("aiTask", "view", async ({ orgId, db, role }) => {
      assertRolePermission(role, "document", "view");
      const { jobId, documentId } = fieldScanStatusSchema.parse(rawData);

      const [doc] = await db
        .select({ boxes: documents.ocrBoundingBoxes })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);
      if (!doc) throw new Error("Document not found");
      const fieldCount = doc.boxes?.length ?? 0;

      const [job] = await db
        .select({
          status: processingJobs.status,
          lastError: processingJobs.lastError,
          attempts: processingJobs.attempts,
          maxAttempts: processingJobs.maxAttempts,
          runAt: processingJobs.runAt,
        })
        .from(processingJobs)
        .where(and(eq(processingJobs.id, jobId), eq(processingJobs.organizationId, orgId)))
        .limit(1);

      if (!job) {
        // No row for this org. Nothing deletes processing_jobs, so this is a
        // bogus or cross-org job id — not a completed scan. Reporting
        // `completed` here (as this used to) turned an unauthorized or
        // mistyped id into a silent success. Trust the boxes instead: they
        // are the outcome the caller is actually waiting for.
        return fieldCount > 0
          ? ({ status: "completed", fieldCount } satisfies FieldScanStatus)
          : ({
              status: "failed",
              fieldCount: 0,
              error: "Field scan job not found.",
            } satisfies FieldScanStatus);
      }

      if (job.status === "running") {
        return { status: "running", fieldCount } satisfies FieldScanStatus;
      }
      if (job.status === "failed") {
        return {
          status: "failed",
          fieldCount,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          ...(job.lastError ? { error: job.lastError } : {}),
        } satisfies FieldScanStatus;
      }
      if (job.status === "queued") {
        // Attempts already spent means this is a backoff wait, not a job
        // that has yet to start.
        if (job.attempts > 0) {
          return {
            status: "retrying",
            fieldCount,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
            ...(job.runAt ? { nextRunAt: job.runAt.toISOString() } : {}),
            ...(job.lastError ? { error: job.lastError } : {}),
          } satisfies FieldScanStatus;
        }
        return { status: "queued", fieldCount } satisfies FieldScanStatus;
      }
      return { status: "completed", fieldCount } satisfies FieldScanStatus;
    }) as any;
  });
