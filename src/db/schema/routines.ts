/**
 * Routines — how source papers get into the Inbox (Inbox v2 spec §3).
 *
 * A routine is org configuration: a trigger (`webhook`, `schedule`, or later
 * `integration`) plus the settings that trigger needs. Every ingestion event
 * and processing job a routine produces carries its `routine_id`, so a paper
 * can always be traced back to the routine that brought it in.
 *
 * Inbound email is the first webhook routine: each organization gets one
 * system-provisioned `resend` routine the first time an email arrives for it.
 *
 * Rule snapshots (spec §6): `rule_snapshot_id` pins the immutable rule pack the
 * routine's papers are evaluated against (null = the organization's live
 * review_rule_configs), and `shadow_rule_snapshot_id` names a second pack that
 * is evaluated alongside it and logged, never enforced. Both reference
 * `rule_snapshots` ON DELETE RESTRICT, so a pinned or shadowed snapshot cannot
 * disappear underneath a routine.
 *
 * Export/import: routines are org configuration, exported since version 5
 * (src/lib/export-inbox.ts) without their runtime state (cursor, run times,
 * last error). `routine_secrets` is never exported: an imported signed webhook
 * arrives disabled with no secret.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { ruleSnapshots } from "./rule-snapshots";

export type RoutineTriggerKind = "webhook" | "schedule" | "integration";

export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    triggerKind: varchar("trigger_kind", { length: 32 }).$type<RoutineTriggerKind>().notNull(),
    triggerConfig: jsonb("trigger_config").$type<Record<string, unknown>>().default({}).notNull(),
    // The pinned rule snapshot (spec §6); null evaluates against live configs.
    ruleSnapshotId: uuid("rule_snapshot_id").references(() => ruleSnapshots.id, {
      onDelete: "restrict",
    }),
    // A snapshot evaluated in shadow: its findings are logged as workflow
    // events and never become review findings.
    shadowRuleSnapshotId: uuid("shadow_rule_snapshot_id").references(() => ruleSnapshots.id, {
      onDelete: "restrict",
    }),
    maxConcurrentRuns: integer("max_concurrent_runs").default(1).notNull(),
    cursor: text("cursor"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    // Null for system-provisioned routines (the inbound email routine).
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("routines_schedule_due_idx")
      .on(table.organizationId, table.enabled, table.nextRunAt)
      .where(sql`${table.triggerKind} = 'schedule' and ${table.enabled}`),
    // One inbound email routine per organization. The routine is provisioned
    // lazily by the Resend webhook, so two emails racing for a brand-new org
    // must converge on one row rather than each creating their own.
    uniqueIndex("routines_org_inbound_email_unique")
      .on(table.organizationId)
      .where(
        sql`${table.triggerKind} = 'webhook' and ${table.triggerConfig} ->> 'provider' = 'resend'`,
      ),
    check(
      "routines_trigger_kind_check",
      sql`${table.triggerKind} in ('webhook', 'schedule', 'integration')`,
    ),
    check("routines_max_concurrent_runs_check", sql`${table.maxConcurrentRuns} >= 1`),
  ],
);

/**
 * Per-routine webhook signing secrets, encrypted at rest with the shared
 * envelope in src/lib/crypto.ts (SECRETS_ENCRYPTION_KEY).
 *
 * A routine's `trigger_config.secret_ref` names the row here; the ciphertext
 * itself never enters `trigger_config`, so neither a routine read nor a future
 * export can carry it. Read exclusively through src/lib/routines/secrets.ts.
 */
export const routineSecrets = pgTable(
  "routine_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    routineId: uuid("routine_id")
      .references(() => routines.id, { onDelete: "cascade" })
      .notNull(),
    secretEnc: text("secret_enc").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("routine_secrets_routine_unique").on(table.routineId)],
);
