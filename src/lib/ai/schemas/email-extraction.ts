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
});

export type EmailExtractionOutput = z.infer<typeof emailExtractionOutputSchema>;
