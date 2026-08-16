// ============================================================================
// PDF unlock — detect password-protected statement PDFs and render their pages
// to images for OCR.
//
// Gemini cannot open an encrypted PDF, so once we have the password we decrypt
// locally (via pdf-to-img → pdfjs, which accepts a `password`) and render each
// page to a JPEG that Gemini CAN read.
//
// pdfjs raises a `PasswordException` with:
//   code 1 (NEED_PASSWORD)      — encrypted, no/blank password supplied
//   code 2 (INCORRECT_PASSWORD) — encrypted, wrong password supplied
// ============================================================================

import sharp from "sharp";
import { createLogger } from "./logger";

const logger = createLogger("pdf.unlock");

const NEED_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;

/** Max pages we render for OCR — a guard against pathological documents. */
const DEFAULT_MAX_PAGES = 30;

export type PdfProbeStatus = "ok" | "password_required" | "wrong_password";

/**
 * Thrown by the inbox extraction path when an emailed PDF is password-protected
 * and no stored org password unlocks it. The worker branches on `.kind` to
 * raise a blocking `attachment_password_required` review finding.
 */
export class PdfPasswordRequiredError extends Error {
  readonly kind = "password_required" as const;
  constructor(message = "The attached PDF is password-protected.") {
    super(message);
    this.name = "PdfPasswordRequiredError";
  }
}

export function isPdfPasswordRequiredError(err: unknown): err is PdfPasswordRequiredError {
  return (
    err instanceof PdfPasswordRequiredError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { kind?: string }).kind === "password_required")
  );
}

export interface RenderedPage {
  /** base64-encoded JPEG bytes */
  data: string;
  mimeType: "image/jpeg";
}

function isPasswordException(err: unknown): err is { name: string; code: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PasswordException"
  );
}

/**
 * Probe a PDF's encryption state. Returns:
 *   "ok"                — opens with the given password (or is not encrypted)
 *   "password_required" — encrypted, needs a password we don't have
 *   "wrong_password"    — encrypted, the supplied password is wrong
 *
 * Non-password errors (corrupt/unsupported PDF) resolve to "ok" so the caller's
 * existing downstream error handling deals with them unchanged.
 */
export async function probePdf(buffer: Buffer, password?: string): Promise<PdfProbeStatus> {
  const { pdf } = await import("pdf-to-img");
  try {
    await pdf(buffer, password ? { password } : {});
    return "ok";
  } catch (err) {
    if (isPasswordException(err)) {
      if (err.code === INCORRECT_PASSWORD) return "wrong_password";
      if (err.code === NEED_PASSWORD) return "password_required";
      return "password_required";
    }
    if (password !== undefined && isLikelyBadPassword(err)) {
      return "wrong_password";
    }
    return "ok";
  }
}

function isLikelyBadPassword(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return msg.includes("password");
}

/**
 * Try each candidate password against an encrypted PDF; return the first that
 * opens it, or null if none work. Used on the inbox path where no human is
 * present to type a password.
 */
export async function findWorkingPassword(
  buffer: Buffer,
  candidates: string[],
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if ((await probePdf(buffer, candidate)) === "ok") return candidate;
  }
  return null;
}

/**
 * Render (up to maxPages) pages of a PDF to base64 JPEGs suitable for Gemini
 * inline data. Supply `password` for encrypted PDFs.
 */
export async function renderPdfPagesForOcr(
  buffer: Buffer,
  opts: { password?: string; maxPages?: number; scale?: number } = {},
): Promise<RenderedPage[]> {
  const { password, maxPages = DEFAULT_MAX_PAGES, scale = 2.0 } = opts;
  const { pdf } = await import("pdf-to-img");
  const document = await pdf(buffer, password ? { password, scale } : { scale });

  const pages: RenderedPage[] = [];
  let index = 0;
  for await (const pngBuffer of document) {
    if (index >= maxPages) {
      logger.warn("PDF exceeds max render pages — truncating for OCR", {
        maxPages,
        total: document.length,
      });
      break;
    }
    const jpeg = await sharp(pngBuffer).jpeg({ quality: 85 }).toBuffer();
    pages.push({ data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    index++;
  }
  return pages;
}
