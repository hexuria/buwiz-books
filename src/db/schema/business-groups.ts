/**
 * Enterprise Business Groups
 *
 * Business Groups deliberately live above Better Auth organizations. An
 * enterprise account may link many organizations, while every linked
 * organization keeps its existing membership and accounting boundary.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { member, organization, user } from "./auth";

export type EnterpriseAccountRole = "owner" | "billing_admin" | "group_admin";
export type EntitlementStatus = "pending" | "active" | "grace" | "locked" | "cancelled";
export type EntitlementFeatureKey = "business_groups";
export type BusinessGroupRole = "owner" | "admin" | "analyst" | "viewer";
export type EnterpriseBillingWebhookStatus = "received" | "processed" | "ignored" | "failed";
export type EnterpriseBillingCheckoutStatus =
  | "creating"
  | "open"
  | "completed"
  | "consumed"
  | "expired";

export const enterpriseAccounts = pgTable(
  "enterprise_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    billingContactEmail: varchar("billing_contact_email", { length: 320 }),
    externalCustomerId: varchar("external_customer_id", { length: 255 }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("enterprise_accounts_status_check", sql`${table.status} in ('active', 'suspended')`),
    uniqueIndex("enterprise_accounts_external_customer_unique")
      .on(table.externalCustomerId)
      .where(sql`${table.externalCustomerId} is not null`),
  ],
);

export const enterpriseAccountMembers = pgTable(
  "enterprise_account_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).$type<EnterpriseAccountRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("enterprise_account_members_account_user_unique").on(
      table.enterpriseAccountId,
      table.userId,
    ),
    index("enterprise_account_members_user_idx").on(table.userId, table.enterpriseAccountId),
    check(
      "enterprise_account_members_role_check",
      sql`${table.role} in ('owner', 'billing_admin', 'group_admin')`,
    ),
  ],
);

export const accountEntitlements = pgTable(
  "account_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    featureKey: varchar("feature_key", { length: 64 }).$type<EntitlementFeatureKey>().notNull(),
    status: varchar("status", { length: 24 }).$type<EntitlementStatus>().notNull(),
    includedEntityLimit: integer("included_entity_limit").notNull(),
    provisioningSource: varchar("provisioning_source", { length: 32 })
      .default("contract")
      .notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("account_entitlements_account_feature_unique").on(
      table.enterpriseAccountId,
      table.featureKey,
    ),
    index("account_entitlements_state_idx").on(table.featureKey, table.status, table.endsAt),
    check(
      "account_entitlements_status_check",
      sql`${table.status} in ('pending', 'active', 'grace', 'locked', 'cancelled')`,
    ),
    check("account_entitlements_limit_check", sql`${table.includedEntityLimit} > 0`),
    check("account_entitlements_version_check", sql`${table.version} > 0`),
    check(
      "account_entitlements_grace_dates_check",
      sql`${table.graceEndsAt} is null or ${table.endsAt} is null or ${table.graceEndsAt} >= ${table.endsAt}`,
    ),
  ],
);

export const entitlementEvents = pgTable(
  "entitlement_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    entitlementId: uuid("entitlement_id")
      .notNull()
      .references(() => accountEntitlements.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    reason: text("reason"),
    previousState: jsonb("previous_state").$type<Record<string, unknown> | null>(),
    nextState: jsonb("next_state").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("entitlement_events_account_created_idx").on(table.enterpriseAccountId, table.createdAt),
  ],
);

/** Provider state mirrored for entitlement reconciliation; secrets never live here. */
export const enterpriseBillingSubscriptions = pgTable(
  "enterprise_billing_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 24 }).default("stripe").notNull(),
    externalCustomerId: varchar("external_customer_id", { length: 255 }).notNull(),
    externalSubscriptionId: varchar("external_subscription_id", { length: 255 }).notNull(),
    externalPriceId: varchar("external_price_id", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull(),
    providerStatus: varchar("provider_status", { length: 32 }).notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    lastProviderEventCreatedAt: timestamp("last_provider_event_created_at", {
      withTimezone: true,
    }).notNull(),
    lastProviderEventId: varchar("last_provider_event_id", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("enterprise_billing_subscriptions_account_unique").on(table.enterpriseAccountId),
    uniqueIndex("enterprise_billing_subscriptions_customer_unique").on(table.externalCustomerId),
    uniqueIndex("enterprise_billing_subscriptions_subscription_unique").on(
      table.externalSubscriptionId,
    ),
    check("enterprise_billing_subscriptions_provider_check", sql`${table.provider} = 'stripe'`),
    check("enterprise_billing_subscriptions_quantity_check", sql`${table.quantity} > 0`),
    check(
      "enterprise_billing_subscriptions_period_check",
      sql`${table.currentPeriodEnd} > ${table.currentPeriodStart}`,
    ),
  ],
);

/** One resumable Stripe Checkout reservation per Enterprise account. */
export const enterpriseBillingCheckoutSessions = pgTable(
  "enterprise_billing_checkout_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestedQuantity: integer("requested_quantity").notNull(),
    externalPriceId: varchar("external_price_id", { length: 255 }).notNull(),
    externalCustomerId: varchar("external_customer_id", { length: 255 }),
    customerEmail: varchar("customer_email", { length: 320 }),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    status: varchar("status", { length: 24 })
      .$type<EnterpriseBillingCheckoutStatus>()
      .default("creating")
      .notNull(),
    providerSessionId: varchar("provider_session_id", { length: 255 }),
    providerSessionUrl: text("provider_session_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("enterprise_billing_checkout_sessions_provider_unique")
      .on(table.providerSessionId)
      .where(sql`${table.providerSessionId} is not null`),
    uniqueIndex("enterprise_billing_checkout_sessions_active_account_unique")
      .on(table.enterpriseAccountId)
      .where(sql`${table.status} in ('creating', 'open', 'completed')`),
    index("enterprise_billing_checkout_sessions_account_created_idx").on(
      table.enterpriseAccountId,
      table.createdAt,
    ),
    check(
      "enterprise_billing_checkout_sessions_status_check",
      sql`${table.status} in ('creating', 'open', 'completed', 'consumed', 'expired')`,
    ),
    check(
      "enterprise_billing_checkout_sessions_quantity_check",
      sql`${table.requestedQuantity} > 0`,
    ),
  ],
);

/** Durable idempotency and sanitized processing evidence for Stripe deliveries. */
export const enterpriseBillingWebhookEvents = pgTable(
  "enterprise_billing_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 96 }).notNull(),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }).notNull(),
    enterpriseAccountId: uuid("enterprise_account_id").references(() => enterpriseAccounts.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 24 })
      .$type<EnterpriseBillingWebhookStatus>()
      .default("received")
      .notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("enterprise_billing_webhook_events_provider_event_unique").on(
      table.providerEventId,
    ),
    index("enterprise_billing_webhook_events_account_received_idx").on(
      table.enterpriseAccountId,
      table.receivedAt,
    ),
    check(
      "enterprise_billing_webhook_events_status_check",
      sql`${table.status} in ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
);

export const organizationGroups = pgTable(
  "organization_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    reportingTimezone: varchar("reporting_timezone", { length: 64 }).default("UTC").notNull(),
    defaultReportingCurrency: varchar("default_reporting_currency", { length: 3 })
      .default("USD")
      .notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("organization_groups_account_id_unique").on(table.enterpriseAccountId, table.id),
    index("organization_groups_account_idx").on(table.enterpriseAccountId, table.status),
    check(
      "organization_groups_name_check",
      sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 2 and 255`,
    ),
    check("organization_groups_status_check", sql`${table.status} in ('active', 'archived')`),
    check(
      "organization_groups_currency_check",
      sql`${table.defaultReportingCurrency} = upper(${table.defaultReportingCurrency}) and length(${table.defaultReportingCurrency}) = 3`,
    ),
  ],
);

