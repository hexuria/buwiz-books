/**
 * Organization-scoped financial reporting projections.
 *
 * The facts deliberately store raw account/day debit and credit activity. A
 * report joins the projection-owned account dimension when it classifies those
 * facts. Account mutations enqueue a metadata sync, so renaming or
 * reclassifying an account does not require rewriting daily activity.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { organization } from "./auth";

export type ReportingProjectionStatus = "pending" | "building" | "ready" | "failed";

export const organizationReportingAccounts = pgTable(
  "organization_reporting_accounts",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    accountName: varchar("account_name", { length: 255 }).notNull(),
    accountNumber: varchar("account_number", { length: 10 }),
    accountType: varchar("account_type", { length: 50 }).notNull(),
    subtype: varchar("subtype", { length: 100 }),
    parentId: uuid("parent_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.accountId] }),
    index("organization_reporting_accounts_org_number_idx").on(
      table.organizationId,
      table.accountNumber,
    ),
  ],
);

export const organizationDailyAccountActivity = pgTable(
  "organization_daily_account_activity",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    activityDate: date("activity_date").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    totalDebit: decimal("total_debit", { precision: 20, scale: 8 }).default("0").notNull(),
    totalCredit: decimal("total_credit", { precision: 20, scale: 8 }).default("0").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.activityDate, table.accountId] }),
    index("organization_daily_account_activity_org_account_date_idx").on(
      table.organizationId,
      table.accountId,
      table.activityDate,
    ),
  ],
);

export const organizationReportingDirtyDates = pgTable(
  "organization_reporting_dirty_dates",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    activityDate: date("activity_date").notNull(),
    version: integer("version").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.activityDate] }),
    index("organization_reporting_dirty_dates_marked_idx").on(table.markedAt),
    check("organization_reporting_dirty_dates_version_check", sql`${table.version} > 0`),
  ],
);

export const organizationReportingProjectionState = pgTable(
  "organization_reporting_projection_state",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 24 })
      .$type<ReportingProjectionStatus>()
      .default("pending")
      .notNull(),
    requestedVersion: integer("requested_version").default(0).notNull(),
    appliedVersion: integer("applied_version").default(0).notNull(),
    fullRebuildRequested: boolean("full_rebuild_requested").default(false).notNull(),
    lastLedgerEventAt: timestamp("last_ledger_event_at", { withTimezone: true }),
    lastProjectedAt: timestamp("last_projected_at", { withTimezone: true }),
    initialBackfillCompletedAt: timestamp("initial_backfill_completed_at", {
      withTimezone: true,
    }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("organization_reporting_projection_state_status_idx").on(table.status, table.updatedAt),
    check(
      "organization_reporting_projection_state_status_check",
      sql`${table.status} in ('pending', 'building', 'ready', 'failed')`,
    ),
    check(
      "organization_reporting_projection_state_versions_check",
      sql`${table.requestedVersion} >= 0 and ${table.appliedVersion} >= 0 and ${table.appliedVersion} <= ${table.requestedVersion}`,
    ),
  ],
);

/**
 * Durable shadow-mode evidence. Rows are written only when a live-ledger
 * metric differs from the projection beyond the configured tolerance.
 */
export const businessGroupProjectionReconciliationEvents = pgTable(
  "business_group_projection_reconciliation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to").notNull(),
    compareMode: varchar("compare_mode", { length: 24 }).$type<"none" | "prior_period">().notNull(),
    metric: varchar("metric", { length: 64 }).notNull(),
    liveValue: decimal("live_value", { precision: 20, scale: 8 }),
    projectedValue: decimal("projected_value", { precision: 20, scale: 8 }),
    absoluteDifference: decimal("absolute_difference", { precision: 20, scale: 8 }),
    tolerance: decimal("tolerance", { precision: 20, scale: 8 }).notNull(),
    projectionVersion: integer("projection_version").notNull(),
    projectionAsOf: timestamp("projection_as_of", { withTimezone: true }),
    selectedGroupIds: jsonb("selected_group_ids").$type<string[]>().default([]).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("business_group_projection_reconciliation_org_period_idx").on(
      table.organizationId,
      table.dateFrom,
      table.dateTo,
    ),
    index("business_group_projection_reconciliation_observed_idx").on(table.observedAt),
    check(
      "business_group_projection_reconciliation_compare_check",
      sql`${table.compareMode} in ('none', 'prior_period')`,
    ),
    check("business_group_projection_reconciliation_tolerance_check", sql`${table.tolerance} >= 0`),
    check(
      "business_group_projection_reconciliation_difference_check",
      sql`${table.absoluteDifference} is null or ${table.absoluteDifference} >= 0`,
    ),
  ],
);
