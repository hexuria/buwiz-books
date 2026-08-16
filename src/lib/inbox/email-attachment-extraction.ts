import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { db as applicationDb, type DbExecutor } from "@/db";
import { documents } from "@/db/schema/documents";
import { aiComplete } from "@/lib/ai/facade";
import { emailExtractionOutputSchema } from "@/lib/ai/schemas/email-extraction";
import {
  probePdf,
  renderPdfPagesForOcr,
  findWorkingPassword,
  PdfPasswordRequiredError,
} from "@/lib/pdf-unlock";
import { listOrgStatementPasswords } from "@/lib/financial-account-secrets";
import {
  EMAIL_ATTACHMENT_EXTRACTION_VERSION,
  hasReusableEmailAttachmentExtraction,
} from "./email-attachment-extraction-policy";

export {
  EMAIL_ATTACHMENT_EXTRACTION_VERSION,
  hasReusableEmailAttachmentExtraction,
} from "./email-attachment-extraction-policy";

// Single source of truth for the output schema lives in the shared AI
// schemas module (Phase-1 prompt registry reuses it from there).
const extractionResultSchema = emailExtractionOutputSchema;

export type EmailAttachmentExtraction = z.infer<typeof extractionResultSchema>;

/**
 * Thrown when the model's extraction fails schema validation. The inbox
 * worker's existing catch converts this into `extractionError` data on the
 * candidate (needs_information), instead of a raw ZodError.
 */
export class EmailExtractionInvalidError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(
      `Attachment extraction failed validation: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? "; …" : ""}`,
    );
    this.name = "EmailExtractionInvalidError";
    this.issues = issues;
  }
}

export interface EnsureDocumentMatchingExtractionInput {
  organizationId: string;
  documentId: string;
  fileBuffer: Buffer;
  mimeType: string;
  filename: string;
  documentType: string;
  fallbackCurrency?: string | null;
  fallbackDate?: string | null;
  /** Explicit password for a locked PDF (from a manual resolve). When unset,
   *  the org's stored statement passwords are tried automatically. */
  password?: string;
}

export type EnsureEmailAttachmentExtractionInput = EnsureDocumentMatchingExtractionInput;

/**
 * Ensure a canonical document has enough cached facts for deterministic matching.
 *
 * The transaction-scoped advisory lock serializes extraction by canonical document
 * ID. The document is re-read after the lock, so concurrent email retries reuse the
 * winning extraction instead of issuing another model call.
 */
export async function ensureDocumentMatchingExtraction(
  database: DbExecutor,
  input: EnsureDocumentMatchingExtractionInput,
): Promise<typeof documents.$inferSelect> {
  await database.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${"document-matching-ocr:" + input.organizationId + ":" + input.documentId}, 0::bigint)
    )
  `);
  const [document] = await database
    .select()
    .from(documents)
    .where(
      and(eq(documents.id, input.documentId), eq(documents.organizationId, input.organizationId)),
    )
    .limit(1);
  if (!document) throw new Error("Canonical attachment document was not found.");
  if (hasReusableEmailAttachmentExtraction(document)) return document;

  // Password-protected PDFs can't be read by Gemini directly. Auto-unlock with
  // one of the org's stored statement passwords (or the one supplied by a
  // manual resolve), decrypt, and send rendered page images instead. If none
  // work, raise a marked error so the worker parks a blocking review finding.
  let media: Array<{ mimeType: string; dataBase64: string }> = [
    { mimeType: input.mimeType, dataBase64: input.fileBuffer.toString("base64") },
  ];
  if (input.mimeType === "application/pdf") {
    const initialProbe = input.password
      ? await probePdf(input.fileBuffer, input.password)
      : await probePdf(input.fileBuffer);
    if (initialProbe !== "ok") {
      const candidates = input.password
        ? [input.password]
        : await listOrgStatementPasswords(database, input.organizationId);
      const working = await findWorkingPassword(input.fileBuffer, candidates);
      if (!working) throw new PdfPasswordRequiredError();
      const pages = await renderPdfPagesForOcr(input.fileBuffer, { password: working });
      media = pages.map((p) => ({ mimeType: p.mimeType, dataBase64: p.data }));
    }
  }

  const result = await aiComplete<EmailAttachmentExtraction>({
    task: "email_extraction",
    input: {
      filename: input.filename,
      documentType: input.documentType,
      fallbackDate: input.fallbackDate,
      fallbackCurrency: input.fallbackCurrency,
    },
    ctx: { orgId: input.organizationId },
    media,
  });
  if (!result.ok) {
    throw new EmailExtractionInvalidError(result.issues);
  }
  const parsed = result.data;
  const [updated] = await database
    .update(documents)
    .set({
      metadata: {
        ...document.metadata,
        inboxExtraction: {
          result: parsed,
          version: EMAIL_ATTACHMENT_EXTRACTION_VERSION,
          cachedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, document.id), eq(documents.organizationId, input.organizationId)))
    .returning();
  if (!updated) throw new Error("Attachment extraction could not be cached.");
  return updated;
}

/**
 * Backward-compatible root-database wrapper for the asynchronous email worker.
 * Request-scoped callers already inside an organization transaction should use
 * ensureDocumentMatchingExtraction directly.
 */
export async function ensureEmailAttachmentExtraction(
  database: typeof applicationDb,
  input: EnsureEmailAttachmentExtractionInput,
): Promise<typeof documents.$inferSelect> {
  return database.transaction((tx) => ensureDocumentMatchingExtraction(tx, input));
}
