/**
 * Durable idempotency records for accounting mutations that may post journals.
 *
 * These rows bind a caller-generated key to one exact request payload. They are
 * written in the same database transaction as the domain mutation and journal,
 * so a committed record always points at a fully committed accounting result.
 */
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization, user } from "./auth";
import { journalHeaders } from "./journals";
import { sourceRecords } from "./inbox";

export const accountingOperationIdempotency = pgTable(
  "accounting_operation_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    operationType: varchar("operation_type", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    state: varchar("state", { length: 16 }).default("pending").notNull(),
    journalHeaderId: uuid("journal_header_id").references(() => journalHeaders.id, {
      onDelete: "restrict",
    }),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "restrict",
    }),
    result: jsonb("result").$type<Record<string, unknown>>().default({}).notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("accounting_operation_idempotency_org_key_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("accounting_operation_idempotency_entity_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    check(
      "accounting_operation_idempotency_state_check",
      sql`${table.state} in ('pending', 'completed')`,
    ),
  ],
);
