/**
 * Products Schema
 * Simple product catalog for invoice line items
 */
import { pgTable, uuid, varchar, text, decimal, boolean, timestamp } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  name: varchar("name", { length: 255 }).notNull(),
  defaultPrice: decimal("default_price", { precision: 12, scale: 2 }).default("0"),
  description: varchar("description", { length: 1000 }),
  isActive: boolean("is_active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
