/**
 * Financial Accounts Schema (Bank Accounts & Credit Cards)
 * Connected institution accounts with integration tracking
 */
import { pgTable, uuid, varchar, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { accounts } from "./accounts";

// Financial account type
export const financialAccountTypeEnum = pgEnum("financial_account_type", [
  "checking",
  "savings",
  "credit_card",
  "money_market",
  "investment",
  "other",
]);

// Connection status
export const connectionStatusEnum = pgEnum("connection_status", [
  "connected",
  "stale",
  "disconnected",
  "pending",
]);

export const financialAccounts = pgTable("financial_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  // Basic information
  accountName: varchar("account_name", { length: 255 }).notNull(),
  institutionName: varchar("institution_name", { length: 255 }),
  institutionLogoUrl: varchar("institution_logo_url", { length: 500 }),

  // Account details
  accountType: financialAccountTypeEnum("account_type").notNull(),
  lastFour: varchar("last_four", { length: 4 }), // last 4 digits of account

  // Link to GL account (Chart of Accounts)
  ledgerAccountId: uuid("ledger_account_id").references(() => accounts.id),

  // Integration details
  isManual: boolean("is_manual").default(true).notNull(), // true if manually created
  connectionStatus: connectionStatusEnum("connection_status").default("pending"),
  connectionId: varchar("connection_id", { length: 100 }), // Plaid item_id or similar
  integrationSource: varchar("integration_source", { length: 50 }), // 'plaid', 'mercury', etc.
  externalAccountId: varchar("external_account_id", { length: 100 }), // account ID from integration

  // Status
  isActive: boolean("is_active").default(true).notNull(),

  // Bank transfer / payment details (for manual invoice payments)
  accountNumber: varchar("account_number", { length: 50 }),
  routingNumber: varchar("routing_number", { length: 20 }),
  swiftCode: varchar("swift_code", { length: 15 }),
  iban: varchar("iban", { length: 50 }),
  qrCodeUrl: varchar("qr_code_url", { length: 500 }),
  /** If true, this account is shown as a payment destination on invoice payment links */
  showOnPaymentLink: boolean("show_on_payment_link").default(false),
  /** If true, this account belongs to the company (shown in Connections hub for wire payments) */
  isOwned: boolean("is_owned").default(false).notNull(),

  // Timestamps
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
export const financialAccountsRelations = relations(financialAccounts, ({ one }) => ({
  ledgerAccount: one(accounts, {
    fields: [financialAccounts.ledgerAccountId],
    references: [accounts.id],
  }),
}));

/**
 * Bank Transactions - Imported transactions from financial accounts
 */
export const bankTransactions = pgTable("bank_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Link to financial account
  financialAccountId: uuid("financial_account_id")
    .references(() => financialAccounts.id, { onDelete: "cascade" })
    .notNull(),

  // Transaction details
  transactionDate: timestamp("transaction_date").notNull(),
  rawDescription: varchar("raw_description", { length: 500 }).notNull(),
  amount: varchar("amount", { length: 50 }).notNull(), // stored as string, parsed as decimal

  // AI-cleansed party (after processing)
  cleansedPartyId: uuid("cleansed_party_id"), // FK to parties

  // Integration source tracking
  sourceIntegrationId: varchar("source_integration_id", { length: 100 }), // e.g., Stripe payout ID
  sourceIntegration: varchar("source_integration", { length: 50 }), // e.g., 'stripe', 'mercury'

  // Link to posted journal (after reconciliation)
  journalLineId: uuid("journal_line_id"), // FK to journal_lines

  // Import metadata
  externalId: varchar("external_id", { length: 100 }), // ID from source system
  importedAt: timestamp("imported_at").defaultNow().notNull(),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
