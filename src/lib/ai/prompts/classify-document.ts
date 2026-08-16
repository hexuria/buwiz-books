// ============================================================================
// Prompt: classify_document — filename/content preview → document type.
// Moved VERBATIM from src/routes/api/-ai-classify-document.ts (version 1.0.0
// is byte-identical to the pre-registry prompt).
// ============================================================================

export interface ClassifyDocumentPromptInput {
  filename: string;
  contentPreview?: string;
}

export const classifyDocumentPrompt = {
  id: "classify-document",
  version: "1.0.0",
  build(input: ClassifyDocumentPromptInput): string {
    let inputForAi = `Filename: ${input.filename}\n`;
    if (input.contentPreview) {
      inputForAi += `Content Preview: ${input.contentPreview.substring(0, 5000)}`;
    }

    return `
    You are an expert accountant. Classify the following document into one of these types:
    - statement (Bank Statement)
    - bill (Vendor Bill / Invoice to pay)
    - invoice (Sales Invoice / Receivable)
    - receipt (Expense Receipt)
    - payslip (Payroll Slip)
    - contract (Legal Agreement)
    - tax_form (W-9, 1099, etc)
    - other (Unclassified)

    Return JSON.

    Document Info:
    ${inputForAi}
  `;
  },
};
