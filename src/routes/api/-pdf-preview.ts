// ============================================================================
// PDF → PNG Preview Generator (Server-side)
// Converts all PDF pages to high-res PNGs for the interactive SVG viewer.
// Uses pdf-to-img (wraps pdfjs-dist) for rendering.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { renderAndStorePdfPreviews } from "../../lib/pdf-preview";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { z } from "zod";

const generatePdfPreviewSchema = z.object({
  documentId: z.string().uuid(),
  pdfBase64: z.string().min(1),
  mimeType: z.string().min(1),
});

/**
 * Generate PNG preview images from a PDF document.
 * Renders ALL pages as PNGs, uploads each to R2.
 * Returns the array of preview R2 keys and the page count.
 *
 * Backward compat: `previewImageR2Key` still points to page 1.
 */
export const generatePdfPreview = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof generatePdfPreviewSchema>) =>
    generatePdfPreviewSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "create",
      { routeKey: "document:pdf-preview", limit: 20, windowMs: 300_000 },
      async ({ orgId, db }) => {
        const { documentId, pdfBase64, mimeType } = generatePdfPreviewSchema.parse(rawData);
        const { previewR2Keys, pageCount, skipped, reason } = await renderAndStorePdfPreviews(db, {
          orgId,
          documentId,
          buffer: Buffer.from(pdfBase64, "base64"),
          mimeType,
        });
        // Return shape is unchanged: `reason` is present only when skipped.
        return skipped
          ? { previewR2Keys, pageCount, skipped: true, reason }
          : { previewR2Keys, pageCount, skipped: false };
      },
    );
  });
