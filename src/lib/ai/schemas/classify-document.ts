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
  // Pinned to the unit scale (like ingest_triage) so readers may pass
  // normalizeConfidence's `scaleHint: "unit"`: a bare 1 means certain, not 1%.
  confidence: z.number().describe("Confidence score from 0.0 to 1.0"),
  reasoning: z.string().optional(),
});

export type ClassifyDocumentOutput = z.infer<typeof classifyDocumentOutputSchema>;
