import {
  pgTable,
  foreignKey,
  unique,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  numeric,
  integer,
  date,
  pgEnum,
} from "drizzle-orm/pg-core";

export const billStatus = pgEnum("bill_status", [
  "in_review",
  "pending_approval",
  "approved",
  "awaiting_payment",
  "scheduled",
  "paid",
  "voided",
]);
export const connectionSourceType = pgEnum("connection_source_type", [
  "bank",
  "credit_card",
  "payroll",
  "payment_processor",
  "expense_management",
  "other",
]);
export const connectionStatus = pgEnum("connection_status", [
  "connected",
  "stale",
  "disconnected",
  "pending",
]);
export const dimensionType = pgEnum("dimension_type", [
  "department",
  "location",
  "class",
  "project",
]);
export const documentType = pgEnum("document_type", [
  "statement",
  "bill",
  "invoice",
  "receipt",
  "contract",
  "tax_form",
  "other",
]);
export const fileType = pgEnum("file_type", [
  "pdf",
  "xlsx",
  "xls",
  "csv",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "zip",
  "docx",
  "doc",
  "other",
]);
export const financialAccountType = pgEnum("financial_account_type", [
  "checking",
  "savings",
  "credit_card",
  "money_market",
  "investment",
  "other",
]);
export const flagType = pgEnum("flag_type", [
  "unmatched_statement",
  "unmatched_ledger",
  "date_mismatch",
  "amount_discrepancy",
  "duplicate",
  "overmatched",
]);
export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "sent",
  "viewed",
  "overdue",
  "partial",
  "paid",
  "voided",
]);
export const journalSource = pgEnum("journal_source", [
  "manual",
  "import",
  "invoice",
  "bill",
  "reconciliation",
  "system",
]);
export const journalStatus = pgEnum("journal_status", ["draft", "posted", "voided"]);
export const matchStatus = pgEnum("match_status", ["unmatched", "matched", "created", "ignored"]);
export const partyType = pgEnum("party_type", [
  "vendor",
  "customer",
  "both",
  "employee",
  "shareholder",
  "lender",
  "government",
  "other",
]);
export const reconciliationStatus = pgEnum("reconciliation_status", [
  "not_started",
  "draft",
  "in_progress",
  "finalized",
]);
export const suggestedAction = pgEnum("suggested_action", [
  "create_transaction",
  "change_date",
  "split_transaction",
  "ignore",
  "manual_review",
]);
export const transactionType = pgEnum("transaction_type", [
  "pay_in",
  "pay_out",
  "journal",
  "transfer",
]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountNumber: varchar("account_number", { length: 10 }),
    name: varchar({ length: 255 }).notNull(),
    description: text(),
    accountType: varchar("account_type", { length: 50 }).notNull(),
    subtype: varchar({ length: 100 }),
    parentId: uuid("parent_id"),
    icon: varchar({ length: 50 }),
    integrationId: varchar("integration_id", { length: 100 }),
    integrationSource: varchar("integration_source", { length: 50 }),
    isActive: boolean("is_active").default(true).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    status: varchar({ length: 20 }).default("active").notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "accounts_parent_id_accounts_id_fk",
    }),
    unique("accounts_account_number_unique").on(table.accountNumber),
  ],
);

export const dimensions = pgTable(
  "dimensions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    dimensionType: dimensionType("dimension_type").notNull(),
    name: varchar({ length: 255 }).notNull(),
    code: varchar({ length: 50 }),
    description: text(),
    parentId: uuid("parent_id"),
    sourceIntegrationId: varchar("source_integration_id", { length: 100 }),
    sourceIntegration: varchar("source_integration", { length: 50 }),
    metadata: jsonb(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "dimensions_parent_id_dimensions_id_fk",
    }),
  ],
);

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    productServiceId: uuid("product_service_id"),
    description: varchar({ length: 500 }).notNull(),
    quantity: numeric({ precision: 10, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    amount: numeric({ precision: 15, scale: 2 }).notNull(),
    revenueAccountId: uuid("revenue_account_id"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [invoices.id],
      name: "invoice_line_items_invoice_id_invoices_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.revenueAccountId],
      foreignColumns: [accounts.id],
      name: "invoice_line_items_revenue_account_id_accounts_id_fk",
    }),
  ],
);

