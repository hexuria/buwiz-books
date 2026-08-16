/**
 * Transaction duplicate merge history.
 *
 * `match_history` is retained read-only for legacy snapshot-based matches.
 * New matches are represented by `journal_duplicate_merges`; both journals and
 * all of their lines remain in place, making reversal lossless.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { relations } from "drizzle-orm";
import { journalHeaders } from "./journals";

export const journalDuplicateMerges = pgTable(
  "journal_duplicate_merges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),

    canonicalHeaderId: uuid("canonical_header_id")
      .references(() => journalHeaders.id, { onDelete: "restrict" })
      .notNull(),
    duplicateHeaderId: uuid("duplicate_header_id")
      .references(() => journalHeaders.id, { onDelete: "restrict" })
      .notNull(),
    duplicateCaseId: uuid("duplicate_case_id"),
    pairKey: varchar("pair_key", { length: 73 }).notNull(),

    state: varchar("state", { length: 24 }).default("active").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),

    matchedAt: timestamp("matched_at", { withTimezone: true }).defaultNow().notNull(),
    matchedBy: text("matched_by").notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reversalReason: text("reversal_reason"),
    reversalIdempotencyKey: varchar("reversal_idempotency_key", { length: 255 }),
  },
  (table) => [
    uniqueIndex("journal_duplicate_merges_org_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex("journal_duplicate_merges_org_reversal_idempotency_unique")
      .on(table.organizationId, table.reversalIdempotencyKey)
      .where(sql`${table.reversalIdempotencyKey} is not null`),
    uniqueIndex("journal_duplicate_merges_active_pair_unique")
      .on(table.organizationId, table.pairKey)
      .where(sql`${table.state} = 'active'`),
    uniqueIndex("journal_duplicate_merges_active_duplicate_unique")
      .on(table.organizationId, table.duplicateHeaderId)
      .where(sql`${table.state} = 'active'`),
    index("journal_duplicate_merges_org_canonical_idx").on(
      table.organizationId,
      table.canonicalHeaderId,
      table.state,
    ),
    index("journal_duplicate_merges_case_idx").on(table.duplicateCaseId),
    check(
      "journal_duplicate_merges_distinct_headers_check",
      sql`${table.canonicalHeaderId} <> ${table.duplicateHeaderId}`,
    ),
    check(
      "journal_duplicate_merges_pair_key_check",
      sql`${table.pairKey} = least(${table.canonicalHeaderId}::text, ${table.duplicateHeaderId}::text) || ':' || greatest(${table.canonicalHeaderId}::text, ${table.duplicateHeaderId}::text)`,
    ),
    check(
      "journal_duplicate_merges_state_check",
      sql`${table.state} in ('active', 'reversed', 'quarantined')`,
    ),
    check(
      "journal_duplicate_merges_reversal_check",
      sql`(
        (${table.state} = 'active' and ${table.reversedAt} is null and ${table.reversedBy} is null)
        or
        (${table.state} <> 'active' and ${table.reversedAt} is not null)
      )`,
    ),
  ],
);

export const journalDuplicateMergesRelations = relations(journalDuplicateMerges, ({ one }) => ({
  canonicalHeader: one(journalHeaders, {
    fields: [journalDuplicateMerges.canonicalHeaderId],
    references: [journalHeaders.id],
    relationName: "canonicalDuplicateMerges",
  }),
  duplicateHeader: one(journalHeaders, {
    fields: [journalDuplicateMerges.duplicateHeaderId],
    references: [journalHeaders.id],
    relationName: "duplicateDuplicateMerges",
  }),
}));

export const matchHistory = pgTable(
  "match_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // The transaction that survived the merge
    survivingHeaderId: uuid("surviving_header_id")
      .references(() => journalHeaders.id)
      .notNull(),

    // Full snapshot of the deleted header (for restoration on unmatch)
    deletedHeaderSnapshot: jsonb("deleted_header_snapshot").notNull(),

    // Full snapshot of the deleted lines (for restoration on unmatch)
    deletedLinesSnapshot: jsonb("deleted_lines_snapshot").notNull(),

    // Audit
    matchedAt: timestamp("matched_at", { withTimezone: true }).defaultNow().notNull(),
    matchedBy: text("matched_by"), // user ID

    // Set when unmatched (soft-flag so we know it was reversed)
    unmatchedAt: timestamp("unmatched_at", { withTimezone: true }),
    unmatchedBy: text("unmatched_by"), // user ID
  },
  (table) => [
    index("match_history_surviving_idx").on(table.survivingHeaderId),
    index("match_history_org_idx").on(table.organizationId),
  ],
);

export const matchHistoryRelations = relations(matchHistory, ({ one }) => ({
  survivingHeader: one(journalHeaders, {
    fields: [matchHistory.survivingHeaderId],
    references: [journalHeaders.id],
  }),
}));

/**
 * Durable disposition for each active legacy destructive match considered by
 * the converter. A quarantine cannot live in journal_duplicate_merges because
 * that table intentionally requires two real journal-header foreign keys.
 */
export const legacyMatchConversionRecords = pgTable(
  "legacy_match_conversion_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    legacyMatchHistoryId: uuid("legacy_match_history_id")
      .references(() => matchHistory.id, { onDelete: "restrict" })
      .notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    journalDuplicateMergeId: uuid("journal_duplicate_merge_id").references(
      () => journalDuplicateMerges.id,
      { onDelete: "restrict" },
    ),
    snapshotDuplicateHeaderId: uuid("snapshot_duplicate_header_id"),
    snapshotDigest: varchar("snapshot_digest", { length: 64 }).notNull(),
    validatorVersion: varchar("validator_version", { length: 64 }).notNull(),
    reasonCodes: jsonb("reason_codes").$type<string[]>().default([]).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
    processedBy: text("processed_by").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
  },
  (table) => [
    uniqueIndex("legacy_match_conversion_records_history_unique").on(table.legacyMatchHistoryId),
    index("legacy_match_conversion_records_org_status_idx").on(
      table.organizationId,
      table.status,
      table.processedAt,
    ),
    check(
      "legacy_match_conversion_records_status_check",
      sql`${table.status} in ('converted', 'quarantined')`,
    ),
    check(
      "legacy_match_conversion_records_digest_check",
      sql`${table.snapshotDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "legacy_match_conversion_records_disposition_check",
      sql`(
        (
          ${table.status} = 'converted'
          and ${table.journalDuplicateMergeId} is not null
          and jsonb_array_length(${table.reasonCodes}) = 0
        )
        or
        (
          ${table.status} = 'quarantined'
          and ${table.journalDuplicateMergeId} is null
          and jsonb_array_length(${table.reasonCodes}) > 0
        )
      )`,
    ),
  ],
);

export const legacyMatchConversionRecordsRelations = relations(
  legacyMatchConversionRecords,
  ({ one }) => ({
    legacyMatchHistory: one(matchHistory, {
      fields: [legacyMatchConversionRecords.legacyMatchHistoryId],
      references: [matchHistory.id],
    }),
    journalDuplicateMerge: one(journalDuplicateMerges, {
      fields: [legacyMatchConversionRecords.journalDuplicateMergeId],
      references: [journalDuplicateMerges.id],
    }),
  }),
);
