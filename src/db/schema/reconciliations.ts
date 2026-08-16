/**
 * Bank Reconciliation Schema
 * AI-driven matching with flags and audit trails
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  date,
  decimal,
  boolean,
  timestamp,
  pgEnum,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { financialAccounts } from "./financial-accounts";
import { journalLines } from "./journals";
import { documents } from "./documents";

// Reconciliation status
export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "not_started",
  "draft",
  "in_progress",
  "finalized",
]);

// Match status for statement lines
export const matchStatusEnum = pgEnum("match_status", [
  "unmatched",
  "matched",
  "created", // transaction was created to match
  "ignored",
]);

// Flag types
export const flagTypeEnum = pgEnum("flag_type", [
  "unmatched_statement",
  "unmatched_ledger",
  "date_mismatch",
  "amount_discrepancy",
  "duplicate",
  "overmatched",
]);

// Suggested actions for flags
export const suggestedActionEnum = pgEnum("suggested_action", [
  "create_transaction",
  "change_date",
  "split_transaction",
  "ignore",
  "manual_review",
]);

// Suggestion types for AI-generated reconciliation suggestions
export const suggestionTypeEnum = pgEnum("suggestion_type", [
  "auto_match",
  "date_fix",
  "create_txn",
  "duplicate",
  "split",
  "ignore",
]);

// Suggestion status tracking
export const suggestionStatusEnum = pgEnum("suggestion_status", [
  "pending",
  "accepted",
  "dismissed",
  "applied",
]);

// Source of statement line data
export const statementLineSourceEnum = pgEnum("statement_line_source", [
  "ocr",
  "manual",
  "generated",
]);

/**
 * Reconciliations - Master record for a reconciliation period
 */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // Link to bank account
    bankAccountId: uuid("bank_account_id")
      .references(() => financialAccounts.id)
      .notNull(),

    // Period
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    // Balances
    statementBeginningBalance: decimal("statement_beginning_balance", { precision: 15, scale: 2 }),
    statementEndingBalance: decimal("statement_ending_balance", { precision: 15, scale: 2 }),
    ledgerBalance: decimal("ledger_balance", { precision: 15, scale: 2 }),
    // Cleared/uncleared (bank-rec) snapshot written at finalize:
    // clearedBalance = statement opening + net of MATCHED activity (what the bank should show);
    // unclearedTotal = net of posted GL activity NOT cleared (outstanding checks / deposits in
    // transit — legitimate timing differences carried as audit context).
    clearedBalance: decimal("cleared_balance", { precision: 15, scale: 2 }),
    unclearedTotal: decimal("uncleared_total", { precision: 15, scale: 2 }),

    // Status
    status: reconciliationStatusEnum("status").default("not_started").notNull(),
    aiAutoFinalized: boolean("ai_auto_finalized").default(false),

    // Uploaded bank statement document
    statementDocumentId: uuid("statement_document_id").references(() => documents.id),
    statementTotalPages: integer("statement_total_pages"),

    // Finalization
    finalizedAt: timestamp("finalized_at"),
    finalizedById: uuid("finalized_by_id"), // FK to users

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgAccountPeriodUnique: uniqueIndex("reconciliations_org_account_period_unique").on(
      table.organizationId,
      table.bankAccountId,
      table.periodStart,
      table.periodEnd,
    ),
    orgStatusIndex: index("reconciliations_org_status_idx").on(table.organizationId, table.status),
  }),
);

/**
 * Statement Lines - Individual transactions from bank statements
 */
export const statementLines = pgTable(
  "statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Link to reconciliation
    reconciliationId: uuid("reconciliation_id")
      .references(() => reconciliations.id, { onDelete: "cascade" })
      .notNull(),

    // Transaction details
    transactionDate: date("transaction_date").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),

    // Match status
    matchedJournalLineId: uuid("matched_journal_line_id").references(() => journalLines.id),
    matchStatus: matchStatusEnum("match_status").default("unmatched").notNull(),
    matchConfidence: decimal("match_confidence", { precision: 5, scale: 2 }), // AI confidence 0-100

    // Sort order (as appearing on statement)
    sortOrder: integer("sort_order"),

    // OCR extraction metadata (populated when source = 'ocr')
    ocrBbox: jsonb("ocr_bbox").$type<[number, number, number, number]>(), // [ymin, xmin, ymax, xmax] 0-1000
    ocrPage: integer("ocr_page"), // which page of the statement
    ocrConfidence: decimal("ocr_confidence", { precision: 5, scale: 2 }), // AI confidence 0-100

    // Data origin tracking
    source: statementLineSourceEnum("source").default("generated").notNull(),

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    reconciliationIndex: index("statement_lines_reconciliation_idx").on(table.reconciliationId),
    matchedJournalLineUnique: uniqueIndex("statement_lines_matched_journal_line_unique")
      .on(table.matchedJournalLineId)
      .where(sql`${table.matchedJournalLineId} is not null`),
  }),
);

/**
 * Reconciliation Suggestions - AI-generated matching/resolution proposals
 */
