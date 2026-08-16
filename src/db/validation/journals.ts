import { z } from "zod";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { journalHeaders, journalLines } from "../schema/journals";

/**
 * Zod schemas for Journal models
 */
export const insertJournalHeaderSchema = createInsertSchema(journalHeaders);
export const selectJournalHeaderSchema = createSelectSchema(journalHeaders);
export const insertJournalLineSchema = createInsertSchema(journalLines);
export const selectJournalLineSchema = createSelectSchema(journalLines);

export type InsertJournalHeader = typeof journalHeaders.$inferInsert;
export type JournalHeader = typeof journalHeaders.$inferSelect;
export type InsertJournalLine = typeof journalLines.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;

/**
 * Transaction type constants
 */
export const TRANSACTION_TYPES = ["pay_in", "pay_out", "journal", "transfer"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const JOURNAL_STATUSES = ["draft", "posted", "voided"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

/**
 * Journal line input (for create/update forms)
 */
export const journalLineInputSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.string().optional(),
  credit: z.string().optional(),
  lineDescription: z.string().optional(),
  partyId: z.string().uuid().optional().nullable(),
  departmentId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  sortOrder: z.number().int().optional(),
});

export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

/**
 * Create transaction input schema
 */
export const createTransactionSchema = z.object({
  idempotencyKey: z.string().uuid(),
  transactionDate: z.string(), // ISO date
  transactionType: z.enum(TRANSACTION_TYPES),
  memo: z.string().optional(),
  partyId: z.string().uuid().optional(),
  referenceNumber: z.string().optional(),
  source: z
    .enum([
      "manual",
      "import",
      "document",
      "email",
      "integration",
      "invoice",
      "bill",
      "payment",
      "reconciliation",
      "system",
    ])
    .optional(),
  currency: z.string().length(3).optional(),
  functionalCurrency: z.string().length(3).optional(),
  exchangeRate: z.string().optional(),
  exchangeRateId: z.string().uuid().optional(),
  documentIds: z.array(z.string().uuid()).optional(),
  externalId: z.string().max(255).optional(),
  lines: z.array(journalLineInputSchema).min(2, "At least 2 journal lines required"),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/**
 * Update transaction input schema (draft only)
 */
export const updateTransactionSchema = z.object({
  id: z.string().uuid(),
  transactionDate: z.string().optional(),
  transactionType: z.enum(TRANSACTION_TYPES).optional(),
  memo: z.string().optional(),
  partyId: z.string().uuid().optional().nullable(),
  referenceNumber: z.string().optional().nullable(),
  lines: z.array(journalLineInputSchema).min(2).optional(),
});

export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

/**
 * Validates that total debits equal total credits in a set of journal lines.
 * Returns { valid: boolean, totalDebits: number, totalCredits: number, difference: number }
 */
export function validateBalance(lines: JournalLineInput[]): {
  valid: boolean;
  totalDebits: number;
  totalCredits: number;
  difference: number;
} {
  let totalDebits = 0;
  let totalCredits = 0;

  for (const line of lines) {
    if (line.debit) {
      totalDebits += Number.parseFloat(line.debit);
    }
    if (line.credit) {
      totalCredits += Number.parseFloat(line.credit);
    }
  }

  // Round to 2 decimal places for precision
  totalDebits = Math.round(totalDebits * 100) / 100;
  totalCredits = Math.round(totalCredits * 100) / 100;
  const difference = Math.round((totalDebits - totalCredits) * 100) / 100;

  return {
    valid: difference === 0,
    totalDebits,
    totalCredits,
    difference,
  };
}
