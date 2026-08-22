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
 *
 * SUMS AS SCALED INTEGERS, NOT FLOATS. This previously accumulated with
 * `Number.parseFloat` and then rounded both sides to 2dp BEFORE comparing,
 * against a ledger stored at `decimal(20, 8)`. Two consequences:
 *
 *   - float addition drifts, so a long enough line set could disagree with
 *     the database over amounts that are individually exact;
 *   - anything finer than a centavo was rounded away before the comparison, so
 *     a journal out of balance by 0.00000001 passed validation and was posted.
 *
 * The database now rejects that outright (0038), which would have turned a
 * silent corruption into an unexplained constraint violation at COMMIT. This
 * computes at the same scale the ledger stores, so the application refuses it
 * first, with a message that names the amounts.
 *
 * `totalDebits` / `totalCredits` stay `number` for existing display callers.
 * `totalDebitsExact` / `totalCreditsExact` are the full-precision strings, and
 * are what should be written to `journal_headers.total_amount` — `.toFixed(2)`
 * on the float truncates a legitimately sub-centavo total.
 */
export function validateBalance(lines: JournalLineInput[]): {
  valid: boolean;
  totalDebits: number;
  totalCredits: number;
  difference: number;
  totalDebitsExact: string;
  totalCreditsExact: string;
  differenceExact: string;
} {
  let debits = 0n;
  let credits = 0n;

  for (const line of lines) {
    if (line.debit) debits += scaleToBigInt(line.debit);
    if (line.credit) credits += scaleToBigInt(line.credit);
  }

  const difference = debits - credits;

  return {
    // Exact comparison at the stored scale — no rounding before the test.
    valid: difference === 0n,
    totalDebits: Number(bigIntToDecimalString(debits)),
    totalCredits: Number(bigIntToDecimalString(credits)),
    difference: Number(bigIntToDecimalString(difference)),
    totalDebitsExact: bigIntToDecimalString(debits),
    totalCreditsExact: bigIntToDecimalString(credits),
    differenceExact: bigIntToDecimalString(difference),
  };
}

/** Scale used by `decimal(20, 8)` ledger columns. */
const LEDGER_SCALE = 8;

/** `"12.34"` -> `1234000000n`. Rejects anything that is not a plain decimal. */
function scaleToBigInt(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid money amount: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  if (fraction.length > LEDGER_SCALE) {
    throw new Error(
      `Money amount ${JSON.stringify(value)} has more than ${LEDGER_SCALE} decimal places.`,
    );
  }
  const scaled = BigInt(`${whole}${fraction.padEnd(LEDGER_SCALE, "0")}`);
  return negative ? -scaled : scaled;
}

function bigIntToDecimalString(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(LEDGER_SCALE + 1, "0");
  const whole = digits.slice(0, -LEDGER_SCALE);
  const fraction = digits.slice(-LEDGER_SCALE).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
