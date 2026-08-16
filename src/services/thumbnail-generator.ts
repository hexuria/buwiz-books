// ============================================================================
// Thumbnail Generator Service
//
// Generates document thumbnails using:
//  1. Sharp — for native image files (jpg, png, gif, webp)
//  2. pdf-to-img — for PDF files (first page extraction)
//  3. Programmatic card — for all other file types (styled metadata card)
//
// AI image generation is NOT used by default. It is exposed as a separate
// function for manual regeneration only (user clicks "Regenerate with AI").
//
// Thumbnails are stored in R2 at: {orgId}/thumbnails/{documentId}.webp
// and the key is persisted to documents.thumbnailR2Key
// ============================================================================

import sharp from "sharp";
import { db, withOrgContext, type DbExecutor } from "../db";
import { documents } from "../db/schema/documents";
import { organization } from "../db/schema/auth";
import { eq, and } from "drizzle-orm";
import { uploadToR2, downloadFromR2, isR2Configured } from "../lib/storage";
import { invokeModelRaw } from "../lib/ai/invoke";
import type { GeminiCallOptions } from "../lib/gemini-client";
import { createLogger } from "../lib/logger";

// ── Constants ────────────────────────────────────────────────────────────────

const THUMBNAIL_WIDTH = 256;
const THUMBNAIL_HEIGHT = 256;
const THUMBNAIL_QUALITY = 80;
const IMAGE_FILE_TYPES = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const PDF_FILE_TYPES = new Set(["pdf"]);
const logger = createLogger("services.thumbnail-generator");

// ── Types ────────────────────────────────────────────────────────────────────

interface ThumbnailResult {
  success: boolean;
  thumbnailR2Key?: string;
  error?: string;
}

interface DocumentRow {
  id: string;
  r2Key: string | null;
  fileType: string;
  documentType: string;
  displayTitle: string | null;
  originalFilename: string;
  organizationId: string;
  thumbnailR2Key: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if org has AI image generation enabled in metadata.
 * Reads the non-RLS `organization` auth table, so the raw pool is safe here.
 */
async function isImageGenerationEnabled(orgId: string): Promise<boolean> {
  try {
    const [org] = await db
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);

    if (!org?.metadata) return false;

    const meta = JSON.parse(org.metadata);
    return meta.enableImageGeneration === true;
  } catch {
    return false;
  }
}

/** Generate thumbnail R2 key */
function getThumbnailR2Key(orgId: string, documentId: string): string {
  return `${orgId}/thumbnails/${documentId}.webp`;
}

/**
 * Run a document read/write inside RLS org context. Thumbnail generation runs as a
 * fire-and-forget background job, so there is no request-scoped ctx.db to borrow —
 * it sets its own org context with a system actor. The role must pass is_admin()
 * because the documents UPDATE policy only allows admins or the uploading user.
 * Keep these scopes short (single statement) so model calls and R2 I/O never run
 * inside an open transaction.
 */
function withDocumentOrgContext<T>(orgId: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return withOrgContext(orgId, "system", "admin", fn);
}

// ── 1. Native Image Thumbnail ───────────────────────────────────────────────

/**
 * Generate a thumbnail from a native image file (jpg, png, gif, webp).
 * Downloads from R2, resizes with sharp, converts to webp.
 */
async function generateImageThumbnail(doc: DocumentRow): Promise<Buffer> {
  if (!doc.r2Key) throw new Error("Document has no R2 key");
  const imageBuffer = await downloadFromR2(doc.r2Key);

  return sharp(imageBuffer)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "cover" })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}

// ── 2. PDF Thumbnail ────────────────────────────────────────────────────────

/**
 * Generate a thumbnail from a PDF by extracting the first page as an image.
 * Uses pdf-to-img (same lib as the bill preview generator).
 */
async function generatePdfThumbnail(doc: DocumentRow): Promise<Buffer> {
  if (!doc.r2Key) throw new Error("Document has no R2 key");
  const pdfBuffer = await downloadFromR2(doc.r2Key);

  // Dynamically import pdf-to-img (ESM-only module)
  const { pdf } = await import("pdf-to-img");

  // Render page 1 at 1x scale (enough for a 256px thumbnail)
  let firstPagePng: Uint8Array | null = null;
  try {
    const pagesIter = await pdf(pdfBuffer, { scale: 1.5 });
    for await (const page of pagesIter) {
      firstPagePng = page;
      break; // Only first page
    }
  } catch (err) {
    // Password-protected PDFs can't be rasterized without the password — fall
    // back to a type-colored card thumbnail instead of failing outright.
    if ((err as { name?: string })?.name === "PasswordException") {
      return generateCardThumbnail(doc);
    }
    throw err;
  }

  if (!firstPagePng) throw new Error("No pages in PDF");

  // Resize the first page to thumbnail dimensions
  return sharp(Buffer.from(firstPagePng))
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "cover" })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}

