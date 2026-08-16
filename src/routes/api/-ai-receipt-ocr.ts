// ============================================================================
// AI Receipt OCR — Server Function (Gemini 3 Flash)
// Parses receipt / invoice / bill images/PDFs and returns
// ParsedTransactionResult so it plugs directly into handleAIApply.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { GeminiRateLimitError } from "../../lib/gemini-client";
import { aiComplete } from "../../lib/ai/facade";
import type { ParsedTransactionResult } from "./-ai-transaction-parse";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { assertRolePermission } from "../../lib/auth-middleware";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface ReceiptOCRInput {
  /** Base64-encoded file content */
  base64Content: string;
  /** MIME type (image/png, image/jpeg, application/pdf, etc.) */
  mimeType: string;
  /** Current date for resolving relative dates */
  currentDate: string;
  /** Chart of accounts for category matching */
  accounts: { id: string; name: string; accountNumber?: string | null; accountType: string }[];
  /** Known parties for matching vendor / customer */
  parties: { id: string; name: string }[];
  /** Departments for dimensional tagging */
  departments: { id: string; name: string }[];
  /** Locations for dimensional tagging */
  locations: { id: string; name: string }[];
  /** Pre-extracted OCR bounding box fields (from prior vision pass) — used as context hints */
  preExtractedFields?: { fieldId: string; label: string; text: string }[];
}

const receiptContextAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountNumber: z.string().nullable().optional(),
  accountType: z.string().min(1),
});

const receiptContextEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const preExtractedFieldSchema = z.object({
  fieldId: z.string().min(1),
  label: z.string().min(1),
  text: z.string().min(1),
});

const receiptOCRInputSchema = z.object({
  base64Content: z.string().min(1),
  mimeType: z.string().min(1),
  currentDate: z.string().min(1),
  accounts: z.array(receiptContextAccountSchema).default([]),
  parties: z.array(receiptContextEntitySchema).default([]),
  departments: z.array(receiptContextEntitySchema).default([]),
  locations: z.array(receiptContextEntitySchema).default([]),
  preExtractedFields: z.array(preExtractedFieldSchema).optional(),
});

// ============================================================================
// Server Function
// ============================================================================

/**
 * Parse a receipt, invoice, or bill image/PDF and return a
 * ParsedTransactionResult that can be applied directly to the
 * transaction form via handleAIApply.
 */
export const parseReceiptDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof receiptOCRInputSchema>) =>
    receiptOCRInputSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:receipt-ocr", limit: 20, windowMs: 300_000 },
      async ({ orgId, role }) => {
        // Two-key model: parsing reads a document the caller supplied.
        assertRolePermission(role, "document", "view");
        const input = receiptOCRInputSchema.parse(rawData);

        if (!input.base64Content || !input.mimeType) {
          throw new Error("base64Content and mimeType are required");
        }

        try {
          const result = await aiComplete<ParsedTransactionResult>({
            task: "receipt_ocr",
            input: {
              currentDate: input.currentDate,
              accounts: input.accounts,
              parties: input.parties,
              departments: input.departments,
              locations: input.locations,
              preExtractedFields: input.preExtractedFields,
            },
            ctx: { orgId },
            media: [{ mimeType: input.mimeType, dataBase64: input.base64Content }],
          });
          if (!result.ok) {
            // Additive failure shape: the client checks needsReview and shows a
            // warning banner instead of applying garbage to the form.
            return {
              needsReview: true as const,
              validationIssues: result.issues,
              parsed: null,
            };
          }
          const parsed: ParsedTransactionResult = result.data;
          return { ...parsed, needsReview: false as const, validationIssues: [] as string[] };
        } catch (err) {
          if (err instanceof GeminiRateLimitError) {
            throw new Error(err.message);
          }
          throw err;
        }
      },
    ) as any;
  });
