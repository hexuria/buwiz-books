// Zod output schema for the inbox email-attachment extraction task.
// Single source of truth — src/lib/inbox/email-attachment-extraction.ts
// imports this schema (it previously defined it locally).
import { z } from "zod";

export const emailExtractionOutputSchema = z.object({
  economicEventClass: z
    .enum([
      "purchase",
      "sale",
      "bill_accrual",
      "bill_payment",
      "invoice_accrual",
      "invoice_payment",
      "transfer",
      "payroll",
      "other",
    ])
    .describe("The accounting event represented by the document itself."),
  direction: z
    .enum(["inflow", "outflow", "neutral", "unknown"])
    .describe("Cash or economic direction from the recipient organization's perspective."),
  amount: z
    .string()
    .describe("Absolute total decimal amount without symbols or grouping separators."),
  currency: z.string().describe("Three-letter ISO currency code, or an empty string when unknown."),
  date: z
    .string()
    .describe("Document/effective date as YYYY-MM-DD, or an empty string when unknown."),
  party: z
    .string()
    .describe("Merchant, vendor, or customer name, or an empty string when unknown."),
  reference: z
    .string()
    .describe("Invoice, receipt, or transaction reference, or an empty string when absent."),
  description: z
    .string()
    .describe("Short factual description of the purchase, sale, bill, or payment."),
  // Counterparty identity and payment details (prompt 1.1.0). Optional on
  // purpose: extractions cached before they existed stay reusable, and each
  // one only ever feeds a read — exact party matching (TIN, email) and the
  // payment-details-change check. Nothing writes them to a party.
  partyEmail: z
    .string()
    .catch("")
    .describe("The counterparty's email address exactly as printed, or an empty string."),
  partyTaxId: z
    .string()
    .catch("")
    .describe(
      "The counterparty's tax identification number (TIN, VAT, EIN, ABN) exactly as printed, or an empty string.",
    ),
  payeeBankAccountNumber: z
    .string()
    .catch("")
    .describe(
      "Only when the document asks the organization to pay the counterparty by bank transfer: the destination bank account number or IBAN exactly as printed. Otherwise an empty string.",
    ),
  payeeBankRoutingNumber: z
    .string()
    .catch("")
    .describe(
      "The routing, sort, BSB, or SWIFT/BIC code printed with that destination account, or an empty string.",
    ),
});

export type EmailExtractionOutput = z.infer<typeof emailExtractionOutputSchema>;
