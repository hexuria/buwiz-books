// Zod output schema for the upload-time ingest triage task — one cheap
// classification per uploaded document, cached on documents.metadata.triage.
// (CSV routing is deterministic by mime/extension and never reaches a model.)
import { z } from "zod";

export const ingestTriageOutputSchema = z.object({
  docKind: z
    .enum(["receipt", "invoice", "bill", "statement", "payslip", "contract", "tax_form", "other"])
    .describe(
      "Document kind: receipt (purchase/POS), invoice (sales/receivable), bill (payable), statement (bank/credit card), payslip (payroll), contract (legal agreement), tax_form (W-9, 1099, etc), other.",
    ),
  confidence: z.number().describe("Confidence score from 0.0 to 1.0"),
  reasoning: z.string().describe("One short sentence explaining the classification").optional(),
});

export type IngestTriageOutput = z.infer<typeof ingestTriageOutputSchema>;
