/**
 * Chart of Accounts Schema
 * Based on the 5-digit numbering convention with hierarchical parent-child relationships

 *
 * Uses TEXT columns with app-level validation (via Zod + constants) instead of pgEnum
 * for safer schema evolution. See account-constants.ts for valid values.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // Account identification — unique per org, not globally
    accountNumber: varchar("account_number", { length: 10 }), // e.g., "10000", "11100"
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),

    // Classification — TEXT instead of pgEnum for safe evolution
    accountType: varchar("account_type", { length: 50 }).notNull(),
    subtype: varchar("subtype", { length: 100 }),

    // Hierarchy (self-referencing for parent-child relationships)
    parentId: uuid("parent_id").references((): AnyPgColumn => accounts.id),

    // Display customization (for display customization)
    icon: varchar("icon", { length: 50 }), // emoji or icon identifier

    // Per-account party type overrides — highest priority in 3-tier resolution
    // Tier 1: account-level > Tier 2: org-level (party_type_mappings) > Tier 3: system default
    readPartyTypes: jsonb("read_party_types").$type<string[]>(),
    mutatePartyTypes: jsonb("mutate_party_types").$type<string[]>(),

    // Integration mapping
    integrationId: varchar("integration_id", { length: 100 }), // e.g., Stripe account ID
    integrationSource: varchar("integration_source", { length: 50 }), // e.g., "stripe", "quickbooks"

    // Status — TEXT instead of pgEnum
    status: varchar("status", { length: 20 }).default("active").notNull(),
    isActive: boolean("is_active").default(true).notNull(), // Derived from status for API compat
    isSystem: boolean("is_system").default(false).notNull(), // prevents deletion

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("accounts_org_account_number_unique").on(table.organizationId, table.accountNumber),
  ],
);

// Relations for hierarchical queries
export const accountsRelations = relations(accounts, ({ one, many }) => ({
  parent: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
    relationName: "parentChild",
  }),
  children: many(accounts, {
    relationName: "parentChild",
  }),
}));
