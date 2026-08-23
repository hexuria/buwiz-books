/**
 * Job handler for `bbox_scan` — server-side field bounding-box extraction.
 *
 * The client used to drive this page-by-page: one round trip per page, each
 * re-uploading the rendered image and each writing the document row (ai_findings
 * #20). Here the document is downloaded and rasterized ONCE, every page is
 * scanned in a loop with the lease extended between pages, and the accumulated
 * boxes are written to `documents.ocr_bounding_boxes` in a single update.
 *
 * Bounding boxes are presentation metadata: a page whose extraction fails
 * contributes nothing and never fails the job.
 *
 * The pages scanned here are the stored preview PNGs — the exact images the
 * viewer displays — so `box.page` always indexes into something the user can
 * see. Boxes are keyed by (page, fieldId); `fieldId` stays a pure semantic
 * type tag, since consumers look it up in colour and label tables.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withOrgContext } from "@/db";
import { documents } from "@/db/schema/documents";
import { processingJobs } from "@/db/schema/inbox";
import { aiComplete } from "@/lib/ai/facade";
import { extendProcessingJobLease } from "@/lib/inbox/processing-job-lease";
import { createLogger } from "@/lib/logger";
import { renderAndStorePdfPreviews } from "@/lib/pdf-preview";
import { downloadFromR2, isR2Configured } from "@/lib/storage";
import type { BoundingBox } from "@/routes/api/-ai-bill-ocr";
import { retryPolicyFor } from "../retry-policy";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.bbox-scan");

export const BBOX_SCAN_JOB_TYPE = "bbox_scan";

/**
 * Hard ceiling on billed pages per scan. Previews stay uncapped — the viewer
 * needs every page — so a capped scan is reported, not silently truncated.
 */
export const MAX_SCAN_PAGES = 30;

export interface BboxScanJobPayload {
  documentId: string;
  /** Optional cap on pages to scan (defaults to every rendered page). */
  pageCount?: number;
  /** Password for an encrypted PDF, when previews still need rendering. */
  password?: string;
}

export function bboxScanDedupeKey(documentId: string): string {
  return `bbox_scan:${documentId}`;
}