export const reconciliationSuggestions = pgTable("reconciliation_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  // Link to reconciliation
  reconciliationId: uuid("reconciliation_id")
    .references(() => reconciliations.id, { onDelete: "cascade" })
    .notNull(),

  // Related entities (at least one should be set)
  statementLineId: uuid("statement_line_id").references(() => statementLines.id),
  journalLineId: uuid("journal_line_id").references(() => journalLines.id),

  // Suggestion details
  suggestionType: suggestionTypeEnum("suggestion_type").notNull(),
  confidence: decimal("confidence", { precision: 5, scale: 2 }), // 0-100
  description: text("description"), // Human-readable explanation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proposedChanges: jsonb("proposed_changes").$type<Record<string, { from: any; to: any }>>(),

  // Resolution tracking
  status: suggestionStatusEnum("status").default("pending").notNull(),
  appliedAt: timestamp("applied_at"),
  appliedById: text("applied_by_id"),
  resolutionSummary: text("resolution_summary"), // e.g. "Date adjusted from 2025-05-31 to 2026-05-31"

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Statement Line Matches — one-to-many clearing.
 *
 * A single statement line can settle SEVERAL ledger transactions (a batched
 * payout, a combined deposit). The 1:1 `statementLines.matchedJournalLineId`
 * column stays the representation for ordinary matches; split matches write
 * rows here instead and leave that column null.
 *
 * The unique index on journal_line_id enforces the same invariant the 1:1
 * column's unique index does: a ledger line may be cleared exactly once, by
 * exactly one statement line, across the whole org.
 */
export const statementLineMatches = pgTable(
  "statement_line_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    statementLineId: uuid("statement_line_id")
      .references(() => statementLines.id, { onDelete: "cascade" })
      .notNull(),
    journalLineId: uuid("journal_line_id")
      .references(() => journalLines.id)
      .notNull(),
    /** Portion of the statement line's amount allocated to this ledger line. */
    allocatedAmount: decimal("allocated_amount", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    statementLineIndex: index("statement_line_matches_line_idx").on(table.statementLineId),
    journalLineUnique: uniqueIndex("statement_line_matches_journal_line_unique").on(
      table.journalLineId,
    ),
    pairUnique: uniqueIndex("statement_line_matches_pair_unique").on(
      table.statementLineId,
      table.journalLineId,
    ),
  }),
);

/**
 * Reconciliation Flags - Issues detected during reconciliation
 */
export const reconciliationFlags = pgTable("reconciliation_flags", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Link to reconciliation
  reconciliationId: uuid("reconciliation_id")
    .references(() => reconciliations.id, { onDelete: "cascade" })
    .notNull(),

  // Related statement line (if applicable)
  statementLineId: uuid("statement_line_id").references(() => statementLines.id),

  // Flag details
  flagType: flagTypeEnum("flag_type").notNull(),
  suggestedAction: suggestedActionEnum("suggested_action"),
  description: text("description"),

  // Link to AI suggestion (if this flag was generated from a suggestion)
  suggestionId: uuid("suggestion_id").references(() => reconciliationSuggestions.id),

  // Resolution
  resolved: boolean("resolved").default(false).notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolvedById: uuid("resolved_by_id"), // FK to users
  resolutionNotes: text("resolution_notes"),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Relations
export const reconciliationsRelations = relations(reconciliations, ({ one, many }) => ({
  bankAccount: one(financialAccounts, {
    fields: [reconciliations.bankAccountId],
    references: [financialAccounts.id],
  }),
  statementDocument: one(documents, {
    fields: [reconciliations.statementDocumentId],
    references: [documents.id],
  }),
  statementLines: many(statementLines),
  flags: many(reconciliationFlags),
  suggestions: many(reconciliationSuggestions),
}));

export const statementLinesRelations = relations(statementLines, ({ one, many }) => ({
  reconciliation: one(reconciliations, {
    fields: [statementLines.reconciliationId],
    references: [reconciliations.id],
  }),
  matchedJournalLine: one(journalLines, {
    fields: [statementLines.matchedJournalLineId],
    references: [journalLines.id],
  }),
  suggestions: many(reconciliationSuggestions),
}));

export const reconciliationSuggestionsRelations = relations(
  reconciliationSuggestions,
  ({ one }) => ({
    reconciliation: one(reconciliations, {
      fields: [reconciliationSuggestions.reconciliationId],
      references: [reconciliations.id],
    }),
    statementLine: one(statementLines, {
      fields: [reconciliationSuggestions.statementLineId],
      references: [statementLines.id],
    }),
    matchedJournalLine: one(journalLines, {
      fields: [reconciliationSuggestions.journalLineId],
      references: [journalLines.id],
    }),
  }),
);

export const reconciliationFlagsRelations = relations(reconciliationFlags, ({ one }) => ({
  reconciliation: one(reconciliations, {
    fields: [reconciliationFlags.reconciliationId],
    references: [reconciliations.id],
  }),
  statementLine: one(statementLines, {
    fields: [reconciliationFlags.statementLineId],
    references: [statementLines.id],
  }),
  suggestion: one(reconciliationSuggestions, {
    fields: [reconciliationFlags.suggestionId],
    references: [reconciliationSuggestions.id],
  }),
}));