// ── 3. Programmatic Card Thumbnail ──────────────────────────────────────────

/** Color palette for document type cards */
const DOC_TYPE_COLORS: Record<string, { bg: string; accent: string }> = {
  statement: { bg: "#0f766e", accent: "#5eead4" },
  bill: { bg: "#7e22ce", accent: "#c084fc" },
  invoice: { bg: "#1d4ed8", accent: "#93c5fd" },
  receipt: { bg: "#b45309", accent: "#fcd34d" },
  contract: { bg: "#334155", accent: "#94a3b8" },
  tax_form: { bg: "#b91c1c", accent: "#fca5a5" },
  other: { bg: "#475569", accent: "#94a3b8" },
};

/** File extension labels */
const FILE_EXT_LABELS: Record<string, string> = {
  csv: "CSV",
  xlsx: "XLSX",
  xls: "XLS",
  doc: "DOC",
  docx: "DOCX",
  txt: "TXT",
  zip: "ZIP",
  xml: "XML",
  json: "JSON",
};

/**
 * Generate a styled card thumbnail for non-image, non-PDF documents.
 * Creates a coloured card with the document type label and file type icon
 * using SVG → sharp rendering. No AI needed.
 */
async function generateCardThumbnail(doc: DocumentRow): Promise<Buffer> {
  const colors = DOC_TYPE_COLORS[doc.documentType] || DOC_TYPE_COLORS.other;
  const docTypeLabel = doc.documentType.replace(/_/g, " ").toUpperCase();
  const fileExtLabel = FILE_EXT_LABELS[doc.fileType] || doc.fileType.toUpperCase();
  const title = (doc.displayTitle || doc.originalFilename).slice(0, 28);

  const svg = `
    <svg width="${THUMBNAIL_WIDTH}" height="${THUMBNAIL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${colors.bg}"/>
          <stop offset="100%" stop-color="${colors.bg}88"/>
        </linearGradient>
      </defs>

      <!-- Background -->
      <rect width="${THUMBNAIL_WIDTH}" height="${THUMBNAIL_HEIGHT}" rx="16" fill="url(#bg)"/>

      <!-- Document icon -->
      <g transform="translate(88, 40)">
        <rect x="0" y="0" width="80" height="100" rx="8" fill="white" opacity="0.15"/>
        <rect x="8" y="16" width="48" height="4" rx="2" fill="${colors.accent}" opacity="0.7"/>
        <rect x="8" y="28" width="64" height="4" rx="2" fill="white" opacity="0.25"/>
        <rect x="8" y="38" width="56" height="4" rx="2" fill="white" opacity="0.2"/>
        <rect x="8" y="48" width="60" height="4" rx="2" fill="white" opacity="0.15"/>
        <rect x="8" y="58" width="40" height="4" rx="2" fill="white" opacity="0.1"/>
        <!-- File extension badge -->
        <rect x="36" y="72" width="40" height="20" rx="4" fill="${colors.accent}"/>
        <text x="56" y="86" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="700" fill="${colors.bg}">${fileExtLabel}</text>
      </g>

      <!-- Document type label -->
      <text x="${THUMBNAIL_WIDTH / 2}" y="170" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="12" font-weight="700" fill="${colors.accent}" letter-spacing="1.5">${docTypeLabel}</text>

      <!-- Title (truncated) -->
      <text x="${THUMBNAIL_WIDTH / 2}" y="192" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="10" fill="white" opacity="0.6">${escapeXml(title)}</text>
    </svg>`;

  return sharp(Buffer.from(svg))
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}

/** Escape special characters for SVG text elements */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── 4. AI-Generated Thumbnail (manual only) ─────────────────────────────────

/**
 * Generate a thumbnail using Gemini AI image generation.
 * This is ONLY called when the user manually requests AI regeneration.
 */
