/**
 * Activity Logs Schema
 * Real audit trail — one row per action (create, edit, post, void, etc.)
 * Extensible to any entity type (transactions, bills, invoices…)
 */
import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    // Polymorphic reference — "transaction", "bill", "invoice", etc.
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: uuid("entity_id").notNull(),

    // What happened
    action: varchar("action", { length: 50 }).notNull(), // "created", "updated", "posted", "voided"

    // Who did it (auth_users.id)
    actorId: text("actor_id"),

    // Optional diff snapshot: { field: { old, new } }
    changes: jsonb("changes"),

    // When it happened
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("activity_logs_entity_idx").on(table.entityType, table.entityId),
    index("activity_logs_org_idx").on(table.organizationId),
  ],
);

// No FK relations declared (polymorphic entity_id can point to any table)
// Actor relation is resolved via a join at query time
export const activityLogsRelations = relations(activityLogs, () => ({}));
