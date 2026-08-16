// Zod output schema for the document classification task.
// Mirrors the Gemini responseSchema in src/routes/api/-ai-classify-document.ts.
import { z } from "zod";

export const classifyDocumentOutputSchema = z.object({
  documentType: z.enum([
    "statement",
    "bill",
    "invoice",
    "receipt",
    "payslip",
    "contract",
    "tax_form",
    "other",
  ]),
  confidence: z.number(),
  reasoning: z.string().optional(),
});

export type ClassifyDocumentOutput = z.infer<typeof classifyDocumentOutputSchema>;
