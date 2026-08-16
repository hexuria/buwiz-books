// Zod output schema for the bank/credit-card statement OCR task.
// Mirrors the Gemini responseSchema in src/routes/api/-ai-statement-ocr.ts.
// Transaction rows are strict (they become statement_lines ledger data):
// dates must be YYYY-MM-DD and amounts finite. NOTE: classification.confidence
// stays on the 0–100 wire scale its consumers already read.
import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const finiteNumber = z.number().refine(Number.isFinite, "Expected a finite number");

export const statementClassificationSchema = z.object({
  isStatement: z.boolean().describe("True if this is a bank statement or credit card statement"),
  documentType: z
    .string()
    .describe(
      "Document type: 'bank_statement', 'credit_card_statement', 'invoice', 'receipt', or 'other'",
    ),
  confidence: z.number().describe("Confidence in classification (0-100)"),
  rejectionReason: z
    .string()
    .describe("If not a statement, explain why (e.g. 'This appears to be an invoice')")
    .optional(),
});

export const statementMetadataSchema = z.object({
  institutionName: z
    .string()
    .describe(
      "Name of the financial institution (e.g. 'Mercury', 'Chase Bank', 'American Express')",
    ),
  accountHolderName: z
    .string()
    .describe("Organization or person name shown on the statement as the account holder"),
  accountType: z
    .string()
    .describe("Account type: 'checking', 'savings', 'credit_card', 'money_market', or 'other'"),
  accountNumberLast4: z
    .string()
    .describe(
      "Last 4 digits of the account number. If only masked digits shown (e.g. ****1234), extract '1234'",
    ),
  statementPeriodStart: ymd.describe("Start of statement period in YYYY-MM-DD format"),
  statementPeriodEnd: ymd.describe("End of statement period in YYYY-MM-DD format"),
  beginningBalance: finiteNumber.describe(
    "Opening/beginning balance. For credit cards, this is the previous balance. Always positive.",
  ),
  endingBalance: finiteNumber.describe(
    "Closing/ending balance. For credit cards, this is the new balance.",
  ),
  totalDeposits: finiteNumber
    .describe("Total deposits/credits for the period (if shown)")
    .optional(),
  totalWithdrawals: finiteNumber
    .describe(
      "Total withdrawals/debits/payments for the period (if shown). Return as positive number.",
    )
    .optional(),
  currency: z
    .string()
    .describe("ISO 4217 currency code (e.g. 'USD', 'EUR', 'GBP'). Default to 'USD'."),
});

export const statementLineOutputSchema = z.object({
  date: ymd.describe("Transaction date in YYYY-MM-DD format"),
  description: z
    .string()
    .describe(
      "Transaction description/memo as shown on statement. Include check numbers, reference numbers, etc.",
    ),
  amount: finiteNumber.describe(
    "Transaction amount. POSITIVE for deposits/credits, NEGATIVE for withdrawals/debits/payments.",
  ),
  runningBalance: finiteNumber
    .describe("Running balance after this transaction (if shown on statement)")
    .optional(),
  checkNumber: z.string().describe("Check number if this is a check transaction").optional(),
  referenceNumber: z.string().describe("Reference/confirmation number if shown").optional(),
});

export const statementOcrOutputSchema = z.object({
  classification: statementClassificationSchema.describe(
    "Classify whether this document is a bank/credit card statement",
  ),
  metadata: statementMetadataSchema.describe(
    "Statement header metadata — institution, account, period, balances",
  ),
  transactions: z
    .array(statementLineOutputSchema)
    .describe("Individual transaction lines from the statement, in order of appearance"),
  totalPages: z.number().describe("Total number of pages in the document"),
});

export type StatementOcrOutput = z.infer<typeof statementOcrOutputSchema>;
