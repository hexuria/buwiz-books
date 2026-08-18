/**
 * Core Ledger Schema (Journal Headers & Lines)
 * Double-entry accounting foundation based on the patterns
 *
 * Transaction Types:
 *   pay_in   — Cash/payment received (Revenue/AR)
 *   pay_out  — Cash/payment sent (Expense/AP)
 *   journal  — Multi-line adjusting entries
 *   transfer — Movement between cash/credit accounts
 */
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  text,
  date,
  decimal,
  integer,
  timestamp,
  boolean,
  pgEnum,
  unique,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { isNull, relations } from "drizzle-orm";
import { accounts } from "./accounts";
import { parties } from "./parties";
import { dimensions } from "./dimensions";

// Transaction type enum
export const transactionTypeEnum = pgEnum("transaction_type", [
  "pay_in",
  "pay_out",
  "journal",
  "transfer",
]);

// Journal status enum
export const journalStatusEnum = pgEnum("journal_status", ["draft", "posted", "voided"]);

// Source of the journal entry
export const journalSourceEnum = pgEnum("journal_source", [
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
]);

/**
 * Journal Headers - Master record for each transaction
 */
export const journalHeaders = pgTable(
  "journal_headers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // Transaction identification
    transactionNumber: varchar("transaction_number", { length: 50 }), // auto-generated
    referenceNumber: varchar("reference_number", { length: 100 }), // external reference (check #, invoice #)
    // Stable caller-supplied key for retry-safe posting (for example provider payment IDs).
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    transactionDate: date("transaction_date").notNull(),

    // Classification
    transactionType: transactionTypeEnum("transaction_type").notNull(),
    source: journalSourceEnum("source").default("manual").notNull(),

    // Description
    memo: text("memo"),

    // Party (vendor or customer)
    partyId: uuid("party_id").references(() => parties.id),

    // Cached total (sum of debit lines, for display performance)
    totalAmount: decimal("total_amount", { precision: 20, scale: 8 }),
    functionalCurrency: varchar("functional_currency", { length: 3 }).default("USD").notNull(),
    transactionCurrency: varchar("transaction_currency", { length: 3 }),
    exchangeRateId: uuid("exchange_rate_id"),

    // Status
    status: journalStatusEnum("status").default("draft").notNull(),

    // Linked source documents
    sourceDocumentId: uuid("source_document_id"), // FK to invoices, bills, etc.
    sourceDocumentType: varchar("source_document_type", { length: 50 }), // 'invoice', 'bill', etc.

    // Audit
    createdBy: text("created_by"), // user ID of creator (auth_users.id)
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),

    // Amend-by-reversal lineage. A posted journal is never edited in place; a
    // correction posts a reversal (reversesHeaderId -> original) and a
    // replacement (replacesHeaderId -> original), leaving all three rows
    // permanently readable. Reports need no change: the original and its
    // reversal are both posted and net to zero.
    reversesHeaderId: uuid("reverses_header_id").references((): AnyPgColumn => journalHeaders.id, {
      onDelete: "restrict",
    }),
    replacesHeaderId: uuid("replaces_header_id").references((): AnyPgColumn => journalHeaders.id, {
      onDelete: "restrict",
    }),
    amendmentReason: text("amendment_reason"),

    // Non-destructive duplicate consolidation. A duplicate journal remains
    // immutable and fully auditable, but accounting queries exclude it while
    // this pointer is set.
    duplicateOfHeaderId: uuid("duplicate_of_header_id").references(
      (): AnyPgColumn => journalHeaders.id,
      { onDelete: "restrict" },
    ),

    // Transaction matching
    // Legacy compatibility only. New duplicate merges use duplicateOfHeaderId
    // plus journal_duplicate_merges and do not mutate these fields.
    matchedFromIds: uuid("matched_from_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    isMatched: boolean("is_matched").default(false).notNull(),
  },
  (table) => ({
    // Transaction numbers are unique per organization. (NULLs are allowed and treated as
    // distinct by Postgres, so rows without an allocated number don't collide.)
    // MIGRATION NOTE: existing data may contain duplicate (org, transaction_number) pairs
    // produced by the legacy count(*)+1 import numbering — dedupe before applying this constraint.
    orgTransactionNumberUnique: unique("journal_headers_org_transaction_number_unique").on(
      table.organizationId,
      table.transactionNumber,
    ),
    orgIdempotencyKeyUnique: uniqueIndex("journal_headers_org_idempotency_key_unique")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    sourceDocumentIndex: index("journal_headers_org_source_document_idx").on(
      table.organizationId,
      table.sourceDocumentType,
      table.sourceDocumentId,
    ),
    duplicateOfIndex: index("journal_headers_org_duplicate_of_idx").on(
      table.organizationId,
      table.duplicateOfHeaderId,
    ),
    notOwnDuplicateCheck: check(
      "journal_headers_not_own_duplicate_check",
      sql`${table.duplicateOfHeaderId} is null or ${table.duplicateOfHeaderId} <> ${table.id}`,
    ),
  }),
);

