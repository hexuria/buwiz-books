/**
 * Dimensions Schema (Departments & Locations)
 * Supports hierarchical organization with optional source tracking
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Dimension type enum
export const dimensionTypeEnum = pgEnum("dimension_type", [
  "department",
  "location",
  "class",
  "project",
]);

export const dimensions = pgTable("dimensions", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  // Type and identification
  dimensionType: dimensionTypeEnum("dimension_type").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  code: varchar("code", { length: 50 }), // optional short code
  description: text("description"),

  // Hierarchy (self-referencing)
  parentId: uuid("parent_id").references((): AnyPgColumn => dimensions.id),

  // Import source tracking (e.g., G-Suite import)
  sourceIntegrationId: varchar("source_integration_id", { length: 100 }),
  sourceIntegration: varchar("source_integration", { length: 50 }), // e.g., "gsuite", "bamboohr"

  // Custom metadata
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),

  // Status
  isActive: boolean("is_active").default(true).notNull(),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations for hierarchical queries
export const dimensionsRelations = relations(dimensions, ({ one, many }) => ({
  parent: one(dimensions, {
    fields: [dimensions.parentId],
    references: [dimensions.id],
    relationName: "parentChild",
  }),
  children: many(dimensions, {
    relationName: "parentChild",
  }),
}));