export const parties = pgTable(
  "parties",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    partyType: partyType("party_type").notNull(),
    email: varchar({ length: 255 }),
    phone: varchar({ length: 50 }),
    website: varchar({ length: 500 }),
    address: jsonb(),
    logoUrl: varchar("logo_url", { length: 500 }),
    description: text(),
    notes: text(),
    is1099Vendor: boolean("is_1099_vendor").default(false),
    taxId: varchar("tax_id", { length: 50 }),
    paymentTerms: varchar("payment_terms", { length: 50 }),
    creditLimit: numeric("credit_limit", { precision: 12, scale: 2 }),
    defaultAccountId: uuid("default_account_id"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    bankRoutingNumber: varchar("bank_routing_number", { length: 20 }),
    bankAccountNumber: varchar("bank_account_number", { length: 30 }),
    mailingAddress: jsonb("mailing_address"),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.defaultAccountId],
      foreignColumns: [accounts.id],
      name: "parties_default_account_id_accounts_id_fk",
    }),
  ],
);

export const financialAccounts = pgTable(
  "financial_accounts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountName: varchar("account_name", { length: 255 }).notNull(),
    institutionName: varchar("institution_name", { length: 255 }),
    institutionLogoUrl: varchar("institution_logo_url", { length: 500 }),
    accountType: financialAccountType("account_type").notNull(),
    lastFour: varchar("last_four", { length: 4 }),
    ledgerAccountId: uuid("ledger_account_id"),
    isManual: boolean("is_manual").default(true).notNull(),
    connectionStatus: connectionStatus("connection_status").default("pending"),
    connectionId: varchar("connection_id", { length: 100 }),
    integrationSource: varchar("integration_source", { length: 50 }),
    externalAccountId: varchar("external_account_id", { length: 100 }),
    isActive: boolean("is_active").default(true).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ledgerAccountId],
      foreignColumns: [accounts.id],
      name: "financial_accounts_ledger_account_id_accounts_id_fk",
    }),
  ],
);

export const reconciliations = pgTable(
  "reconciliations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    statementBeginningBalance: numeric("statement_beginning_balance", { precision: 15, scale: 2 }),
    statementEndingBalance: numeric("statement_ending_balance", { precision: 15, scale: 2 }),
    ledgerBalance: numeric("ledger_balance", { precision: 15, scale: 2 }),
    status: reconciliationStatus().default("not_started").notNull(),
    aiAutoFinalized: boolean("ai_auto_finalized").default(false),
    finalizedAt: timestamp("finalized_at", { mode: "string" }),
    finalizedById: uuid("finalized_by_id"),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.bankAccountId],
      foreignColumns: [financialAccounts.id],
      name: "reconciliations_bank_account_id_financial_accounts_id_fk",
    }),
  ],
);

export const documentAttachments = pgTable(
  "document_attachments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    documentId: uuid("document_id").notNull(),
    linkableType: varchar("linkable_type", { length: 50 }).notNull(),
    linkableId: uuid("linkable_id").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_attachments_document_id_documents_id_fk",
    }).onDelete("cascade"),
  ],
);

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    financialAccountId: uuid("financial_account_id").notNull(),
    transactionDate: timestamp("transaction_date", { mode: "string" }).notNull(),
    rawDescription: varchar("raw_description", { length: 500 }).notNull(),
    amount: varchar({ length: 50 }).notNull(),
    cleansedPartyId: uuid("cleansed_party_id"),
    sourceIntegrationId: varchar("source_integration_id", { length: 100 }),
    sourceIntegration: varchar("source_integration", { length: 50 }),
    journalLineId: uuid("journal_line_id"),
    externalId: varchar("external_id", { length: 100 }),
    importedAt: timestamp("imported_at", { mode: "string" }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.financialAccountId],
      foreignColumns: [financialAccounts.id],
      name: "bank_transactions_financial_account_id_financial_accounts_id_fk",
    }).onDelete("cascade"),
  ],
);

export const categoryConnections = pgTable(
  "category_connections",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    categoryId: uuid("category_id").notNull(),
    sourceType: connectionSourceType("source_type").notNull(),
    sourceName: varchar("source_name", { length: 255 }).notNull(),
    sourceInstitution: varchar("source_institution", { length: 255 }),
    externalId: varchar("external_id", { length: 255 }),
    externalSource: varchar("external_source", { length: 100 }),
    lastFourDigits: varchar("last_four_digits", { length: 4 }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [accounts.id],
      name: "category_connections_category_id_accounts_id_fk",
    }).onDelete("cascade"),
  ],
);

