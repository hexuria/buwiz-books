/**
 * Classification memories — human fixes that stick (Inbox v2 spec §7).
 *
 * When a reviewer corrects an Inbox draft and opts in to "Remember this?",
 * the corrected answer (the kind of paper, the party, and each line's
 * account) is stored here under a match key derived from the paper. Stage 2
 * classification (src/lib/inbox/candidate-classification.ts) consults this
 * table BEFORE any model: a hit answers the draft deterministically, and the
 * rule set still runs on the result, so blocking findings still block.
 *
 * Match kinds, most specific first — the order IS the lookup policy
 * (src/lib/inbox/memory/keys.ts):
 *   file_hash    sha256 of the source document bytes (documents.content_hash)
 *   sender_party normalized sender email + normalized printed party tax id
 *   party        the matched party id
 *   line_text    normalized, sorted description tokens (vendor-alias rules)
 * Keys are normalized at write time, so a lookup is an exact index probe.
 *
 * A memory never carries bank or payment details: the answer is a doc kind,
 * a party id, and account ids, nothing a document could redirect money with.
 *
 * Counters: `uses` counts drafts a memory answered; `undos` counts drafts a
 * person corrected away from its answer (or entries later reversed);
 * `consecutive_undos` resets on an answer that is approved unchanged. Two
 * consecutive undos disable the memory IN CODE — a CHECK would reject the
 * very update that records the second undo (review-findings.md).
 *
 * Export/import: memories are org configuration, exported since version 5
 * (src/lib/export-inbox.ts, .agent/rules/schema-export-import.md category C).
 * Parties travel by name and accounts by (number, name); import remaps them
 * and drops, with a reason, a memory whose references cannot be mapped.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { parties } from "./parties";

export type ClassificationMemoryMatchKind = "file_hash" | "sender_party" | "party" | "line_text";

/** One remembered line: which line of a new draft it answers, and with what. */
export interface ClassificationMemoryAnswerLine {
  /** The draft line this answers: its side, and its position among that side's lines. */
  lineMatch: { side: "debit" | "credit"; index: number };
  accountId: string;
  /** The account's type when the memory was saved; a re-typed account no longer fits. */
  accountType: string;
  /** Exact decimal as corrected. Only a split side (two or more lines) replays amounts. */
  amount: string;
  currency: string;
  /** Reserved: Inbox candidate lines carry no tax code yet. */
  taxCode: string | null;
}

export const classificationMemories = pgTable(
  "classification_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    matchKind: varchar("match_kind", { length: 32 })
      .$type<ClassificationMemoryMatchKind>()
      .notNull(),
    matchKey: varchar("match_key", { length: 255 }).notNull(),
    // The economic event class the paper was corrected to (purchase, bill_accrual, ...).
    answerDocKind: varchar("answer_doc_kind", { length: 32 }),
    // A memory whose party is deleted means nothing any more, so it goes with it.
    answerPartyId: uuid("answer_party_id").references(() => parties.id, { onDelete: "cascade" }),
    answerLines: jsonb("answer_lines").$type<ClassificationMemoryAnswerLine[]>(),
    createdBy: text("created_by").notNull(),
    sourceFeedbackId: uuid("source_feedback_id"),
    uses: integer("uses").default(0).notNull(),
    undos: integer("undos").default(0).notNull(),
    consecutiveUndos: integer("consecutive_undos").default(0).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("classification_memories_org_kind_key_unique").on(
      table.organizationId,
      table.matchKind,
      table.matchKey,
    ),
    check(
      "classification_memories_match_kind_check",
      sql`${table.matchKind} in ('file_hash', 'sender_party', 'party', 'line_text')`,
    ),
    check(
      "classification_memories_counters_check",
      sql`${table.uses} >= 0 and ${table.undos} >= 0 and ${table.consecutiveUndos} >= 0`,
    ),
  ],
);
