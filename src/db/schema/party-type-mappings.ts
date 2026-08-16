/**
 * Party Type Mappings Schema
 * Stores per-organization overrides to the default SUBTYPE_PARTY_MAP.
 * Each row represents a custom mapping for one account subtype,
 * with separate configurations for reading (filtering) vs mutating (creation).
 *
 * - readTypes: which party types to SHOW in the combobox dropdown
 * - mutateTypes: which party types can be CREATED from the combobox
 */
import { pgTable, uuid, text, timestamp, jsonb, unique, varchar } from "drizzle-orm/pg-core";

export const partyTypeMappings = pgTable(
  "party_type_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // The account subtype key (e.g., "accounts_payable", "bank_accounts")
    subtype: varchar("subtype", { length: 100 }).notNull(),

    // Which party types to show when READING/LISTING parties for this subtype
    readTypes: jsonb("read_types").$type<string[]>().notNull(),

    // Which party types can be CREATED/MUTATED from the combobox for this subtype
    mutateTypes: jsonb("mutate_types").$type<string[]>().notNull(),

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("uq_org_subtype").on(t.organizationId, t.subtype)],
);