export const documents = pgTable("documents", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  originalFilename: varchar("original_filename", { length: 500 }).notNull(),
  displayTitle: varchar("display_title", { length: 255 }),
  summary: text(),
  documentType: documentType("document_type").default("other").notNull(),
  fileType: fileType("file_type").default("other").notNull(),
  storagePath: varchar("storage_path", { length: 1000 }).notNull(),
  fileSizeBytes: integer("file_size_bytes"),
  mimeType: varchar("mime_type", { length: 100 }),
  metadata: jsonb(),
  uploadedById: text("uploaded_by_id"),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  organizationId: text("organization_id").notNull(),
  r2Key: varchar("r2_key", { length: 1000 }),
  r2Bucket: varchar("r2_bucket", { length: 100 }),
  thumbnailR2Key: varchar("thumbnail_r2_key", { length: 1000 }),
  isPublic: boolean("is_public").default(false),
});

export const billLineItems = pgTable(
  "bill_line_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    billId: uuid("bill_id").notNull(),
    description: varchar({ length: 500 }),
    amount: numeric({ precision: 15, scale: 2 }).notNull(),
    accountId: uuid("account_id").notNull(),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.billId],
      foreignColumns: [bills.id],
      name: "bill_line_items_bill_id_bills_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: "bill_line_items_account_id_accounts_id_fk",
    }),
    foreignKey({
      columns: [table.departmentId],
      foreignColumns: [dimensions.id],
      name: "bill_line_items_department_id_dimensions_id_fk",
    }),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [dimensions.id],
      name: "bill_line_items_location_id_dimensions_id_fk",
    }),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "string" }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: "string" }),
    scope: text(),
    idToken: text("id_token"),
    password: text(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUsers.id],
      name: "auth_accounts_user_id_auth_users_id_fk",
    }).onDelete("cascade"),
  ],
);

export const authMembers = pgTable(
  "auth_members",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    role: text().default("member").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUsers.id],
      name: "auth_members_user_id_auth_users_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
      name: "auth_members_organization_id_auth_organizations_id_fk",
    }).onDelete("cascade"),
  ],
);

export const authInvitations = pgTable(
  "auth_invitations",
  {
    id: text().primaryKey().notNull(),
    email: text().notNull(),
    organizationId: text("organization_id").notNull(),
    role: text().default("member").notNull(),
    status: text().default("pending").notNull(),
    inviterId: text("inviter_id").notNull(),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
      name: "auth_invitations_organization_id_auth_organizations_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.inviterId],
      foreignColumns: [authUsers.id],
      name: "auth_invitations_inviter_id_auth_users_id_fk",
    }).onDelete("cascade"),
  ],
);

export const authOrganizations = pgTable(
  "auth_organizations",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    logo: text(),
    metadata: text(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [unique("auth_organizations_slug_unique").on(table.slug)],
);

export const journalHeaders = pgTable(
  "journal_headers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    transactionNumber: varchar("transaction_number", { length: 50 }),
    transactionDate: date("transaction_date").notNull(),
    transactionType: transactionType("transaction_type").notNull(),
    source: journalSource().default("manual").notNull(),
    memo: text(),
    partyId: uuid("party_id"),
    status: journalStatus().default("draft").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    sourceDocumentType: varchar("source_document_type", { length: 50 }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    postedAt: timestamp("posted_at", { mode: "string" }),
    voidedAt: timestamp("voided_at", { mode: "string" }),
    referenceNumber: varchar("reference_number", { length: 100 }),
    totalAmount: numeric("total_amount", { precision: 15, scale: 2 }),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.partyId],
      foreignColumns: [parties.id],
      name: "journal_headers_party_id_parties_id_fk",
    }),
  ],
);

export const authVerifications = pgTable("auth_verifications", {
  id: text().primaryKey().notNull(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
});

export const bills = pgTable(
  "bills",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    vendorId: uuid("vendor_id").notNull(),
    billNumber: varchar("bill_number", { length: 100 }),
    billDate: date("bill_date").notNull(),
    dueDate: date("due_date").notNull(),
    status: billStatus().default("in_review").notNull(),
    amount: numeric({ precision: 15, scale: 2 }).notNull(),
    amountPaid: numeric("amount_paid", { precision: 15, scale: 2 }).default("0"),
    balanceDue: numeric("balance_due", { precision: 15, scale: 2 }).notNull(),
    memo: text(),
    approverId: uuid("approver_id"),
    approvedAt: timestamp("approved_at", { mode: "string" }),
    scheduledPaymentDate: date("scheduled_payment_date"),
    paidAt: timestamp("paid_at", { mode: "string" }),
    paymentMethod: varchar("payment_method", { length: 50 }),
    paymentReference: varchar("payment_reference", { length: 100 }),
    journalHeaderId: uuid("journal_header_id"),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    documentUrl: varchar("document_url", { length: 1000 }),
    documentType: varchar("document_type", { length: 20 }),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vendorId],
      foreignColumns: [parties.id],
      name: "bills_vendor_id_parties_id_fk",
    }),
    foreignKey({
      columns: [table.journalHeaderId],
      foreignColumns: [journalHeaders.id],
      name: "bills_journal_header_id_journal_headers_id_fk",
    }),
  ],
);

