// Zod output schema for the natural-language transaction parse task.
// Mirrors the Gemini responseSchema in src/routes/api/-ai-transaction-parse.ts:
// fields in that schema's `required` list are required here; fields the model
// may omit default to "" so the parsed object keeps the exact
// ParsedTransactionResult shape the form-fill client expects.
// Field descriptions are ported verbatim from that responseSchema — they are
// part of the prompt and materially guide the model.
import { z } from "zod";

/** YYYY-MM-DD, or empty string when the model could not determine a date. */
export const ymdOrEmpty = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .or(z.literal(""));

export const transactionLineOutputSchema = z.object({
  description: z.string().describe("Line item description"),
  categoryId: z
    .string()
    .describe("Matched account ID from the provided accounts list. Empty string if no match."),
  categoryName: z
    .string()
    .describe("The account name that was matched, or the inferred category name"),
  amount: z
    .string()
    .describe("Amount as a decimal string (e.g. '500.00'). For pay_in/pay_out lines."),
  debit: z
    .string()
    .describe(
      "Debit amount as decimal string. For journal entry lines only. Empty string if not applicable.",
    ),
  credit: z
    .string()
    .describe(
      "Credit amount as decimal string. For journal entry lines only. Empty string if not applicable.",
    ),
  departmentId: z
    .string()
    .default("")
    .describe("Matched department ID. Empty string if not mentioned."),
  departmentName: z.string().default("").describe("Department name if mentioned."),
  locationId: z
    .string()
    .default("")
    .describe("Matched location ID. Empty string if not mentioned."),
  locationName: z.string().default("").describe("Location name if mentioned."),
});

export const transactionParseOutputSchema = z.object({
  transactionType: z
    .enum(["journal", "pay_in", "pay_out", "transfer"])
    .describe(
      'Transaction type: "journal", "pay_in", "pay_out", or "transfer". Infer from context: paid/bought/expense → pay_out, received/earned/income → pay_in, move/transfer between accounts → transfer, adjusting/depreciation/accrual → journal.',
    ),
  date: ymdOrEmpty.describe(
    "Transaction date in YYYY-MM-DD format. Resolve relative dates (yesterday, last Friday, etc.) using the currentDate provided in the prompt context.",
  ),
  memo: z
    .string()
    .describe(
      "Transaction memo or description extracted from the prompt. Summarize the purpose of the transaction.",
    ),
  partyId: z
    .string()
    .describe(
      "ID of the matched party from the provided parties list. Empty string if no party mentioned or no match found.",
    ),
  partyName: z
    .string()
    .describe(
      "Name of the party mentioned in the prompt (even if no ID match). Empty string if none.",
    ),
  referenceNumber: z
    .string()
    .describe(
      "Reference number if mentioned (e.g. invoice number, check number). Empty string if none.",
    ),
  categoryId: z
    .string()
    .describe(
      "For pay_in/pay_out: the header-level category account ID (the cash/bank account). Empty string if not determinable.",
    ),
  categoryName: z.string().describe("The header-level category name."),
  departmentId: z
    .string()
    .default("")
    .describe("Matched department ID from the provided list. Empty string if not mentioned."),
  departmentName: z.string().default("").describe("Department name if mentioned."),
  locationId: z
    .string()
    .default("")
    .describe("Matched location ID from the provided list. Empty string if not mentioned."),
  locationName: z.string().default("").describe("Location name if mentioned."),
  transferFromCategoryId: z
    .string()
    .default("")
    .describe(
      'For transfer type: the "from" account ID. Empty string if not transfer or not determinable.',
    ),
  transferFromCategoryName: z
    .string()
    .default("")
    .describe('For transfer type: the "from" account name.'),
  transferToCategoryId: z
    .string()
    .default("")
    .describe(
      'For transfer type: the "to" account ID. Empty string if not transfer or not determinable.',
    ),
  transferToCategoryName: z
    .string()
    .default("")
    .describe('For transfer type: the "to" account name.'),
  amount: z
    .string()
    .describe(
      "Total transaction amount as decimal string (e.g. '500.00'). For transfers, this is the transfer amount.",
    ),
  lines: z
    .array(transactionLineOutputSchema)
    .describe(
      "Transaction line items. For pay_in/pay_out: expense/revenue lines. For journal: debit/credit lines. For transfer: usually empty (amount is on the header).",
    ),
  confidence: z
    .number()
    .describe("Confidence score from 0.0 to 1.0 on how well the prompt was understood."),
  interpretation: z
    .string()
    .describe(
      "Brief human-readable summary of what was understood from the prompt, e.g. 'Pay Out $500 for office supplies'",
    ),
});

export type TransactionParseOutput = z.infer<typeof transactionParseOutputSchema>;
