/**
 * Bill Pay Schema (Accounts Payable)
 * Workflow: In Review → Pending Approval → Awaiting Payment → Paid
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  date,
  decimal,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { parties } from "./parties";
import { accounts } from "./accounts";
import { dimensions } from "./dimensions";
import { journalHeaders } from "./journals";

// Bill status enum (bill workflow)
export const billStatusEnum = pgEnum("bill_status", [
  "draft",
  "in_review",
  "pending_approval",
  "approved",
  "awaiting_payment",
  "scheduled",
  "partial",
  "paid",
  "voided",
]);

/**
 * Bills - Vendor bills (A/P)
 */
export const bills = pgTable("bills", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Organization scoping
  organizationId: text("organization_id").notNull(),

  // Vendor (nullable for draft bills before OCR processing)
  vendorId: uuid("vendor_id").references(() => parties.id),

  // Bill identification (external reference from vendor)
  billNumber: varchar("bill_number", { length: 100 }),

  // Dates
  billDate: date("bill_date").notNull(),
  dueDate: date("due_date").notNull(),

  // Status
  status: billStatusEnum("status").default("draft").notNull(),

  // Amount
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  amountPaid: decimal("amount_paid", { precision: 15, scale: 2 }).default("0"),
  balanceDue: decimal("balance_due", { precision: 15, scale: 2 }).notNull(),

  // Uploaded document
  documentUrl: varchar("document_url", { length: 1000 }),
  documentType: varchar("document_type", { length: 20 }), // 'pdf', 'image'

  // Bookkeeping
  memo: text("memo"),

  // Approval workflow
  approverId: text("approver_id"), // FK to auth_users (text ID, not UUID)
  approvedAt: timestamp("approved_at"),

  // Payment tracking
  scheduledPaymentDate: date("scheduled_payment_date"),
  paidAt: timestamp("paid_at"),
  paymentMethod: varchar("payment_method", { length: 50 }), // 'check', 'ach', 'wire', etc.
  paymentReference: varchar("payment_reference", { length: 100 }), // check number, confirmation, etc.

  // Recurring bill detection
  isRecurring: boolean("is_recurring").default(false).notNull(),
  recurringFrequency: varchar("recurring_frequency", { length: 20 }), // weekly, monthly, quarterly, yearly

  // AI classification tracking
  categoryConfidence: decimal("category_confidence", { precision: 3, scale: 2 }), // 0.00-1.00
  classificationStatus: varchar("classification_status", { length: 20 }).default("manual"), // auto, needs_review, manual

  // AI-extracted bounding boxes for interactive document viewer
  ocrBoundingBoxes: jsonb("ocr_bounding_boxes").$type<
    Array<{
      fieldId: string; // e.g. "vendor_name", "invoice_number", "line_item_0"
      label: string; // Human-readable label
      bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized 0-1000
      page: number; // Page number (0-indexed)
    }>
  >(),

  // Link to journal entry (when posted)
  journalHeaderId: uuid("journal_header_id").references(() => journalHeaders.id),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Bill Line Items - Expense allocations
 */
export const billLineItems = pgTable("bill_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Link to bill
  billId: uuid("bill_id")
    .references(() => bills.id, { onDelete: "cascade" })
    .notNull(),

  // Line item details
  description: varchar("description", { length: 500 }),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),

  // Expense account (category)
  accountId: uuid("account_id")
    .references(() => accounts.id)
    .notNull(),

  // Dimensional tagging
  departmentId: uuid("department_id").references(() => dimensions.id),
  locationId: uuid("location_id").references(() => dimensions.id),

  // Sort order
  sortOrder: integer("sort_order").default(0).notNull(),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Relations
export const billsRelations = relations(bills, ({ one, many }) => ({
  vendor: one(parties, {
    fields: [bills.vendorId],
    references: [parties.id],
  }),
  journalHeader: one(journalHeaders, {
    fields: [bills.journalHeaderId],
    references: [journalHeaders.id],
  }),
  lineItems: many(billLineItems),
}));

export const billLineItemsRelations = relations(billLineItems, ({ one }) => ({
  bill: one(bills, {
    fields: [billLineItems.billId],
    references: [bills.id],
  }),
  account: one(accounts, {
    fields: [billLineItems.accountId],
    references: [accounts.id],
  }),
  department: one(dimensions, {
    fields: [billLineItems.departmentId],
    references: [dimensions.id],
    relationName: "department",
  }),
  location: one(dimensions, {
    fields: [billLineItems.locationId],
    references: [dimensions.id],
    relationName: "location",
  }),
}));
