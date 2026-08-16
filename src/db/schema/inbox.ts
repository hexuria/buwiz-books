/**
 * Inbox, source-ingestion, review-agent, firm-access, and FX schema.
 *
 * The core invariant is that external or user-provided activity is preserved as
 * source evidence and a revisioned candidate before an approved journal exists.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  date,
  decimal,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization, user } from "./auth";
import { accounts } from "./accounts";
import { parties } from "./parties";
import { dimensions } from "./dimensions";
import { documents } from "./documents";
import { journalHeaders } from "./journals";

export const organizationAccountingSettings = pgTable(
  "organization_accounting_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    baseCurrency: varchar("base_currency", { length: 3 }).default("USD").notNull(),
    timezone: varchar("timezone", { length: 64 }).default("UTC").notNull(),
    inboundEmailAddress: varchar("inbound_email_address", { length: 320 }),
    reviewPolicy: varchar("review_policy", { length: 32 }).default("always_review").notNull(),
    requireDifferentApprover: boolean("require_different_approver").default(true).notNull(),
    allowOwnerOverride: boolean("allow_owner_override").default(true).notNull(),
    lowConfidenceThreshold: decimal("low_confidence_threshold", {
      precision: 5,
      scale: 4,
    })
      .default("0.8000")
      .notNull(),
    missingReceiptThreshold: decimal("missing_receipt_threshold", {
      precision: 20,
      scale: 8,
    })
      .default("75")
      .notNull(),
    missingReceiptCurrency: varchar("missing_receipt_currency", { length: 3 })
      .default("USD")
      .notNull(),
    fxGainAccountId: uuid("fx_gain_account_id").references(() => accounts.id),
    fxLossAccountId: uuid("fx_loss_account_id").references(() => accounts.id),
    fxRoundingAccountId: uuid("fx_rounding_account_id").references(() => accounts.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("organization_accounting_settings_inbound_email_unique")
      .on(table.inboundEmailAddress)
      .where(sql`${table.inboundEmailAddress} is not null`),
  ],
);

export const firms = pgTable("firms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const firmMembers = pgTable(
  "firm_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .references(() => firms.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 32 }).default("preparer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("firm_members_firm_user_unique").on(table.firmId, table.userId),
    index("firm_members_user_idx").on(table.userId),
  ],
);

export const firmClients = pgTable(
  "firm_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .references(() => firms.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("firm_clients_firm_org_unique").on(table.firmId, table.organizationId),
    index("firm_clients_org_idx").on(table.organizationId),
  ],
);

export const firmMemberClientAccess = pgTable(
  "firm_member_client_access",
  {
    firmMemberId: uuid("firm_member_id")
      .references(() => firmMembers.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.firmMemberId, table.organizationId] }),
    index("firm_member_client_access_org_idx").on(table.organizationId),
  ],
);

export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
    quoteCurrency: varchar("quote_currency", { length: 3 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    rate: decimal("rate", { precision: 20, scale: 10 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    providerReference: varchar("provider_reference", { length: 255 }),
    isManualOverride: boolean("is_manual_override").default(false).notNull(),
    overrideReason: text("override_reason"),
    createdBy: text("created_by").references(() => user.id),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("fx_rates_org_pair_date_source_unique").on(
      table.organizationId,
      table.baseCurrency,
      table.quoteCurrency,
      table.effectiveDate,
      table.source,
    ),
    index("fx_rates_org_pair_date_idx").on(
      table.organizationId,
      table.baseCurrency,
      table.quoteCurrency,
      table.effectiveDate,
    ),
  ],
);

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    domain: varchar("domain", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).default("pending").notNull(),
    externalTenantId: varchar("external_tenant_id", { length: 255 }),
    secretRef: text("secret_ref"),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    syncCursor: text("sync_cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("integration_connections_org_provider_tenant_unique")
      .on(table.organizationId, table.provider, table.externalTenantId)
      .where(sql`${table.externalTenantId} is not null`),
    index("integration_connections_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const integrationSources = pgTable(
  "integration_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    connectionId: uuid("connection_id").references(() => integrationConnections.id, {
      onDelete: "cascade",
    }),
    provider: varchar("provider", { length: 64 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    externalSourceId: varchar("external_source_id", { length: 255 }),
    name: varchar("name", { length: 255 }).notNull(),
    currency: varchar("currency", { length: 3 }),
    ledgerAccountId: uuid("ledger_account_id").references(() => accounts.id),
    importStartDate: date("import_start_date"),
    status: varchar("status", { length: 32 }).default("active").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("integration_sources_org_provider_external_unique")
      .on(table.organizationId, table.provider, table.externalSourceId)
      .where(sql`${table.externalSourceId} is not null`),
    index("integration_sources_org_channel_idx").on(table.organizationId, table.channel),
  ],
);

export const integrationSyncRuns = pgTable(
  "integration_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    connectionId: uuid("connection_id")
      .references(() => integrationConnections.id, { onDelete: "cascade" })
      .notNull(),
    runType: varchar("run_type", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).default("running").notNull(),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    counts: jsonb("counts").$type<Record<string, number>>().default({}).notNull(),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("integration_sync_runs_connection_started_idx").on(table.connectionId, table.startedAt),
  ],
);

export const ingestionEvents = pgTable(
  "ingestion_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    connectionId: uuid("connection_id").references(() => integrationConnections.id, {
      onDelete: "set null",
    }),
    sourceId: uuid("source_id").references(() => integrationSources.id, {
      onDelete: "set null",
    }),
    channel: varchar("channel", { length: 32 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }),
    externalObjectId: varchar("external_object_id", { length: 255 }),
    externalVersion: varchar("external_version", { length: 128 }),
    payloadHash: varchar("payload_hash", { length: 64 }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    headers: jsonb("headers").$type<Record<string, string>>(),
    rawObjectKey: text("raw_object_key"),
    status: varchar("status", { length: 32 }).default("received").notNull(),
    correlationId: uuid("correlation_id").defaultRandom().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("ingestion_events_org_provider_event_unique")
      .on(table.organizationId, table.provider, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`),
    index("ingestion_events_org_status_received_idx").on(
      table.organizationId,
      table.status,
      table.receivedAt,
    ),
  ],
);

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    ingestionEventId: uuid("ingestion_event_id").references(() => ingestionEvents.id, {
      onDelete: "cascade",
    }),
    jobType: varchar("job_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 24 }).default("queued").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 255 }),
    correlationId: uuid("correlation_id").defaultRandom().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(8).notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    lockedBy: varchar("locked_by", { length: 128 }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("processing_jobs_org_dedupe_unique")
      .on(table.organizationId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null and ${table.status} in ('queued', 'running')`),
    index("processing_jobs_claim_idx").on(table.status, table.runAt, table.lockedUntil),
    index("processing_jobs_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const sourceRecords = pgTable(
  "source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: uuid("source_id").references(() => integrationSources.id, {
      onDelete: "set null",
    }),
    ingestionEventId: uuid("ingestion_event_id").references(() => ingestionEvents.id, {
      onDelete: "set null",
    }),
    parentSourceRecordId: uuid("parent_source_record_id").references(
      (): AnyPgColumn => sourceRecords.id,
      { onDelete: "set null" },
    ),
    recordType: varchar("record_type", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 255 }),
    externalVersion: varchar("external_version", { length: 128 }).default("1").notNull(),
    providerStatus: varchar("provider_status", { length: 64 }),
    recordState: varchar("record_state", { length: 24 }).default("active").notNull(),
    transactionDate: date("transaction_date"),
    description: text("description"),
    amount: decimal("amount", { precision: 20, scale: 8 }),
    currency: varchar("currency", { length: 3 }),
    economicEventClass: varchar("economic_event_class", { length: 32 }).default("other").notNull(),
    direction: varchar("direction", { length: 16 }).default("unknown").notNull(),
    originalAmount: decimal("original_amount", { precision: 20, scale: 8 }),
    originalCurrency: varchar("original_currency", { length: 3 }),
    functionalAmount: decimal("functional_amount", { precision: 20, scale: 8 }),
    functionalCurrency: varchar("functional_currency", { length: 3 }),
    effectiveDate: date("effective_date"),
    normalizedParty: varchar("normalized_party", { length: 255 }),
    normalizedReference: varchar("normalized_reference", { length: 255 }),
    sourceAccountRef: varchar("source_account_ref", { length: 255 }),
    matcherInputHash: varchar("matcher_input_hash", { length: 64 }),
    matcherVersion: integer("matcher_version").default(1).notNull(),
    rawData: jsonb("raw_data").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("source_records_org_source_external_unique")
      .on(table.organizationId, table.sourceId, table.externalId)
      .where(
        sql`${table.sourceId} is not null and ${table.externalId} is not null and ${table.recordState} <> 'superseded'`,
      ),
    index("source_records_org_date_idx").on(table.organizationId, table.transactionDate),
    index("source_records_parent_idx").on(table.parentSourceRecordId),
    index("source_records_duplicate_lookup_idx")
      .on(
        table.organizationId,
        table.originalCurrency,
        table.originalAmount,
        table.direction,
        table.effectiveDate,
      )
      .where(sql`${table.recordState} = 'active'`),
    check(
      "source_records_record_state_check",
      sql`${table.recordState} in ('active', 'rejected', 'superseded')`,
    ),
    check(
      "source_records_direction_check",
      sql`${table.direction} in ('inflow', 'outflow', 'neutral', 'unknown')`,
    ),
    check(
      "source_records_economic_event_class_check",
      sql`${table.economicEventClass} in (
        'purchase',
        'sale',
        'bill_accrual',
        'bill_payment',
        'invoice_accrual',
        'invoice_payment',
        'transfer',
        'payroll',
        'other'
      )`,
    ),
  ],
);

export const sourceRecordVersions = pgTable(
  "source_record_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    sourceRecordId: uuid("source_record_id")
      .references(() => sourceRecords.id, { onDelete: "cascade" })
      .notNull(),
    ingestionEventId: uuid("ingestion_event_id").references(() => ingestionEvents.id, {
      onDelete: "set null",
    }),
    externalVersion: varchar("external_version", { length: 128 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }),
    providerStatus: varchar("provider_status", { length: 64 }),
    rawData: jsonb("raw_data").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("source_record_versions_source_version_unique").on(
      table.sourceRecordId,
      table.externalVersion,
    ),
    index("source_record_versions_org_created_idx").on(table.organizationId, table.createdAt),
    index("source_record_versions_ingestion_event_idx").on(table.ingestionEventId),
  ],
);

export const sourceRecordDocuments = pgTable(
  "source_record_documents",
  {
    sourceRecordId: uuid("source_record_id")
      .references(() => sourceRecords.id, { onDelete: "cascade" })
      .notNull(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    relationship: varchar("relationship", { length: 32 }).default("evidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceRecordId, table.documentId] }),
    index("source_record_documents_org_idx").on(table.organizationId),
  ],
);

export const transactionCandidates = pgTable(
  "transaction_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "set null",
    }),
    requestIdempotencyKey: varchar("request_idempotency_key", { length: 255 }),
    revision: integer("revision").default(1).notNull(),
    status: varchar("status", { length: 24 }).default("current").notNull(),
    candidateType: varchar("candidate_type", { length: 32 }).default("transaction").notNull(),
    transactionDate: date("transaction_date").notNull(),
    transactionType: varchar("transaction_type", { length: 24 }).notNull(),
    memo: text("memo"),
    referenceNumber: varchar("reference_number", { length: 100 }),
    partyId: uuid("party_id").references(() => parties.id),
    originalCurrency: varchar("original_currency", { length: 3 }).notNull(),
    functionalCurrency: varchar("functional_currency", { length: 3 }).notNull(),
    exchangeRateId: uuid("exchange_rate_id").references(() => fxRates.id),
    exchangeRate: decimal("exchange_rate", { precision: 20, scale: 10 }).default("1").notNull(),
    originalTotal: decimal("original_total", { precision: 20, scale: 8 }),
    functionalTotal: decimal("functional_total", { precision: 20, scale: 8 }),
    submittedBy: text("submitted_by").references(() => user.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    supersededById: uuid("superseded_by_id"),
    postedJournalHeaderId: uuid("posted_journal_header_id").references(() => journalHeaders.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("transaction_candidates_org_request_idempotency_unique")
      .on(table.organizationId, table.requestIdempotencyKey)
      .where(sql`${table.requestIdempotencyKey} is not null`),
    index("transaction_candidates_org_status_idx").on(table.organizationId, table.status),
    index("transaction_candidates_source_record_idx").on(table.sourceRecordId),
  ],
);

export const transactionCandidateSources = pgTable(
  "transaction_candidate_sources",
  {
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id")
      .references(() => transactionCandidates.id, { onDelete: "cascade" })
      .notNull(),
    sourceRecordId: uuid("source_record_id")
      .references(() => sourceRecords.id, { onDelete: "restrict" })
      .notNull(),
    relationship: varchar("relationship", { length: 24 }).default("origin").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.candidateId, table.sourceRecordId] }),
    uniqueIndex("transaction_candidate_sources_primary_unique")
      .on(table.candidateId)
      .where(sql`${table.isPrimary} = true`),
    index("transaction_candidate_sources_org_source_idx").on(
      table.organizationId,
      table.sourceRecordId,
    ),
    check(
      "transaction_candidate_sources_relationship_check",
      sql`${table.relationship} in ('origin', 'supporting', 'corroborating')`,
    ),
  ],
);

export const transactionCandidateLines = pgTable(
  "transaction_candidate_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id")
      .references(() => transactionCandidates.id, { onDelete: "cascade" })
      .notNull(),
    accountId: uuid("account_id").references(() => accounts.id),
    originalDebit: decimal("original_debit", { precision: 20, scale: 8 }),
    originalCredit: decimal("original_credit", { precision: 20, scale: 8 }),
    functionalDebit: decimal("functional_debit", { precision: 20, scale: 8 }),
    functionalCredit: decimal("functional_credit", { precision: 20, scale: 8 }),
    originalCurrency: varchar("original_currency", { length: 3 }).notNull(),
    exchangeRate: decimal("exchange_rate", { precision: 20, scale: 10 }).default("1").notNull(),
    lineDescription: text("line_description"),
    partyId: uuid("party_id").references(() => parties.id),
    departmentId: uuid("department_id").references(() => dimensions.id),
    locationId: uuid("location_id").references(() => dimensions.id),
    categoryConfidence: decimal("category_confidence", { precision: 5, scale: 4 }),
    predictionEvidence: jsonb("prediction_evidence").$type<Record<string, unknown>>(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("transaction_candidate_lines_candidate_idx").on(table.candidateId, table.sortOrder),
    index("transaction_candidate_lines_org_account_idx").on(table.organizationId, table.accountId),
  ],
);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id").references(() => transactionCandidates.id, {
      onDelete: "cascade",
    }),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "set null",
    }),
    itemType: varchar("item_type", { length: 48 }).default("approve_transaction").notNull(),
    state: varchar("state", { length: 32 }).default("ready_for_review").notNull(),
    priority: varchar("priority", { length: 16 }).default("normal").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    assigneeId: text("assignee_id").references(() => user.id),
    submittedBy: text("submitted_by").references(() => user.id),
    candidateRevision: integer("candidate_revision").default(1).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    lockVersion: integer("lock_version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("inbox_items_candidate_unique")
      .on(table.candidateId)
      .where(sql`${table.candidateId} is not null`),
    index("inbox_items_org_state_created_idx").on(
      table.organizationId,
      table.state,
      table.createdAt,
    ),
    index("inbox_items_assignee_state_idx").on(table.assigneeId, table.state),
  ],
);

export const inboxWatchers = pgTable(
  "inbox_watchers",
  {
    inboxItemId: uuid("inbox_item_id")
      .references(() => inboxItems.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.inboxItemId, table.userId] }),
    index("inbox_watchers_user_idx").on(table.userId),
  ],
);

export const reviewRuleDefinitions = pgTable("review_rule_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  group: varchar("group_name", { length: 16 }).notNull(),
  evaluatorKey: varchar("evaluator_key", { length: 64 }).notNull(),
  defaultConfig: jsonb("default_config").$type<Record<string, unknown>>().default({}).notNull(),
  formulaVersion: integer("formula_version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const reviewRuleConfigs = pgTable(
  "review_rule_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    definitionId: uuid("definition_id")
      .references(() => reviewRuleDefinitions.id, { onDelete: "cascade" })
      .notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    impact: varchar("impact", { length: 16 }).notNull(),
    lookbackMonths: integer("lookback_months").default(3).notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    version: integer("version").default(1).notNull(),
    updatedBy: text("updated_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("review_rule_configs_org_definition_unique").on(
      table.organizationId,
      table.definitionId,
    ),
  ],
);

export const reviewRuleRuns = pgTable(
  "review_rule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    ruleConfigId: uuid("rule_config_id").references(() => reviewRuleConfigs.id, {
      onDelete: "set null",
    }),
    trigger: varchar("trigger", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).default("running").notNull(),
    windowStart: date("window_start").notNull(),
    windowEnd: date("window_end").notNull(),
    asOfDate: date("as_of_date").notNull(),
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().default({}).notNull(),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("review_rule_runs_org_started_idx").on(table.organizationId, table.startedAt)],
);

export const reviewFindings = pgTable(
  "review_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    inboxItemId: uuid("inbox_item_id").references(() => inboxItems.id, {
      onDelete: "cascade",
    }),
    candidateId: uuid("candidate_id").references(() => transactionCandidates.id, {
      onDelete: "cascade",
    }),
    ruleConfigId: uuid("rule_config_id").references(() => reviewRuleConfigs.id, {
      onDelete: "set null",
    }),
    ruleRunId: uuid("rule_run_id").references(() => reviewRuleRuns.id, {
      onDelete: "set null",
    }),
    ruleKey: varchar("rule_key", { length: 64 }).notNull(),
    impact: varchar("impact", { length: 16 }).notNull(),
    state: varchar("state", { length: 24 }).default("open").notNull(),
    subjectType: varchar("subject_type", { length: 32 }).notNull(),
    subjectId: uuid("subject_id"),
    fingerprint: varchar("fingerprint", { length: 255 }).notNull(),
    message: text("message").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    formulaVersion: integer("formula_version").default(1).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
  },
  (table) => [
    uniqueIndex("review_findings_org_fingerprint_unique").on(
      table.organizationId,
      table.fingerprint,
    ),
    index("review_findings_inbox_state_idx").on(table.inboxItemId, table.state),
    index("review_findings_org_rule_state_idx").on(
      table.organizationId,
      table.ruleKey,
      table.state,
    ),
  ],
);

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    inboxItemId: uuid("inbox_item_id")
      .references(() => inboxItems.id, { onDelete: "cascade" })
      .notNull(),
    decision: varchar("decision", { length: 32 }).notNull(),
    actorId: text("actor_id")
      .references(() => user.id)
      .notNull(),
    candidateRevision: integer("candidate_revision").notNull(),
    reason: text("reason"),
    beforeState: varchar("before_state", { length: 32 }).notNull(),
    afterState: varchar("after_state", { length: 32 }).notNull(),
    journalHeaderId: uuid("journal_header_id").references(() => journalHeaders.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("review_decisions_inbox_created_idx").on(table.inboxItemId, table.createdAt)],
);

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    inboxItemId: uuid("inbox_item_id").references(() => inboxItems.id, {
      onDelete: "cascade",
    }),
    entityType: varchar("entity_type", { length: 48 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    action: varchar("action", { length: 48 }).notNull(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: text("actor_id"),
    correlationId: uuid("correlation_id").defaultRandom().notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workflow_events_org_idempotency_unique")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("workflow_events_entity_created_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

export const sourceMatchCandidates = pgTable(
  "source_match_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    leftSourceRecordId: uuid("left_source_record_id")
      .references(() => sourceRecords.id, { onDelete: "cascade" })
      .notNull(),
    rightSourceRecordId: uuid("right_source_record_id")
      .references(() => sourceRecords.id, { onDelete: "cascade" })
      .notNull(),
    matchType: varchar("match_type", { length: 16 }).notNull(),
    confidence: decimal("confidence", { precision: 5, scale: 4 }),
    matchClass: varchar("match_class", { length: 24 }).default("duplicate").notNull(),
    disposition: varchar("disposition", { length: 16 }).default("blocking").notNull(),
    score: decimal("score", { precision: 5, scale: 2 }).default("0").notNull(),
    state: varchar("state", { length: 24 }).default("open").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    signals: jsonb("signals").$type<Record<string, unknown>>().default({}).notNull(),
    algorithmVersion: integer("algorithm_version").default(1).notNull(),
    leftInputHash: varchar("left_input_hash", { length: 64 }),
    rightInputHash: varchar("right_input_hash", { length: 64 }),
    lockVersion: integer("lock_version").default(1).notNull(),
    resolutionAction: varchar("resolution_action", { length: 32 }),
    canonicalCandidateId: uuid("canonical_candidate_id").references(
      () => transactionCandidates.id,
      { onDelete: "set null" },
    ),
    canonicalJournalHeaderId: uuid("canonical_journal_header_id").references(
      () => journalHeaders.id,
      { onDelete: "set null" },
    ),
    resolutionReason: text("resolution_reason"),
    resolutionIdempotencyKey: varchar("resolution_idempotency_key", { length: 255 }),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("source_match_candidates_pair_unique").on(
      table.organizationId,
      table.leftSourceRecordId,
      table.rightSourceRecordId,
    ),
    uniqueIndex("source_match_candidates_org_resolution_idempotency_unique")
      .on(table.organizationId, table.resolutionIdempotencyKey)
      .where(sql`${table.resolutionIdempotencyKey} is not null`),
    index("source_match_candidates_org_state_idx").on(
      table.organizationId,
      table.state,
      table.createdAt,
    ),
    index("source_match_candidates_left_source_idx").on(table.leftSourceRecordId),
    index("source_match_candidates_right_source_idx").on(table.rightSourceRecordId),
    check(
      "source_match_candidates_canonical_pair_check",
      sql`${table.leftSourceRecordId} < ${table.rightSourceRecordId}`,
    ),
    check(
      "source_match_candidates_score_range_check",
      sql`${table.score} >= 0 and ${table.score} <= 100`,
    ),
    check(
      "source_match_candidates_match_class_check",
      sql`${table.matchClass} in ('duplicate', 'related')`,
    ),
    check(
      "source_match_candidates_disposition_check",
      sql`${table.disposition} in ('blocking', 'shadow')`,
    ),
    check(
      "source_match_candidates_resolution_action_check",
      sql`${table.resolutionAction} is null or ${table.resolutionAction} in (
        'consolidate_candidates',
        'attach_to_posted',
        'keep_separate',
        'merge_posted',
        'reject_source'
      )`,
    ),
  ],
);

export const ledgerSourceLinks = pgTable(
  "ledger_source_links",
  {
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    journalHeaderId: uuid("journal_header_id")
      .references(() => journalHeaders.id, { onDelete: "cascade" })
      .notNull(),
    sourceRecordId: uuid("source_record_id")
      .references(() => sourceRecords.id, { onDelete: "restrict" })
      .notNull(),
    relationship: varchar("relationship", { length: 24 }).default("origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.journalHeaderId, table.sourceRecordId] }),
    uniqueIndex("ledger_source_links_origin_source_unique")
      .on(table.organizationId, table.sourceRecordId)
      .where(sql`${table.relationship} = 'origin'`),
    index("ledger_source_links_org_source_idx").on(table.organizationId, table.sourceRecordId),
  ],
);