export const authUsers = pgTable(
  "auth_users",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [unique("auth_users_email_unique").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    token: text().notNull(),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUsers.id],
      name: "auth_sessions_user_id_auth_users_id_fk",
    }).onDelete("cascade"),
    unique("auth_sessions_token_unique").on(table.token),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    invoiceNumber: varchar("invoice_number", { length: 50 }).notNull(),
    customerId: uuid("customer_id").notNull(),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    status: invoiceStatus().default("draft").notNull(),
    subtotal: numeric({ precision: 15, scale: 2 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 15, scale: 2 }).default("0"),
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 }).default("0"),
    total: numeric({ precision: 15, scale: 2 }).notNull(),
    amountPaid: numeric("amount_paid", { precision: 15, scale: 2 }).default("0"),
    balanceDue: numeric("balance_due", { precision: 15, scale: 2 }).notNull(),
    notes: text(),
    paymentTerms: varchar("payment_terms", { length: 50 }),
    journalHeaderId: uuid("journal_header_id"),
    sentAt: timestamp("sent_at", { mode: "string" }),
    paidAt: timestamp("paid_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [parties.id],
      name: "invoices_customer_id_parties_id_fk",
    }),
    foreignKey({
      columns: [table.journalHeaderId],
      foreignColumns: [journalHeaders.id],
      name: "invoices_journal_header_id_journal_headers_id_fk",
    }),
    unique("invoices_invoice_number_unique").on(table.invoiceNumber),
  ],
);

export const products = pgTable("products", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: varchar({ length: 255 }).notNull(),
  defaultPrice: numeric("default_price", { precision: 12, scale: 2 }).default("0"),
  description: varchar({ length: 1000 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  organizationId: text("organization_id").notNull(),
});

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    journalHeaderId: uuid("journal_header_id").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: numeric({ precision: 15, scale: 2 }),
    credit: numeric({ precision: 15, scale: 2 }),
    lineDescription: text("line_description"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.journalHeaderId],
      foreignColumns: [journalHeaders.id],
      name: "journal_lines_journal_header_id_journal_headers_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: "journal_lines_account_id_accounts_id_fk",
    }),
    foreignKey({
      columns: [table.departmentId],
      foreignColumns: [dimensions.id],
      name: "journal_lines_department_id_dimensions_id_fk",
    }),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [dimensions.id],
      name: "journal_lines_location_id_dimensions_id_fk",
    }),
  ],
);

export const statementLines = pgTable(
  "statement_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    transactionDate: date("transaction_date").notNull(),
    description: varchar({ length: 500 }).notNull(),
    amount: numeric({ precision: 15, scale: 2 }).notNull(),
    matchedJournalLineId: uuid("matched_journal_line_id"),
    matchStatus: matchStatus("match_status").default("unmatched").notNull(),
    matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }),
    sortOrder: integer("sort_order"),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reconciliationId],
      foreignColumns: [reconciliations.id],
      name: "statement_lines_reconciliation_id_reconciliations_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.matchedJournalLineId],
      foreignColumns: [journalLines.id],
      name: "statement_lines_matched_journal_line_id_journal_lines_id_fk",
    }),
  ],
);

export const reconciliationFlags = pgTable(
  "reconciliation_flags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    statementLineId: uuid("statement_line_id"),
    flagType: flagType("flag_type").notNull(),
    suggestedAction: suggestedAction("suggested_action"),
    description: text(),
    resolved: boolean().default(false).notNull(),
    resolvedAt: timestamp("resolved_at", { mode: "string" }),
    resolvedById: uuid("resolved_by_id"),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reconciliationId],
      foreignColumns: [reconciliations.id],
      name: "reconciliation_flags_reconciliation_id_reconciliations_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.statementLineId],
      foreignColumns: [statementLines.id],
      name: "reconciliation_flags_statement_line_id_statement_lines_id_fk",
    }),
  ],
);

export const documentSuggestions = pgTable(
  "document_suggestions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    documentId: uuid("document_id").notNull(),
    suggestedJournalHeaderId: uuid("suggested_journal_header_id"),
    confidence: integer(),
    reason: text(),
    accepted: boolean(),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }),
    reviewedById: uuid("reviewed_by_id"),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_suggestions_document_id_documents_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.suggestedJournalHeaderId],
      foreignColumns: [journalHeaders.id],
      name: "document_suggestions_suggested_journal_header_id_journal_header",
    }),
  ],
);
