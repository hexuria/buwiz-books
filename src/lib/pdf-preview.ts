// ============================================================================
// PDF → PNG preview rendering, without a request.
//
// Extracted from the `generatePdfPreview` server fn so worker jobs can call
// it: that fn is wrapped in `withMutationPermissionOrgContext`, which reads
// `getRequest()` — a job has no request, so it could not be reused as-is.
//
// These PNGs are the images the document viewer actually displays, which is
// why `bbox_scan` scans exactly these bytes rather than re-rasterizing the
// original PDF. Sharing one page list makes "box.page indexes into the image
// the user is looking at" true by construction instead of by coincidence.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { documents } from "../db/schema/documents";
import { createLogger } from "./logger";
import { generateR2Key, isR2Configured, uploadToR2 } from "./storage";

const logger = createLogger("lib.pdf-preview");

export interface RenderPreviewsInput {
  orgId: string;
  documentId: string;
  buffer: Buffer;
  mimeType: string;
  /** For encrypted PDFs; omitted callers keep the previous behaviour. */
  password?: string;
  /** Optional page ceiling. Previews are cheap, so default to all pages. */
  maxPages?: number;
}

export interface RenderPreviewsResult {
  previewR2Keys: string[];
  pageCount: number;
  skipped: boolean;
  reason?: string;
  /** True when the PDF needs a password we were not given. */
  passwordRequired?: boolean;
}

/**
 * Render every page of a PDF to PNG, store them in R2, and record the keys
 * on the document row. Never throws — a failure returns `skipped` with a
 * reason, because a missing preview must not fail the caller's own work.
 */
export async function renderAndStorePdfPreviews(
  db: DbExecutor,
  input: RenderPreviewsInput,
): Promise<RenderPreviewsResult> {
  const { orgId, documentId, buffer, mimeType, password, maxPages } = input;

  if (!mimeType.includes("pdf")) {
    return { previewR2Keys: [], pageCount: 0, skipped: true, reason: "Not a PDF" };
  }

  try {
    // pdf-to-img is ESM-only, so it must be imported dynamically.
    const { pdf } = await import("pdf-to-img");
    const pagesIter = await pdf(buffer, { scale: 2.0, ...(password ? { password } : {}) });

    if (!isR2Configured()) throw new Error("R2 is not configured");

    const timestamp = Date.now();
    const previewR2Keys: string[] = [];
    let pageIndex = 0;

    for await (const pagePng of pagesIter) {
      if (maxPages && pageIndex >= maxPages) break;
      const pageKey = generateR2Key(orgId, `bills/previews/${timestamp}_page_${pageIndex}.png`);
      await uploadToR2(pageKey, Buffer.from(pagePng), "image/png");
      previewR2Keys.push(pageKey);
      pageIndex++;
    }

    if (previewR2Keys.length === 0) {
      return { previewR2Keys: [], pageCount: 0, skipped: true, reason: "No pages in PDF" };
    }

    await db
      .update(documents)
      .set({
        // previewImageR2Key stays page 1 for backward compatibility.
        previewImageR2Key: previewR2Keys[0],
        previewPageR2Keys: previewR2Keys,
        pageCount: previewR2Keys.length,
      })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)));

    return { previewR2Keys, pageCount: previewR2Keys.length, skipped: false };
  } catch (error) {
    const passwordRequired = (error as { name?: string })?.name === "PasswordException";
    logger.error("PDF preview generation failed", {
      documentId,
      orgId,
      error,
      passwordProtected: passwordRequired,
    });
    return {
      previewR2Keys: [],
      pageCount: 0,
      skipped: true,
      ...(passwordRequired ? { passwordRequired: true } : {}),
      reason: passwordRequired
        ? "PDF is password-protected"
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}
