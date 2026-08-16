/**
 * Invoicing Schema (Accounts Receivable)
 * Kanban workflow: Draft → Sent → Overdue → Paid
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  date,
  decimal,
  integer,
  timestamp,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { parties } from "./parties";
import { accounts } from "./accounts";
import { journalHeaders } from "./journals";

// Invoice status enum
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "viewed",
  "overdue",
  "partial",
  "paid",
  "voided",
]);

/**
 * Invoices - Customer invoices (A/R)
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Organization scoping
    organizationId: text("organization_id").notNull(),

    // Invoice identification
    // NOTE: uniqueness is scoped per-organization (see table-level unique constraint below),
    // NOT global — every org's sequence starts at INV-0001, so a global unique would make the
    // second tenant's first invoice collide.
    invoiceNumber: varchar("invoice_number", { length: 50 }).notNull(),

    // Customer
    customerId: uuid("customer_id")
      .references(() => parties.id)
      .notNull(),

    // Dates
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),

    // Status
    status: invoiceStatusEnum("status").default("draft").notNull(),

    // Amounts
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    discountAmount: decimal("discount_amount", { precision: 15, scale: 2 }).default("0"),
    discountPercent: decimal("discount_percent", { precision: 5, scale: 2 }),
    taxAmount: decimal("tax_amount", { precision: 15, scale: 2 }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    amountPaid: decimal("amount_paid", { precision: 15, scale: 2 }).default("0"),
    balanceDue: decimal("balance_due", { precision: 15, scale: 2 }).notNull(),

    // Additional info
    notes: text("notes"),
    paymentTerms: varchar("payment_terms", { length: 50 }),

    // Link to journal entry (when posted)
    journalHeaderId: uuid("journal_header_id").references(() => journalHeaders.id),

    // Audit
    sentAt: timestamp("sent_at"),
    paidAt: timestamp("paid_at"),
    paidVia: varchar("paid_via", { length: 20 }), // "stripe" | "paypal" | null
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    // Invoice numbers are unique per organization, not globally.
    orgInvoiceNumberUnique: unique("invoices_org_invoice_number_unique").on(
      table.organizationId,
      table.invoiceNumber,
    ),
  }),
);

/**
 * Invoice Line Items
 */
export const invoiceLineItems = pgTable("invoice_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Link to invoice
  invoiceId: uuid("invoice_id")
    .references(() => invoices.id, { onDelete: "cascade" })
    .notNull(),

  // Product/Service reference (optional)
  productServiceId: uuid("product_service_id"), // FK to products table if exists

  // Line item details
  description: varchar("description", { length: 500 }).notNull(),
  quantity: decimal("quantity", { precision: 10, scale: 4 }).notNull(),
  unitPrice: decimal("unit_price", { precision: 15, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),

  // Revenue account
  revenueAccountId: uuid("revenue_account_id").references(() => accounts.id),

  // Sort order
  sortOrder: integer("sort_order").default(0).notNull(),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Relations
export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(parties, {
    fields: [invoices.customerId],
    references: [parties.id],
  }),
  journalHeader: one(journalHeaders, {
    fields: [invoices.journalHeaderId],
    references: [journalHeaders.id],
  }),
  lineItems: many(invoiceLineItems),
}));

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLineItems.invoiceId],
    references: [invoices.id],
  }),
  revenueAccount: one(accounts, {
    fields: [invoiceLineItems.revenueAccountId],
    references: [accounts.id],
  }),
}));
