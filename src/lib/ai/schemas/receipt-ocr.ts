// Zod output schema for the receipt/invoice/payslip OCR task.
// Mirrors the Gemini responseSchema in src/routes/api/-ai-receipt-ocr.ts —
// the transaction-parse shape plus entity extraction and subtype
// classification. Secondary fields (entities, subtype) parse tolerantly via
// .catch rather than fail: a receipt parse with a missing entity list is
// still reviewable, and the human Apply gate is the backstop. (.catch keeps
// the field in the generated Gemini schema's `required` list — the model must
// emit it — while app-side parsing degrades gracefully.)
// Field descriptions are ported verbatim from that responseSchema; where the
// receipt document context calls for different guidance than the
// natural-language parse task, the base fields are re-declared below with the
// receipt-specific text.
import { z } from "zod";
import {
  transactionLineOutputSchema,
  transactionParseOutputSchema,
  ymdOrEmpty,
} from "./transaction-parse";

export const extractedEntityOutputSchema = z.object({
  entityType: z
    .enum(["bank", "employee", "vendor", "customer", "government", "shareholder", "lender"])
    .describe("Entity type."),
  name: z.string().describe("Entity name as found in the document."),
  identifier: z
    .string()
    .catch("")
    .describe(
      'Optional ID found in document: last-4 digits ("****4521"), employee ID ("EMP-2024-019"), tax ID, etc. Empty string if none.',
    ),
  accountType: z
    .enum(["checking", "savings", "credit_card", "other"])
    .catch("other")
    .describe(
      'For bank entities: the account type. "checking" for bank accounts, "savings" for savings, "credit_card" for credit cards. "other" for non-bank entities.',
    ),
  matchedPartyId: z
    .string()
    .catch("")
    .describe(
      "If this entity matches one of the known parties, put the party ID here. Empty string if no match.",
    ),
});

/** Receipt line items share the transaction-parse line shape; only the
 *  categoryName guidance differs in the receipt responseSchema. */
const receiptTransactionLineOutputSchema = transactionLineOutputSchema.extend({
  categoryName: z.string().describe("The account name that was matched, or inferred category name"),
});

export const receiptOcrOutputSchema = transactionParseOutputSchema.extend({
  transactionType: z
    .enum(["journal", "pay_in", "pay_out", "transfer"])
    .describe(
      'Transaction type: "pay_out" for purchases/expenses, "pay_in" for income/refunds, "journal" for adjustments, "transfer" for fund movements. Most receipts are "pay_out".',
    ),
  date: ymdOrEmpty.describe("Transaction date in YYYY-MM-DD format, extracted from the document."),
  memo: z
    .string()
    .describe(
      "Transaction memo summarizing the purchase. Include vendor name and what was bought.",
    ),
  partyId: z
    .string()
    .describe("ID of matched party from the provided parties list. Empty string if no match."),
  partyName: z
    .string()
    .describe(
      "Name of the vendor/merchant/payee shown on the document. Empty string if not visible.",
    ),
  referenceNumber: z
    .string()
    .describe(
      "Receipt number, invoice number, or transaction reference. Empty string if not visible.",
    ),
  categoryId: z
    .string()
    .describe(
      "For pay_in/pay_out: the header-level category account ID. Empty string if not determinable.",
    ),
  departmentId: z
    .string()
    .default("")
    .describe("Matched department ID. Empty string if not mentioned."),
  locationId: z
    .string()
    .default("")
    .describe("Matched location ID. Empty string if not mentioned."),
  transferFromCategoryId: z
    .string()
    .default("")
    .describe('For transfer type: the "from" account ID. Empty string otherwise.'),
  transferToCategoryId: z
    .string()
    .default("")
    .describe('For transfer type: the "to" account ID. Empty string otherwise.'),
  amount: z.string().describe("Total transaction amount as decimal string (e.g. '42.50')."),
  lines: z
    .array(receiptTransactionLineOutputSchema)
    .describe(
      "Transaction line items. For pay_in/pay_out: expense/revenue breakdown. For journal: debit/credit lines.",
    ),
  confidence: z.number().describe("Confidence score 0.0–1.0 on extraction accuracy."),
  interpretation: z
    .string()
    .describe("Brief human-readable summary, e.g. 'Pay Out $42.50 at Starbucks for coffee'"),
  extractedEntities: z
    .array(extractedEntityOutputSchema)
    .catch([])
    .describe(
      "Entities detected in the document: banks (from payment/deposit details), employees (from payslip), vendors (from invoice/receipt seller), customers, government agencies, etc.",
    ),
  documentSubtype: z
    .enum(["receipt", "invoice", "payslip", "bill", "statement", "other"])
    .catch("other")
    .describe(
      'Specific document classification: "receipt" for purchases, "invoice" for receivables, "payslip" for employee pay stubs, "bill" for payables, "statement" for bank/account statements, "other" otherwise.',
    ),
});

export type ReceiptOcrOutput = z.infer<typeof receiptOcrOutputSchema>;
