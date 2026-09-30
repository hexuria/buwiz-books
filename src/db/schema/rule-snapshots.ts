/**
 * Rule snapshots — immutable, org-scoped rule packs (Inbox v2 spec §6).
 *
 * `review_rule_configs.version` is per row and old versions are not kept, so it
 * cannot serve as a pack. A snapshot freezes the organization's effective rule
 * configuration at one moment, following the `review_rule_runs.config_snapshot`
 * pattern: every configurable rule, its enabled flag, its impact, the config
 * its evaluator reads (org-level threshold fallbacks baked in), and the
 * definition's formula version.
 *
 * Routines pin a snapshot (`routines.rule_snapshot_id`), and may shadow a
 * second one (`routines.shadow_rule_snapshot_id`). The flow is: create a
 * snapshot, replay it on a practice pile (`bun eval:scorecard`), shadow it on
 * live papers, promote it by repinning, and keep the older snapshot for
 * rollback.
 *
 * IMMUTABLE. There is no update path in the application, and migration 0055
 * installs a BEFORE UPDATE trigger that rejects every update. Deletes stay
 * possible at the database level only so an organization's cascade can remove
 * them; a pinned snapshot cannot be deleted (ON DELETE RESTRICT from routines).
 *
 * Export/import: org configuration, exported since version 5
 * (src/lib/export-inbox.ts) with its label, content and exact creation time;
 * import mints new ids and remaps routine pins by (created_at, label).
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

export type RuleSnapshotImpact = "blocking" | "warning";

/** One rule inside a snapshot — the shape spec §6 names. */
export interface RuleSnapshotEntry {
  ruleKey: string;
  enabled: boolean;
  impact: RuleSnapshotImpact;
  config: Record<string, unknown>;
  formulaVersion: number;
}

export const ruleSnapshots = pgTable(
  "rule_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    label: text("label"),
    snapshot: jsonb("snapshot").$type<RuleSnapshotEntry[]>().notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("rule_snapshots_org_created_idx").on(table.organizationId, table.createdAt),
    check("rule_snapshots_snapshot_array_check", sql`jsonb_typeof(${table.snapshot}) = 'array'`),
  ],
);