async function generateAIThumbnail(doc: DocumentRow): Promise<Buffer> {
  const title = doc.displayTitle || doc.originalFilename;
  const docType = doc.documentType.replace(/_/g, " ");

  const prompt = `Generate a clean, professional thumbnail icon representing a ${docType} document titled "${title}". 
The thumbnail should be minimalist with a flat design style, using subtle professional colors. 
Show a stylized document icon with relevant visual elements for a ${docType}.
The image should work well as a small 256x256 thumbnail preview.
Do NOT include any text in the image.`;

  const opts: GeminiCallOptions = {
    orgId: doc.organizationId,
    task: "imageGen",
    generationConfig: {
      // @ts-expect-error -- responseModalities is valid for image models
      responseModalities: ["Image"],
    },
  };

  const { result } = await invokeModelRaw({ ...opts, taskName: "thumbnail" }, async (model) =>
    model.generateContent([prompt]),
  );

  const parts = result.response.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("No parts in Gemini response");

  for (const part of parts) {
    if (part.inlineData?.data) {
      const imageBuffer = Buffer.from(part.inlineData.data, "base64");
      return sharp(imageBuffer)
        .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "cover" })
        .webp({ quality: THUMBNAIL_QUALITY })
        .toBuffer();
    }
  }

  throw new Error("No image data in Gemini response");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a thumbnail for a document and store it in R2.
 *
 * Strategy (automatic — no AI):
 *  1. Image files → native resize with Sharp
 *  2. PDF files → first page extraction with pdf-to-img
 *  3. Other files → programmatic styled card (SVG → Sharp)
 *
 * @param documentId - The document ID to generate a thumbnail for
 * @param orgId - The organization ID (for auth/scoping)
 * @returns ThumbnailResult with success status and optional thumbnail key
 */
export async function generateThumbnail(
  documentId: string,
  orgId: string,
): Promise<ThumbnailResult> {
  let fileType: string | null = null;
  try {
    if (!isR2Configured()) {
      return { success: false, error: "R2 storage not configured" };
    }

    const [doc] = await withDocumentOrgContext(orgId, (tx) =>
      tx
        .select({
          id: documents.id,
          r2Key: documents.r2Key,
          fileType: documents.fileType,
          documentType: documents.documentType,
          displayTitle: documents.displayTitle,
          originalFilename: documents.originalFilename,
          organizationId: documents.organizationId,
          thumbnailR2Key: documents.thumbnailR2Key,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1),
    );

    if (!doc) return { success: false, error: "Document not found" };
    fileType = doc.fileType;

    let thumbnailBuffer: Buffer;

    if (IMAGE_FILE_TYPES.has(doc.fileType)) {
      thumbnailBuffer = await generateImageThumbnail(doc);
    } else if (PDF_FILE_TYPES.has(doc.fileType)) {
      thumbnailBuffer = await generatePdfThumbnail(doc);
    } else {
      thumbnailBuffer = await generateCardThumbnail(doc);
    }

    // Upload thumbnail to R2
    const thumbnailR2Key = getThumbnailR2Key(orgId, documentId);
    await uploadToR2(thumbnailR2Key, thumbnailBuffer, "image/webp");

    // Update document record
    await withDocumentOrgContext(orgId, (tx) =>
      tx
        .update(documents)
        .set({ thumbnailR2Key, updatedAt: new Date() })
        .where(eq(documents.id, documentId)),
    );

    logger.info("Generated document thumbnail", {
      documentId,
      fileType,
      strategy: "automatic",
    });

    return { success: true, thumbnailR2Key };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to generate document thumbnail", {
      documentId,
      fileType,
      error: message,
    });
    return { success: false, error: message };
  }
}

/**
 * Regenerate a document thumbnail using Gemini AI.
 * This is a MANUAL action — only called when the user explicitly requests it.
 * Requires enableImageGeneration to be on in org settings.
 */
export async function regenerateThumbnailWithAI(
  documentId: string,
  orgId: string,
): Promise<ThumbnailResult> {
  let fileType: string | null = null;
  try {
    if (!isR2Configured()) {
      return { success: false, error: "R2 storage not configured" };
    }

    const aiEnabled = await isImageGenerationEnabled(orgId);
    if (!aiEnabled) {
      return { success: false, error: "AI image generation is disabled in settings" };
    }

    const [doc] = await withDocumentOrgContext(orgId, (tx) =>
      tx
        .select({
          id: documents.id,
          r2Key: documents.r2Key,
          fileType: documents.fileType,
          documentType: documents.documentType,
          displayTitle: documents.displayTitle,
          originalFilename: documents.originalFilename,
          organizationId: documents.organizationId,
          thumbnailR2Key: documents.thumbnailR2Key,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1),
    );

    if (!doc) return { success: false, error: "Document not found" };
    fileType = doc.fileType;

    // Model call happens here, outside any open transaction.
    const thumbnailBuffer = await generateAIThumbnail(doc);

    const thumbnailR2Key = getThumbnailR2Key(orgId, documentId);
    await uploadToR2(thumbnailR2Key, thumbnailBuffer, "image/webp");

    await withDocumentOrgContext(orgId, (tx) =>
      tx
        .update(documents)
        .set({ thumbnailR2Key, updatedAt: new Date() })
        .where(eq(documents.id, documentId)),
    );

    logger.info("Regenerated document thumbnail with AI", {
      documentId,
      fileType,
      strategy: "ai",
    });

    return { success: true, thumbnailR2Key };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to regenerate document thumbnail with AI", {
      documentId,
      fileType,
      error: message,
    });
    return { success: false, error: message };
  }
}
