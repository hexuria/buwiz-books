/**
 * Reconciliation API — Barrel Re-export
 *
 * This file re-exports all reconciliation server functions and types from
 * modular internal files. External consumers continue to import from
 * `./api/-reconciliations` — no import path changes required.
 *
 * Internal modules (prefixed with `-` to exclude from TanStack route tree):
 *   reconciliations/-_shared.ts          — Logger, schemas, types, helpers
 *   reconciliations/-_list-detail.ts     — Read functions (list, detail, timeline, etc.)
 *   reconciliations/-_mutations.ts       — Write functions (create, match, finalize, etc.)
 *   reconciliations/-_statement-upload.ts — Statement upload, OCR, PDF generation
 *   reconciliations/-_suggestions.ts     — Suggestion CRUD
 *   reconciliations/-_matching.ts        — Re-run matching
 *   reconciliations/-_agent.ts           — AI agent orchestrator
 */

// ── Types & Shared ───────────────────────────────────────────────────────────
export type {
  ReconciliationListItem,
  ReconciliationDetail,
  StatementLineItem,
  FlagItem,
  LedgerTransaction,
  ReconciliationSummary,
  TimelineEntry,
} from "./reconciliations/-_shared";

export {
  formatCurrency,
  listReconciliationsSchema,
  getReconciliationSchema,
  createReconciliationSchema,
  matchTransactionSchema,
  finalizeReconciliationSchema,
  getTimelineSchema,
  reconfigureReconciliationSchema,
  reopenReconciliationSchema,
  deleteReconciliationSchema,
  generateReconciliationStatementSchema,
} from "./reconciliations/-_shared";

// ── Reads ────────────────────────────────────────────────────────────────────
export {
  listReconciliations,
  getReconciliation,
  getReconciliationTimeline,
  getBankAccounts,
  getReconciliationActivityLog,
  getReconciliationReportData,
} from "./reconciliations/-_list-detail";

// ── Mutations ────────────────────────────────────────────────────────────────
export {
  reconfigureReconciliation,
  createReconciliation,
  matchTransaction,
  finalizeReconciliation,
  reopenReconciliation,
  deleteReconciliation,
  resolveReconciliationFlag,
} from "./reconciliations/-_mutations";

// ── Statement Upload & Processing ────────────────────────────────────────────
export {
  uploadBankStatement,
  runStatementOcr,
  getStatementPipelineStatus,
  resumeStatementPipeline,
  attachExistingDocument,
  removeStatementDocument,
  generateBankStatementPdf,
  generateReconciliationStatement,
  removeReconciliationStatement,
} from "./reconciliations/-_statement-upload";
export type { StatementPipelineStatus } from "./reconciliations/-_statement-upload";

// ── Suggestions ──────────────────────────────────────────────────────────────
export {
  listReconciliationSuggestions,
  applySuggestion,
  dismissSuggestion,
} from "./reconciliations/-_suggestions";

// ── Matching ─────────────────────────────────────────────────────────────────
export { reRunMatching } from "./reconciliations/-_matching";

// ── AI Agent ─────────────────────────────────────────────────────────────────
export { runAgentOnReconciliation } from "./reconciliations/-_agent";
