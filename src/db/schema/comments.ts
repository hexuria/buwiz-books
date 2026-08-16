/**
 * Comments Schema
 * Polymorphic comment system — one table for all entity types
 * Supports threaded replies, @mentions, file attachments, and soft delete
 */
import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    // Polymorphic reference — "reconciliation", "transaction", "bill", etc.
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: uuid("entity_id").notNull(),

    // Threaded replies (self-referencing)
    parentId: uuid("parent_id"),

    // Author (auth_users.id)
    authorId: text("author_id").notNull(),

    // Content
    body: text("body").notNull(),

    // Structured data
    // mentions: [{userId: string, name: string}]
    mentions: jsonb("mentions"),
    // attachments: [{r2Key: string, filename: string, contentType: string, sizeBytes: number}]
    attachments: jsonb("attachments"),

    // Timestamps
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("comments_entity_idx").on(table.entityType, table.entityId),
    index("comments_org_idx").on(table.organizationId),
    index("comments_author_idx").on(table.authorId),
    index("comments_parent_idx").on(table.parentId),
  ],
);

// Self-referencing relations for threaded replies
export const commentsRelations = relations(comments, ({ one, many }) => ({
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: "replies",
  }),
  replies: many(comments, { relationName: "replies" }),
}));
