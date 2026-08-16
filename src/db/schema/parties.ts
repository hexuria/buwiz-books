/**
 * Parties Schema (Unified Vendors & Customers)
 * Unified party model with type discriminator
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
  decimal,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { accounts } from "./accounts";

// Party type enum
export const partyTypeEnum = pgEnum("party_type", [
  "vendor",
  "customer",
  "both", // can be both vendor and customer
  "employee",
  "shareholder",
  "lender",
  "bank", // financial institutions (Mercury, Chase, etc.)
  "government",
  "other",
]);

export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  // Basic information
  name: varchar("name", { length: 255 }).notNull(),
  partyType: partyTypeEnum("party_type").notNull(),

  // Contact information
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  website: varchar("website", { length: 500 }),

  // Address (stored as JSON for flexibility)
  address: jsonb("address").$type<{
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>(),

  // Branding
  logoUrl: varchar("logo_url", { length: 500 }),
  description: text("description"),
  notes: text("notes"),

  // Vendor-specific fields
  is1099Vendor: boolean("is_1099_vendor").default(false), // for tax reporting
  taxId: varchar("tax_id", { length: 50 }), // should be encrypted in production

  // Vendor payment destination
  bankRoutingNumber: varchar("bank_routing_number", { length: 20 }),
  bankAccountNumber: varchar("bank_account_number", { length: 30 }),
  mailingAddress: jsonb("mailing_address").$type<{
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>(),

  // Customer-specific fields
  paymentTerms: varchar("payment_terms", { length: 50 }), // e.g., "Net 30"
  creditLimit: decimal("credit_limit", { precision: 12, scale: 2 }),

  // Default categorization (for auto-categorization)
  defaultAccountId: uuid("default_account_id").references(() => accounts.id),

  // Status
  isActive: boolean("is_active").default(true).notNull(),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
export const partiesRelations = relations(parties, ({ one }) => ({
  defaultAccount: one(accounts, {
    fields: [parties.defaultAccountId],
    references: [accounts.id],
  }),
}));
