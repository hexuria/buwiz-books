// Zod output schema for BIR Form 2307 OCR — Stage 3a.
//
// A received 2307 is the ONLY evidence supporting the creditable withholding
// tax we claim; without it the BIR disallows the credit regardless of what the
// ledger says. So the extraction feeds a human review gate, never a direct
// post.
//
// WHY EVERY MONEY FIELD IS A STRING. These figures become ledger amounts at
// decimal(20,8). A number here would arrive as a JS float and lose precision
// before it ever reached the money layer, which is the one place in the system
// that must not happen.
//
// WHY SECONDARY FIELDS USE .catch RATHER THAN FAILING. A certificate whose
// address block did not parse is still reviewable and still claimable; a hard
// failure would discard a usable extraction over a field nobody files. The
// fields that DECIDE the credit — TIN, ATC, and the two amounts — do not get
// that treatment, because a silently-defaulted zero there is a wrong claim
// rather than a missing detail. (.catch keeps the field required in the
// generated Gemini schema, so the model still has to emit it; only app-side
// parsing degrades.)
import { z } from "zod";

/** One income-payment row. A 2307 can carry several ATCs in one quarter. */
export const form2307LineOutputSchema = z.object({
  atc: z
    .string()
    .describe(
      'Alphanumeric Tax Code exactly as printed, e.g. "WC010", "WI158". Uppercase, no spaces. This decides both the rate and the SAWT column — do not guess it from the amounts.',
    ),
  incomePaymentDescription: z
    .string()
    .catch("")
    .describe(
      'Nature of the income payment as printed, e.g. "Professional fees". Empty if absent.',
    ),
  monthlyAmounts: z
    .array(z.string())
    .catch([])
    .describe(
      "The three monthly amounts of the quarter as printed, each a plain decimal string. Empty array if the form shows only a total.",
    ),
  totalIncomePayment: z
    .string()
    .describe(
      'Total income payment for this ATC, as a plain decimal string with no currency symbol, thousands separator or parentheses. Example: "100000.00". If unreadable, return an empty string rather than a guess.',
    ),
  taxWithheld: z
    .string()
    .describe(
      'Tax withheld for this ATC, as a plain decimal string. Example: "10000.00". Must not exceed the income payment. If unreadable, return an empty string rather than a guess.',
    ),
});

export const form2307OcrOutputSchema = z.object({
  // ── The payor: who withheld FROM us ──────────────────────────────────────
  payorTin: z
    .string()
    .describe(
      'Payor TIN exactly as printed, digits and dashes only, e.g. "123-456-789-000". This is the party that withheld the tax and issued the certificate. A wrong TIN puts the credit against the wrong taxpayer.',
    ),
  payorRegisteredName: z
    .string()
    .describe("Payor's registered name as printed. This is reported verbatim on the SAWT."),
  payorAddress: z.string().catch("").describe("Payor's registered address. Empty if not legible."),

  // ── The payee: us ────────────────────────────────────────────────────────
  payeeTin: z
    .string()
    .catch("")
    .describe(
      "Payee TIN as printed — this should be OUR TIN. Extracted so a certificate addressed to someone else can be caught at review.",
    ),
  payeeRegisteredName: z.string().catch("").describe("Payee's registered name as printed."),

  // ── Certificate identity ─────────────────────────────────────────────────
  certificateNumber: z
    .string()
    .catch("")
    .describe(
      "Certificate number as printed. Empty string if the form has none — that is legitimate and must not be invented, though duplicate detection cannot run without it.",
    ),
  periodFrom: z
    .string()
    .describe("Start of the covered period, YYYY-MM-DD. Empty string if unreadable."),
  periodTo: z
    .string()
    .describe("End of the covered period, YYYY-MM-DD. Empty string if unreadable."),

  lines: z
    .array(form2307LineOutputSchema)
    .describe(
      "One entry per ATC row on the certificate. A 2307 can carry several ATCs for one quarter, and merging them loses the SAWT grouping.",
    ),

  totalTaxWithheld: z
    .string()
    .describe(
      "Grand total of tax withheld as printed on the form, as a plain decimal string. Extracted separately from the line sum so the two can be reconciled at review — a mismatch means a row was missed.",
    ),

  confidence: z
    .number()
    .catch(0)
    .describe(
      "0-1 confidence in the extraction as a whole. Low confidence routes to closer review rather than rejection.",
    ),
  legibilityNotes: z
    .string()
    .catch("")
    .describe(
      "Anything that impaired reading the document — a fold across the amounts, a faint stamp, a cropped edge. Reviewers use this to decide whether to trust the figures.",
    ),
});

export type Form2307OcrOutput = z.infer<typeof form2307OcrOutputSchema>;
