// ============================================================================
// AI Statement OCR — Server Function (Gemini Vision)
// parseStatementDocument — text extraction (classification, metadata, transactions)
// Bounding boxes are handled by extractBoundingBoxes from -ai-bill-ocr.server.ts
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { GeminiRateLimitError } from "../../lib/gemini-client";
import { aiComplete } from "../../lib/ai/facade";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { assertRolePermission } from "../../lib/auth-middleware";
import { z } from "zod";

/**
 * Thrown when the model's statement extraction fails schema validation.
 * Carries the concrete issues so upload flows can surface an actionable
 * message (and, from Phase 2, park the pipeline as blocked instead of
 * inserting garbage lines).
 */
export class StatementParseInvalidError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(
      `Statement extraction failed validation: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? "; …" : ""}`,
    );
    this.name = "StatementParseInvalidError";
    this.issues = issues;
  }
}

// ============================================================================
// Types
// ============================================================================

/** Individual transaction extracted from the statement */
export interface ExtractedStatementLine {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // Positive = deposit, negative = withdrawal
  runningBalance?: number; // If shown on the statement
  checkNumber?: string; // If applicable
  referenceNumber?: string;
}

/** Statement metadata extracted from the header/footer */
export interface StatementMetadata {
  institutionName: string; // e.g. "Mercury", "Chase", "American Express"
  accountHolderName: string; // Organization name on the statement
  accountType: string; // "checking" | "savings" | "credit_card" | "money_market" | "other"
  accountNumberLast4: string; // Last 4 digits
  statementPeriodStart: string; // YYYY-MM-DD
  statementPeriodEnd: string; // YYYY-MM-DD
  beginningBalance: number;
  endingBalance: number;
  totalDeposits?: number;
  totalWithdrawals?: number;
  currency: string; // ISO 4217, e.g. "USD"
}

/** Classification result */
export interface DocumentClassification {
  isStatement: boolean;
  documentType: string; // "bank_statement" | "credit_card_statement" | "invoice" | "receipt" | "other"
  confidence: number; // 0-100
  rejectionReason?: string; // If not a statement
}

/** Full result from the AI statement parsing (text-only — no bounding boxes) */
export interface ParsedStatementData {
  classification: DocumentClassification;
  metadata: StatementMetadata;
  transactions: ExtractedStatementLine[];
  totalPages: number;
}

// ~20 MB file → ~28 MB base64 (matches the bill-upload cap).
export const MAX_STATEMENT_BASE64_SIZE = Math.ceil(20 * 1024 * 1024 * 1.4);

const inlinePageSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(1),
});

// Accept either a single inline document (base64Content + mimeType) or a list
// of pre-rendered page images (used when the original PDF was password-locked
// and had to be decrypted + rasterized before Gemini could read it).
const parseStatementDocumentSchema = z
  .object({
    base64Content: z
      .string()
      .min(1)
      .max(MAX_STATEMENT_BASE64_SIZE, "Statement file exceeds the maximum allowed size")
      .optional(),
    mimeType: z.string().min(1).optional(),
    pages: z.array(inlinePageSchema).min(1).optional(),
  })
  .refine((d) => (d.base64Content && d.mimeType) || (d.pages && d.pages.length > 0), {
    message: "Provide either base64Content + mimeType, or a non-empty pages array",
  });

// ============================================================================
// Server Functions
// ============================================================================

/**
 * Parse a bank statement document using Gemini Vision.
 * Text extraction only — classification, metadata, and transaction lines.
 * Bounding boxes are extracted separately via extractBoundingBoxes in -ai-bill-ocr.server.ts.
 */
export const parseStatementDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof parseStatementDocumentSchema>) =>
    parseStatementDocumentSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:statement-ocr", limit: 20, windowMs: 300_000 },
      async ({ orgId, role }) => {
        // Two-key model: statement OCR feeds the reconciliation flow.
        assertRolePermission(role, "reconciliation", "create");
        const { base64Content, mimeType, pages } = parseStatementDocumentSchema.parse(rawData);

        // Build the inline media parts: either the pre-rendered pages, or the
        // single supplied document.
        const media =
          pages && pages.length > 0
            ? pages.map((p) => ({ mimeType: p.mimeType, dataBase64: p.data }))
            : [{ mimeType: mimeType as string, dataBase64: base64Content as string }];

        try {
          const result = await aiComplete<ParsedStatementData>({
            task: "statement_ocr",
            input: undefined,
            ctx: { orgId },
            media,
          });
          if (!result.ok) {
            throw new StatementParseInvalidError(result.issues);
          }
          const parsed: ParsedStatementData = result.data;
          return parsed;
        } catch (err) {
          if (err instanceof GeminiRateLimitError) {
            throw new Error(err.message);
          }
          throw err;
        }
      },
    ) as any;
  });
