// ============================================================================
// Prompt: form_2307_ocr — BIR Form 2307 extraction (Stage 3a).
//
// The certificate is the only evidence supporting a creditable withholding tax
// claim, so the extraction feeds a human review gate and never posts directly.
// The prompt is written around that: it is told to leave a field EMPTY rather
// than guess, because a blank routes to review while a plausible invention
// passes silently into a tax credit.
// ============================================================================

export interface Form2307OcrPromptInput {
  /** Our own TIN, so a certificate addressed elsewhere is caught. */
  ourTin?: string;
  /** Known suppliers/customers, to help resolve the payor to an existing party. */
  parties?: { id: string; name: string; tin?: string | null }[];
}

export const form2307OcrPrompt = {
  id: "form-2307-ocr",
  version: "1.0.0",
  build(input: Form2307OcrPromptInput): string {
    const partiesBlock =
      input.parties && input.parties.length > 0
        ? `## Known parties
The payor may be one of these. Report the name as PRINTED regardless — matching happens later.
${input.parties.map((p) => `  ${p.name}${p.tin ? ` (TIN ${p.tin})` : ""}`).join("\n")}`
        : "";

    const ourTinBlock = input.ourTin
      ? `## Our TIN
${input.ourTin}
The PAYEE on this certificate should be us. If the payee TIN differs, still extract what is printed — a certificate addressed to someone else must be caught at review, not silently corrected.`
      : "";

    return `You are extracting data from a Philippine BIR Form 2307 — "Certificate of Creditable Tax Withheld at Source".

This certificate is the ONLY evidence that supports a tax credit. An invented figure becomes a wrong claim against the Bureau of Internal Revenue. Accuracy matters far more than completeness.

## The single most important rule
If a value is not clearly legible, return an EMPTY STRING for it. Do not infer, do not compute, do not fill from context. An empty field routes the document to closer human review; a plausible-looking guess passes review and becomes a false claim.

Specifically:
- Do NOT derive the tax withheld by multiplying the income payment by a rate you believe applies.
- Do NOT derive the income payment by dividing the tax withheld by a rate.
- Do NOT infer the ATC from the amounts or from the nature of the payment.
- Do NOT invent a certificate number when the form shows none. Many legitimately have none.

## What to extract

**Payor** — the party that WITHHELD the tax and issued this certificate. Their TIN and registered name. A wrong TIN puts the credit against the wrong taxpayer.

**Payee** — the party the tax was withheld FROM. Extract as printed.

**Period covered** — as YYYY-MM-DD. A 2307 normally covers a calendar quarter.

**One entry per ATC row.** A single 2307 can list several Alphanumeric Tax Codes. Return each as its own entry — merging them destroys the grouping the SAWT requires. Copy the ATC exactly as printed (uppercase, no spaces): "WC010", "WI158", "WC160".

**Amounts** as plain decimal strings: no currency symbol, no thousands separators, no parentheses. "100000.00", not "₱100,000.00". These become ledger figures and any formatting corrupts them.

**Grand total of tax withheld** as printed on the form. Extract it separately from the individual rows even though it should equal their sum — the two get reconciled at review, and a mismatch is how a missed row is caught.

## Sanity conditions to respect, not to enforce
Tax withheld should never exceed the income payment it was taken from. If the document appears to show otherwise, extract what is printed and say so in legibilityNotes. Do not swap the fields to make them sensible — a transposed certificate is a real finding.

## Legibility
Use legibilityNotes for anything that impaired reading: a fold across the amount column, a faint dot-matrix print, a stamp over the TIN, a cropped edge. Reviewers use it to decide how much to trust the figures.

${ourTinBlock}

${partiesBlock}`.trim();
  },
};