export const organizationGroupMembers = pgTable(
  "organization_group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => organizationGroups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 24 }).$type<BusinessGroupRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("organization_group_members_group_user_unique").on(table.groupId, table.userId),
    index("organization_group_members_user_idx").on(table.userId, table.groupId),
    check(
      "organization_group_members_role_check",
      sql`${table.role} in ('owner', 'admin', 'analyst', 'viewer')`,
    ),
  ],
);

export const organizationGroupEntities = pgTable(
  "organization_group_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id").notNull(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => organizationGroups.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 24 }).default("enabled").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.enterpriseAccountId, table.groupId],
      foreignColumns: [organizationGroups.enterpriseAccountId, organizationGroups.id],
      name: "organization_group_entities_account_group_fk",
    }).onDelete("cascade"),
    uniqueIndex("organization_group_entities_group_org_unique").on(
      table.groupId,
      table.organizationId,
    ),
    uniqueIndex("organization_group_entities_account_org_enabled_unique")
      .on(table.enterpriseAccountId, table.organizationId)
      .where(sql`${table.status} = 'enabled'`),
    index("organization_group_entities_org_idx").on(table.organizationId),
    check(
      "organization_group_entities_status_check",
      sql`${table.status} in ('enabled', 'disabled')`,
    ),
  ],
);

export const organizationGroupAuditEvents = pgTable(
  "organization_group_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enterpriseAccountId: uuid("enterprise_account_id")
      .notNull()
      .references(() => enterpriseAccounts.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => organizationGroups.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    subjectType: varchar("subject_type", { length: 32 }).notNull(),
    subjectId: text("subject_id"),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("organization_group_audit_group_created_idx").on(table.groupId, table.createdAt),
    index("organization_group_audit_account_created_idx").on(
      table.enterpriseAccountId,
      table.createdAt,
    ),
  ],
);

// Exported only to make the direct-membership invariant discoverable from the
// schema module. Group membership does not replace this Better Auth membership.
export const organizationMembershipTable = member;