/**
 * Shared accounting predicate for journal-level queries. Financial consumers
 * must include this alongside their existing status/organization filters so a
 * confirmed duplicate does not affect balances while its original rows remain
 * available for audit and lossless unmerge.
 */
export function effectiveJournalPredicate() {
  return isNull(journalHeaders.duplicateOfHeaderId);
}

/**
 * Journal Lines - Individual debit/credit entries
 */
export const journalLines = pgTable("journal_lines", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Link to header
  journalHeaderId: uuid("journal_header_id")
    .references(() => journalHeaders.id, { onDelete: "cascade" })
    .notNull(),

  // Account
  accountId: uuid("account_id")
    .references(() => accounts.id)
    .notNull(),

  // Amount (one of debit or credit should be non-null)
  debit: decimal("debit", { precision: 20, scale: 8 }),
  credit: decimal("credit", { precision: 20, scale: 8 }),
  originalDebit: decimal("original_debit", { precision: 20, scale: 8 }),
  originalCredit: decimal("original_credit", { precision: 20, scale: 8 }),
  originalCurrency: varchar("original_currency", { length: 3 }),
  exchangeRate: decimal("exchange_rate", { precision: 20, scale: 10 }),
  exchangeRateId: uuid("exchange_rate_id"),

  // Line description (can differ from header memo)
  lineDescription: text("line_description"),

  // Per-line party (each journal line can have its own party)
  partyId: uuid("party_id").references(() => parties.id),

  // Dimensional tagging
  departmentId: uuid("department_id").references(() => dimensions.id),
  locationId: uuid("location_id").references(() => dimensions.id),

  // Sort order for display
  sortOrder: integer("sort_order").default(0).notNull(),

  // Audit
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const journalHeadersRelations = relations(journalHeaders, ({ one, many }) => ({
  party: one(parties, {
    fields: [journalHeaders.partyId],
    references: [parties.id],
  }),
  duplicateOf: one(journalHeaders, {
    fields: [journalHeaders.duplicateOfHeaderId],
    references: [journalHeaders.id],
    relationName: "journalDuplicateGroup",
  }),
  duplicates: many(journalHeaders, {
    relationName: "journalDuplicateGroup",
  }),
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  header: one(journalHeaders, {
    fields: [journalLines.journalHeaderId],
    references: [journalHeaders.id],
  }),
  account: one(accounts, {
    fields: [journalLines.accountId],
    references: [accounts.id],
  }),
  party: one(parties, {
    fields: [journalLines.partyId],
    references: [parties.id],
  }),
  department: one(dimensions, {
    fields: [journalLines.departmentId],
    references: [dimensions.id],
    relationName: "department",
  }),
  location: one(dimensions, {
    fields: [journalLines.locationId],
    references: [dimensions.id],
    relationName: "location",
  }),
}));
