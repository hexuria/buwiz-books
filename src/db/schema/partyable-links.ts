/**
 * Partyable Links — Polymorphic Junction Table
 * Enables many-to-many party ↔ entity relationships.
 * Supplements (does NOT replace) journalHeaders.partyId.
 *
 * Use cases:
 *   - "Party X is commonly used with Account Y"
 *   - "Party X was auto-created from Connection Z"
 *   - "Party X is linked to Bill Y as a secondary party"
 */
import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { parties } from "./parties";

export const partyableLinks = pgTable(
  "partyable_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // The party being linked
    partyId: uuid("party_id")
      .references(() => parties.id, { onDelete: "cascade" })
      .notNull(),

    // Polymorphic target — type + id
    partyableType: varchar("partyable_type", { length: 50 }).notNull(), // 'account' | 'bill' | 'invoice' | 'transaction' | 'connection'
    partyableId: uuid("partyable_id").notNull(),

    // Role of the party in this relationship
    role: varchar("role", { length: 20 }).default("primary").notNull(), // 'primary' | 'secondary'

    // Audit
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("partyable_links_unique").on(
      table.organizationId,
      table.partyId,
      table.partyableType,
      table.partyableId,
    ),
  ],
);

// Relations (only to parties — polymorphic target can't use Drizzle relations)
export const partyableLinksRelations = relations(partyableLinks, ({ one }) => ({
  party: one(parties, {
    fields: [partyableLinks.partyId],
    references: [parties.id],
  }),
}));
