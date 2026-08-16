// ============================================================================
// Prompt: ingest_triage — cheap upload-time document-kind classification.
// Consolidates the previous filename-only classify pass with richer signals
// (mime type + first-KB text preview when available). Version 1.0.0.
// ============================================================================

export interface IngestTriagePromptInput {
  filename: string;
  mimeType: string;
  /** First ~1KB of extracted text, when the file is text-extractable. */
  textPreview?: string;
}

export const ingestTriagePrompt = {
  id: "ingest-triage",
  version: "1.0.0",
  build(input: IngestTriagePromptInput): string {
    const preview = input.textPreview
      ? `\nContent preview (first bytes):\n${input.textPreview.substring(0, 1000)}`
      : "";

    return `You are an expert accountant. Classify the uploaded document into one of these kinds:
- statement (Bank Statement or Credit Card Statement)
- bill (Vendor Bill / Invoice to pay)
- invoice (Sales Invoice / Receivable)
- receipt (Expense Receipt)
- payslip (Payroll Slip)
- contract (Legal Agreement)
- tax_form (W-9, 1099, etc)
- other (Unclassified)

Return JSON.

Document Info:
Filename: ${input.filename}
MIME type: ${input.mimeType}${preview}`;
  },
};
