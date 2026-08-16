/**
 * Category Mappings Schema
 * Stores per-organization category mapping overrides that were previously in localStorage.
 * Each row maps a domain row key (e.g., "default_expense", "accounts_payable") to a
 * ledger category (account) for a given mapping scope (bank, bill, invoice).
 */
import { pgTable, uuid, varchar, text, timestamp, unique } from "drizzle-orm/pg-core";
import { accounts } from "./accounts";

export const categoryMappings = pgTable(
  "category_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // Mapping scope — which config this belongs to (e.g., "bank", "bill", "invoice")
    mappingType: varchar("mapping_type", { length: 50 }).notNull(),

    // The row key from MappingConfig (e.g., "default_expense", "accounts_payable")
    sourceKey: varchar("source_key", { length: 100 }).notNull(),

    // The target ledger category (account) ID
    targetCategoryId: uuid("target_category_id")
      .references(() => accounts.id, { onDelete: "cascade" })
      .notNull(),

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("uq_org_mapping").on(t.organizationId, t.mappingType, t.sourceKey)],
);