export async function processBboxScanJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const { workerId } = ctx;
  const orgId = job.organizationId;
  const payload = job.payload as Partial<BboxScanJobPayload>;
  if (!payload.documentId) throw new Error("Bounding-box scan job payload is incomplete.");
  const documentId = payload.documentId;

  const [document] = await withOrgContext(orgId, "system", "admin", (tx) =>
    tx
      .select({
        id: documents.id,
        r2Key: documents.r2Key,
        mimeType: documents.mimeType,
        previewPageR2Keys: documents.previewPageR2Keys,
        previewImageR2Key: documents.previewImageR2Key,
      })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
      .limit(1),
  );
  if (!document) throw new Error("Bounding-box scan document no longer exists.");
  if (!document.r2Key) throw new Error("Bounding-box scan document has no storage object key.");
  if (!isR2Configured()) throw new Error("Document storage is not configured.");

  // `.includes` rather than a strict equality check: a non-canonical PDF
  // mime (e.g. "application/pdf; charset=binary") would otherwise fall to
  // the image branch and hand the model raw PDF bytes as an image part.
  const mimeType = document.mimeType || "application/pdf";
  const isPdf = mimeType.includes("pdf");

  // Scan the SAME preview PNGs the viewer renders, generating them if this
  // document has none yet. Rasterizing separately would leave two page lists
  // that only agree by luck — and they already disagreed, because preview
  // generation is uncapped while the OCR rasterizer silently stops at 30.
  let pageKeys: string[] = [];
  if (isPdf) {
    pageKeys = document.previewPageR2Keys ?? [];
    if (pageKeys.length === 0 && document.previewImageR2Key) {
      pageKeys = [document.previewImageR2Key];
    }
    if (pageKeys.length === 0) {
      const buffer = await downloadFromR2(document.r2Key);
      const rendered = await withOrgContext(orgId, "system", "admin", (tx) =>
        renderAndStorePdfPreviews(tx, {
          orgId,
          documentId,
          buffer,
          mimeType,
          ...(payload.password ? { password: payload.password } : {}),
        }),
      );
      if (rendered.passwordRequired) {
        throw new Error("Bounding-box scan needs the PDF password.");
      }
      pageKeys = rendered.previewR2Keys;
    }
    if (pageKeys.length === 0) {
      throw new Error("Bounding-box scan could not render any page of this document.");
    }
  }

  const pagesTotal = isPdf ? pageKeys.length : 1;
  const requested = payload.pageCount && payload.pageCount > 0 ? payload.pageCount : pagesTotal;
  // Cap the SCAN, not the preview: each page here is a billed model call,
  // whereas previews are cheap and the viewer wants every page.
  const pagesScanned = Math.min(requested, pagesTotal, MAX_SCAN_PAGES);

  const boxes: BoundingBox[] = [];
  let pagesSucceeded = 0;
  let pagesFailed = 0;

  for (let page = 0; page < pagesScanned; page += 1) {
    await extendProcessingJobLease(orgId, job.id, workerId);
    try {
      const media = isPdf
        ? {
            mimeType: "image/png",
            dataBase64: (await downloadFromR2(pageKeys[page])).toString("base64"),
          }
        : {
            mimeType,
            dataBase64: (await downloadFromR2(document.r2Key)).toString("base64"),
          };
      const result = await aiComplete<BoundingBox[]>({
        task: "bbox_scan",
        input: { page },
        ctx: { orgId },
        media: [media],
      });
      if (!result.ok) {
        pagesFailed += 1;
        logger.warn("Bounding box output failed validation", {
          orgId,
          documentId,
          page,
          issues: result.issues,
        });
        continue;
      }
      pagesSucceeded += 1;
      for (const box of result.data) {
        // Position lives in `page`. Encoding it into `fieldId` (the old
        // `p{n}_` prefix) broke every consumer lookup keyed on field type.
        boxes.push({ ...box, page });
      }
    } catch (error) {
      // A thrown transport error used to kill the whole job, which then
      // re-scanned — and re-billed — every page that had already succeeded.
      pagesFailed += 1;
      logger.warn("Bounding box scan failed for a page", {
        orgId,
        documentId,
        page,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Two signals, not one. `boxes.length > 0` alone can never record a
  // genuinely field-less document; writing unconditionally (the previous
  // behaviour) lets an all-pages-failed run wipe boxes that were correct.
  const shouldWrite = boxes.length > 0 || pagesSucceeded > 0;
  if (shouldWrite) {
    await withOrgContext(orgId, "system", "admin", async (tx) => {
      await tx
        .update(documents)
        .set({
          ocrBoundingBoxes: boxes,
          // Same .set() as the boxes so the two cannot diverge: the cached
          // transaction parse is derived from these boxes but its context
          // hash is computed from accounts only, so nothing else
          // invalidates it when they change.
          aiTransactionCache: null,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)));
    });
  }

  const [completed] = await withOrgContext(orgId, "system", "admin", (tx) =>
    tx
      .update(processingJobs)
      .set({
        status: "completed",
        lockedBy: null,
        lockedUntil: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(processingJobs.id, job.id),
          eq(processingJobs.status, "running"),
          eq(processingJobs.lockedBy, workerId),
        ),
      )
      .returning({ id: processingJobs.id }),
  );
  if (!completed) return { processed: false, reason: "lease_lost", jobId: job.id };

  return {
    processed: true,
    jobId: job.id,
    documentId,
    pagesScanned,
    pagesTotal,
    pagesSucceeded,
    pagesFailed,
    // Surfaced rather than logged: the viewer shows every page, so a capped
    // scan means later pages legitimately have no overlays.
    capped: pagesScanned < pagesTotal,
    wrote: shouldWrite,
    boundingBoxes: boxes.length,
  };
}

/** Enqueue (or reuse) the bounding-box scan job for a document. */
export async function enqueueBboxScanJob(
  tx: import("@/db").DbExecutor,
  input: { organizationId: string; documentId: string; pageCount?: number },
): Promise<string | null> {
  const dedupeKey = bboxScanDedupeKey(input.documentId);
  const [created] = await tx
    .insert(processingJobs)
    .values({
      organizationId: input.organizationId,
      jobType: BBOX_SCAN_JOB_TYPE,
      // Interactive: a user is watching a spinner, so fail fast enough that
      // the failure is still reportable inside their poll window.
      maxAttempts: retryPolicyFor(BBOX_SCAN_JOB_TYPE).maxAttempts,
      dedupeKey,
      payload: {
        documentId: input.documentId,
        ...(input.pageCount ? { pageCount: input.pageCount } : {}),
      },
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  if (created) return created.id;

  const [existing] = await tx
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.organizationId, input.organizationId),
        eq(processingJobs.dedupeKey, dedupeKey),
        inArray(processingJobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}
