/**
 * Transactions API — Barrel Re-export
 *
 * This file re-exports all transaction server functions and types from
 * modular internal files. External consumers continue to import from
 * `./api/-transactions` — no import path changes required.
 *
 * Internal modules (prefixed with `-` to exclude from TanStack route tree):
 *   transactions/-_shared.ts        — Schemas, types, helpers
 *   transactions/-_queries.ts       — Read functions (list, detail, grouped, etc.)
 *   transactions/-_mutations.ts     — Write functions (create, update, void, post)
 *   transactions/-_batch.ts         — Batch operations (update/delete)
 *   transactions/-_period-close.ts  — Period close get/set
 *   transactions/-_activity.ts      — Activity log listing
 */

// ── Types & Shared ───────────────────────────────────────────────────────────
export type {
  TransactionListItem,
  TransactionDetail,
  LineWithNames,
} from "./transactions/-_shared";

export {
  listTransactionsSchema,
  groupedTransactionsSchema,
  loadMoreSchema,
  accountBalancesSchema,
  getTransactionSchema,
  voidTransactionSchema,
  setClosedThroughSchema,
  fetchLinesWithNames,
  resolvePartyName,
  lineSnapshot,
  buildLineDiffs,
} from "./transactions/-_shared";

// ── Reads ────────────────────────────────────────────────────────────────────
export {
  listTransactions,
  getTransaction,
  listAccountBalances,
  listTransactionsGrouped,
  loadMoreTransactions,
  getSimilarTransactions,
} from "./transactions/-_queries";

// ── Mutations ────────────────────────────────────────────────────────────────
export {
  createTransaction,
  updateTransaction,
  voidTransaction,
  postTransaction,
} from "./transactions/-_mutations";

// ── Batch Operations ─────────────────────────────────────────────────────────
export { updateTransactionsBatch, deleteTransactionsBatch } from "./transactions/-_batch";

// ── Period Close ─────────────────────────────────────────────────────────────
export { getClosedThroughServerFn, setClosedThrough } from "./transactions/-_period-close";

// ── Activity ─────────────────────────────────────────────────────────────────
export { listActivityLogs } from "./transactions/-_activity";
