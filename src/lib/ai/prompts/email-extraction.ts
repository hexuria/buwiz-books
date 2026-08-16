// ============================================================================
// Prompt: email_extraction — deterministic matching facts from an inbox
// attachment. Moved VERBATIM from src/lib/inbox/email-attachment-extraction.ts
// (version 1.0.0 is byte-identical to the pre-registry prompt). The document
// arrives as inline media parts.
// ============================================================================

export interface EmailExtractionPromptInput {
  filename: string;
  documentType: string;
  fallbackDate?: string | null;
  fallbackCurrency?: string | null;
}

export const emailExtractionPrompt = {
  id: "email-extraction",
  version: "1.0.0",
  build(input: EmailExtractionPromptInput): string {
    return `You extract only deterministic matching facts from an accounting document.

Analyze the attached document bytes. Do not choose ledger accounts, approve, post, merge, or select a canonical transaction.

Document hints:
- Filename: ${input.filename}
- Detected document type: ${input.documentType}
- Email received date fallback: ${input.fallbackDate ?? "unknown"}
- Organization currency fallback: ${input.fallbackCurrency ?? "unknown"}

Rules:
- Identify the economic event represented by this document, not a later bank settlement.
- A receipt is normally purchase/outflow.
- A vendor bill or invoice addressed to the organization is bill_accrual/outflow.
- A sales invoice issued by the organization is invoice_accrual/inflow.
- A payment confirmation is bill_payment/outflow or invoice_payment/inflow as applicable.
- A payslip is payroll/outflow.
- A transfer is neutral, and must not be labeled purchase or sale.
- Use the grand total as an absolute decimal string without currency symbols.
- Use the document date. Return YYYY-MM-DD.
- Use a three-letter ISO currency. If the symbol is ambiguous, use the supplied currency fallback.
- Return an empty string for an unknown amount, currency, date, party, or reference.
- Description must be short and factual.`;
  },
};
