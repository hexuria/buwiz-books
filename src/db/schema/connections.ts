/**
 * Category Connections Schema
 * Links external bank accounts, credit cards, and apps to categories
 * Based on the "Label Mappings" system
 */
import { pgTable, uuid, varchar, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { accounts } from "./accounts";

// Connection source types
export const connectionSourceTypeEnum = pgEnum("connection_source_type", [
  "bank",
  "credit_card",
  "payroll",
  "payment_processor",
  "expense_management",
  "other",
]);

/**
 * Category Connections
 * Maps external data sources (bank accounts, cards, apps) to chart of accounts categories
 */
export const categoryConnections = pgTable("category_connections", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  // Link to category
  categoryId: uuid("category_id")
    .references(() => accounts.id, { onDelete: "cascade" })
    .notNull(),

  // Source information
  sourceType: connectionSourceTypeEnum("source_type").notNull(),
  sourceName: varchar("source_name", { length: 255 }).notNull(), // e.g., "Chase Business Checking"
  sourceInstitution: varchar("source_institution", { length: 255 }), // e.g., "Chase Bank"

  // External identifiers
  externalId: varchar("external_id", { length: 255 }), // Bank account ID from provider
  externalSource: varchar("external_source", { length: 100 }), // e.g., "plaid", "stripe"

  // Display
  lastFourDigits: varchar("last_four_digits", { length: 4 }), // For cards: "4242"

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
export const categoryConnectionsRelations = relations(categoryConnections, ({ one }) => ({
  category: one(accounts, {
    fields: [categoryConnections.categoryId],
    references: [accounts.id],
  }),
}));
