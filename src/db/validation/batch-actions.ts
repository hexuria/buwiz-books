import { z } from "zod";

export const updateTransactionsBatchSchema = z.object({
  ids: z.array(z.string().uuid()),
  updates: z.object({
    partyId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(), // Move To / Category
    departmentId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    memo: z.string().optional(),
  }),
  /** The accountId of the journal line being edited (identifies which line in grouped view) */
  lineAccountId: z.string().uuid().optional(),
  /** Transaction type — determines field propagation rules (see docs/LEDGER-TYPES-INTERACTION.md) */
  transactionType: z.enum(["pay_in", "pay_out", "transfer", "journal"]).optional(),
});

export const deleteTransactionsBatchSchema = z.object({
  ids: z.array(z.string().uuid()),
});
