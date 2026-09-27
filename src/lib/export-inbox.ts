/**
 * Inbox v2 organization configuration in the versioned export (v5) — the database half.
 *
 * The wire rows, their validators and the pure import decisions are ./export-inbox-rows.ts; the
 * protocol is .agent/rules/schema-export-import.md (category C: new exportable entities). The
 * server functions in src/routes/api/-export-import.ts call these with their org-context
 * executor, and every query here also filters organization_id explicitly.
 *
 * Import, per entity (each row in its own savepoint, so one bad row fails alone):
 *
 *   ruleSnapshots          insert-only, like everywhere else: a new row with the file's label,
 *                          content and exact creation time. A snapshot already here with the same
 *                          (createdAt, label) and content is a duplicate; with different content,
 *                          a conflict. Creator unknown here (null); the import is in activity_logs.
 *   routines               pins remap onto the snapshots imported before them, found by
 *                          (createdAt, label); a pin that cannot be found fails the routine —
 *                          evaluating its papers with other rules would be a silent substitution.
 *                          Signed webhooks arrive disabled with no secret. The organization's one
 *                          inbound email routine is never duplicated. Same name and trigger kind
 *                          as a routine already here is a duplicate.
 *   classificationMemories parties and accounts remap by name and (number, name); a memory whose
 *                          references cannot all be mapped is dropped and reported. The same
 *                          (kind, key) already here is a duplicate: this organization's own memory
 *                          wins. No test-lock eval case is written — there is no source paper here
 *                          to lock the replay against.
 *
 * Disabled routines and memories are exported like enabled ones: "off" is configuration too (a
 * memory that turned itself off after two undos must stay off, and a missing inbound email
 * routine would be provisioned ON by the next email), so Settings' "Include inactive records"
 * switch does not apply to these entities.
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { classificationMemories } from "@/db/schema/classification-memories";
import { parties } from "@/db/schema/parties";
import { routines } from "@/db/schema/routines";
import { ruleSnapshots } from "@/db/schema/rule-snapshots";
import { unresolvedMappingKeys } from "@/lib/coa/chart-readiness";
import { describeMatchKey, type MemoryMatchKind } from "@/lib/inbox/memory/keys";
import { isCrossPartyScope } from "@/lib/inbox/memory/service";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { createLogger } from "@/lib/logger";
import { roleHasPermission } from "@/lib/permission-policy";
import { INBOUND_EMAIL_PROVIDER } from "@/lib/routines/config";
import {
  DUPLICATE_SKIPPED,
  classificationMemoryExportRowSchema,
  describeMemoryRow,
  describeSnapshotRow,
  exportTriggerConfig,
  planMemoryImport,
  planRoutineImport,
  routineExportRowSchema,
  ruleSnapshotExportRowSchema,
  type ClassificationMemoryExportRow,
  type InboxConfigEntityKey,
  type InboxConfigImportResult,
  type MemoryAnswerLineExport,
  type RoutineExportRow,
  type RuleSnapshotExportRow,
  type RuleSnapshotReference,
} from "./export-inbox-rows";

// ────────────────────────────────────────────────────────────────────────────────────────────
// TODO(inbox-v2 step 11 — ai_autonomy_lanes, migration 0060): add the lanes here.
//
// Lanes are organization configuration and join this same v5 bump once step 11 is rebased
// beneath this branch:
//   • entity key "aiAutonomyLanes" (label "AI Autonomy Lanes"): INBOX_CONFIG_ENTITY_KEYS in
//     ./export-inbox-rows.ts, EXPORTABLE_ENTITIES + ENTITY_LABELS in ./export-versions.ts,
//     ENTITY_ENUM in src/routes/api/-export-import.ts, the v4 → v5 empty-array list in
//     ./export-migrations.ts, ExportPanel / ImportPanel, and the round-trip integration test.
//   • export the configuration only: lane_key, doc_kind, the party by NAME (never its uuid),
//     level, amount cap (exact decimal string), and the confidence threshold. No promoted_by /
//     demoted_by user ids.
//   • NEVER export ai_run_feedback: it is the lane's evidence (who agreed with Jev, when), not
//     configuration, and promotion is computed from it.
//   • import: upsert by (lane_key, party, doc_kind); drop and report a lane whose party cannot be
//     mapped, as memories do. Decide in step 11's review whether an imported lane may arrive at
//     "auto": promotion is admin-only and earned on this organization's own history, so arriving
//     at "suggest" (or "watch") is the conservative default.
// ────────────────────────────────────────────────────────────────────────────────────────────

const logger = createLogger("export-inbox");

export interface InboxConfigImportContext {
  db: DbExecutor;
  orgId: string;
  /** The importing user: the actor on every activity-log row the import writes. */
  userId: string;
  role: string;
  now?: Date;
}

export interface InboxConfigListRecord {
  id: string;
  name: string;
  subtitle: string | null;
  extra: string | null;
}

/** Microseconds, UTC — the precision Postgres stores, so the value can identify a row again. */
function exactUtc(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function sameInstant(column: AnyPgColumn, iso: string): SQL {
  return sql`${column} = ${iso}::timestamptz`;
}

function sameLabel(label: string | null): SQL {
  return label === null ? isNull(ruleSnapshots.label) : eq(ruleSnapshots.label, label);
}

/** A row's failure as the import report shows it: never the raw SQL of a failed query. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  if (error.message.includes("Failed query:")) {
    logger.error("Inbox configuration import row failed", { error: error.message });
    return "A database error occurred while importing this row.";
  }
  return error.message;
}

/** Run each row in its own savepoint: a failing row rolls back alone and is reported. */
async function importEachRow<T>(
  db: DbExecutor,
  rows: readonly T[],
  name: (row: T) => string,
  run: (tx: DbExecutor, row: T) => Promise<InboxConfigImportResult>,
): Promise<InboxConfigImportResult[]> {
  const results: InboxConfigImportResult[] = [];
  for (const row of rows) {
    try {
      results.push(await db.transaction((tx) => run(tx, row)));
    } catch (error) {
      results.push({ name: name(row), success: false, error: errorText(error) });
    }
  }
  return results;
}

// ============================================================================
// Rule snapshots
// ============================================================================

export async function exportRuleSnapshots(
  db: DbExecutor,
  orgId: string,
  options: { ids?: readonly string[] } = {},
): Promise<RuleSnapshotExportRow[]> {
  const conditions: SQL[] = [eq(ruleSnapshots.organizationId, orgId)];
  if (options.ids?.length) conditions.push(inArray(ruleSnapshots.id, [...options.ids]));
  return db
    .select({
      id: ruleSnapshots.id,
      label: ruleSnapshots.label,
      snapshot: ruleSnapshots.snapshot,
      createdAt: exactUtc(ruleSnapshots.createdAt),
    })
    .from(ruleSnapshots)
    .where(and(...conditions))
    .orderBy(asc(ruleSnapshots.createdAt), asc(ruleSnapshots.id));
}

export async function importRuleSnapshots(
  ctx: InboxConfigImportContext,
  rows: readonly RuleSnapshotExportRow[],
): Promise<InboxConfigImportResult[]> {
  return importEachRow(ctx.db, rows, describeSnapshotRow, async (tx, row) => {
    const name = describeSnapshotRow(row);
    const existing = await tx
      .select({
        id: ruleSnapshots.id,
        sameContent: sql<boolean>`${ruleSnapshots.snapshot} = ${JSON.stringify(row.snapshot)}::jsonb`,
      })
      .from(ruleSnapshots)
      .where(
        and(
          eq(ruleSnapshots.organizationId, ctx.orgId),
          sameInstant(ruleSnapshots.createdAt, row.createdAt),
          sameLabel(row.label),
        ),
      );
    if (existing.some((snapshot) => snapshot.sameContent)) {
      return { name, success: true, error: DUPLICATE_SKIPPED };
    }
    if (existing.length > 0) {
      return {
        name,
        success: false,
        error:
          "A different rule snapshot with this label and creation time is already here; snapshots are never overwritten.",
      };
    }
    const [created] = await tx
      .insert(ruleSnapshots)
      .values({
        organizationId: ctx.orgId,
        label: row.label,
        snapshot: row.snapshot,
        createdBy: null,
        createdAt: sql`${row.createdAt}::timestamptz`,
      })
      .returning({ id: ruleSnapshots.id });
    await insertActivityLog(
      {
        orgId: ctx.orgId,
        entityType: "rule_snapshot",
        entityId: created.id,
        action: "rule_snapshot_imported",
        actorId: ctx.userId,
        changes: {
          label: { old: null, new: row.label },
          ruleCount: { old: null, new: row.snapshot.length },
          importedFrom: { old: null, new: row.id },
        },
      },
      tx,
    );
    return { name, success: true };
  });
}

// ============================================================================
// Routines
// ============================================================================

export async function exportRoutines(
  db: DbExecutor,
  orgId: string,
  options: { ids?: readonly string[] } = {},
): Promise<RoutineExportRow[]> {
  const conditions: SQL[] = [eq(routines.organizationId, orgId)];
  if (options.ids?.length) conditions.push(inArray(routines.id, [...options.ids]));
  const rows = await db
    .select({
      name: routines.name,
      enabled: routines.enabled,
      triggerKind: routines.triggerKind,
      triggerConfig: routines.triggerConfig,
      maxConcurrentRuns: routines.maxConcurrentRuns,
      ruleSnapshotId: routines.ruleSnapshotId,
      shadowRuleSnapshotId: routines.shadowRuleSnapshotId,
    })
    .from(routines)
    .where(and(...conditions))
    .orderBy(asc(routines.createdAt), asc(routines.id));

  const pinnedIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.ruleSnapshotId, row.shadowRuleSnapshotId].filter((id): id is string => id !== null),
      ),
    ),
  ];
  const pinned =
    pinnedIds.length > 0
      ? await db
          .select({
            id: ruleSnapshots.id,
            label: ruleSnapshots.label,
            createdAt: exactUtc(ruleSnapshots.createdAt),
          })
          .from(ruleSnapshots)
          .where(and(eq(ruleSnapshots.organizationId, orgId), inArray(ruleSnapshots.id, pinnedIds)))
      : [];
  const referenceById = new Map<string, RuleSnapshotReference>(
    pinned.map((snapshot) => [snapshot.id, snapshot]),
  );
  const reference = (routineName: string, id: string | null): RuleSnapshotReference | null => {
    if (id === null) return null;
    const found = referenceById.get(id);
    // A pin always names one of the organization's snapshots (FK, ON DELETE RESTRICT). Exporting
    // the routine without it would silently unpin it on import, so refuse instead.
    if (!found)
      throw new Error(`Routine "${routineName}" pins a rule snapshot that cannot be read.`);
    return found;
  };

  return rows.map((row) => ({
    name: row.name,
    enabled: row.enabled,
    triggerKind: row.triggerKind,
    triggerConfig: exportTriggerConfig(row.triggerConfig),
    maxConcurrentRuns: row.maxConcurrentRuns,
    ruleSnapshot: reference(row.name, row.ruleSnapshotId),
    shadowRuleSnapshot: reference(row.name, row.shadowRuleSnapshotId),
  }));
}

/** The snapshot a pin names, among the ones imported (or already) here. */
async function findPinnedSnapshot(
  tx: DbExecutor,
  orgId: string,
  pin: RuleSnapshotReference,
): Promise<string | null> {
  const [found] = await tx
    .select({ id: ruleSnapshots.id })
    .from(ruleSnapshots)
    .where(
      and(
        eq(ruleSnapshots.organizationId, orgId),
        sameInstant(ruleSnapshots.createdAt, pin.createdAt),
        sameLabel(pin.label),
      ),
    )
    .orderBy(asc(ruleSnapshots.id))
    .limit(1);
  return found?.id ?? null;
}

function missingPinMessage(slot: "pinned" | "shadow", pin: RuleSnapshotReference): string {
  return `The ${slot} rule snapshot ${describeSnapshotRow(pin)} is not here — import Rule Snapshots first.`;
}

export async function importRoutines(
  ctx: InboxConfigImportContext,
  rows: readonly RoutineExportRow[],
): Promise<InboxConfigImportResult[]> {
  const chartApplied = (await unresolvedMappingKeys(ctx.db, ctx.orgId)).length === 0;
  const now = ctx.now ?? new Date();
  return importEachRow(
    ctx.db,
    rows,
    (row) => row.name,
    async (tx, row) => {
      const name = row.name;
      const plan = planRoutineImport(row, { chartApplied, now });
      if (!plan.ok) return { name, success: false, error: plan.message };

      const [existing] = await tx
        .select({ id: routines.id })
        .from(routines)
        .where(
          plan.inboundEmail
            ? and(
                eq(routines.organizationId, ctx.orgId),
                eq(routines.triggerKind, "webhook"),
                sql`${routines.triggerConfig} ->> 'provider' = ${INBOUND_EMAIL_PROVIDER}`,
              )
            : and(
                eq(routines.organizationId, ctx.orgId),
                eq(routines.name, plan.values.name),
                eq(routines.triggerKind, plan.values.triggerKind),
              ),
        )
        .limit(1);
      if (existing) return { name, success: true, error: DUPLICATE_SKIPPED };

      const ruleSnapshotId = row.ruleSnapshot
        ? await findPinnedSnapshot(tx, ctx.orgId, row.ruleSnapshot)
        : null;
      if (row.ruleSnapshot && !ruleSnapshotId) {
        return { name, success: false, error: missingPinMessage("pinned", row.ruleSnapshot) };
      }
      const shadowRuleSnapshotId = row.shadowRuleSnapshot
        ? await findPinnedSnapshot(tx, ctx.orgId, row.shadowRuleSnapshot)
        : null;
      if (row.shadowRuleSnapshot && !shadowRuleSnapshotId) {
        return { name, success: false, error: missingPinMessage("shadow", row.shadowRuleSnapshot) };
      }

      const [created] = await tx
        .insert(routines)
        .values({
          organizationId: ctx.orgId,
          ...plan.values,
          ruleSnapshotId,
          shadowRuleSnapshotId,
          // The inbound email routine is system-managed, like when the first email provisions it.
          createdBy: plan.inboundEmail ? null : ctx.userId,
        })
        // One inbound email routine per organization, even if an email provisioned it just now.
        .onConflictDoNothing()
        .returning({ id: routines.id });
      if (!created) return { name, success: true, error: DUPLICATE_SKIPPED };

      await insertActivityLog(
        {
          orgId: ctx.orgId,
          entityType: "routine",
          entityId: created.id,
          action: "routine_imported",
          actorId: ctx.userId,
          changes: {
            name: { old: null, new: plan.values.name },
            triggerKind: { old: null, new: plan.values.triggerKind },
            enabled: { old: null, new: plan.values.enabled },
            ruleSnapshotId: { old: null, new: ruleSnapshotId },
            shadowRuleSnapshotId: { old: null, new: shadowRuleSnapshotId },
            ...(plan.note ? { note: { old: null, new: plan.note } } : {}),
          },
        },
        tx,
      );
      return plan.note ? { name, success: true, error: plan.note } : { name, success: true };
    },
  );
}

// ============================================================================
// Classification memories
// ============================================================================

export async function exportClassificationMemories(
  db: DbExecutor,
  orgId: string,
  options: { ids?: readonly string[] } = {},
): Promise<ClassificationMemoryExportRow[]> {
  const conditions: SQL[] = [eq(classificationMemories.organizationId, orgId)];
  if (options.ids?.length) conditions.push(inArray(classificationMemories.id, [...options.ids]));
  const rows = await db
    .select()
    .from(classificationMemories)
    .where(and(...conditions))
    .orderBy(asc(classificationMemories.createdAt), asc(classificationMemories.id));
  if (rows.length === 0) return [];

  const chart = await db
    .select({ id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));
  const accountById = new Map(chart.map((account) => [account.id, account]));
  const partyRows = await db
    .select({ id: parties.id, name: parties.name })
    .from(parties)
    .where(eq(parties.organizationId, orgId));
  const nameByPartyId = new Map(partyRows.map((party) => [party.id, party.name]));
  // A party deleted since exports as null (a party memory's key has no FK); import drops it.
  const partyName = (id: string | null) => (id ? (nameByPartyId.get(id) ?? null) : null);

  return rows.map((row) => {
    const storedLines = Array.isArray(row.answerLines) ? row.answerLines : [];
    const answerLines: MemoryAnswerLineExport[] = storedLines.map((line) => {
      const account = accountById.get(line.accountId);
      return {
        lineMatch: line.lineMatch,
        // An account deleted since the memory was saved exports as neither; import drops it.
        accountNumber: account?.accountNumber ?? null,
        accountName: account?.name ?? null,
        accountType: line.accountType,
        amount: line.amount,
        currency: line.currency,
        taxCode: line.taxCode,
      };
    });
    return {
      matchKind: row.matchKind,
      matchKey: row.matchKind === "party" ? null : row.matchKey,
      matchPartyName: row.matchKind === "party" ? partyName(row.matchKey) : null,
      answerDocKind: row.answerDocKind as ClassificationMemoryExportRow["answerDocKind"],
      answerPartyName: partyName(row.answerPartyId),
      answerLines,
      uses: row.uses,
      undos: row.undos,
      consecutiveUndos: row.consecutiveUndos,
      enabled: row.enabled,
    };
  });
}

export async function importClassificationMemories(
  ctx: InboxConfigImportContext,
  rows: readonly ClassificationMemoryExportRow[],
): Promise<InboxConfigImportResult[]> {
  const chart = await ctx.db
    .select({
      id: accounts.id,
      accountNumber: accounts.accountNumber,
      name: accounts.name,
      accountType: accounts.accountType,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, ctx.orgId));
  const partyRows = await ctx.db
    .select({ id: parties.id, name: parties.name })
    .from(parties)
    .where(eq(parties.organizationId, ctx.orgId));
  // Import is owner/admin already (organization:update); memories that can answer more than one
  // party's papers are admin-only when saved, so the import says so too rather than relying on it.
  const canSaveCrossParty = roleHasPermission(ctx.role, "agentRule", "configure");

  return importEachRow(ctx.db, rows, describeMemoryRow, async (tx, row) => {
    const name = describeMemoryRow(row);
    const plan = planMemoryImport(row, { chart, parties: partyRows });
    if (!plan.ok) return { name, success: false, error: plan.message };
    const { values } = plan;
    if (isCrossPartyScope(values.matchKind, values.answerPartyId) && !canSaveCrossParty) {
      return {
        name,
        success: false,
        error: "Only owners and admins can bring in a memory that answers more than one party.",
      };
    }

    const [existing] = await tx
      .select({ id: classificationMemories.id })
      .from(classificationMemories)
      .where(
        and(
          eq(classificationMemories.organizationId, ctx.orgId),
          eq(classificationMemories.matchKind, values.matchKind),
          eq(classificationMemories.matchKey, values.matchKey),
        ),
      )
      .limit(1);
    if (existing) return { name, success: true, error: DUPLICATE_SKIPPED };

    const [created] = await tx
      .insert(classificationMemories)
      .values({
        organizationId: ctx.orgId,
        ...values,
        createdBy: ctx.userId,
        sourceFeedbackId: null,
      })
      .onConflictDoNothing()
      .returning({ id: classificationMemories.id });
    if (!created) return { name, success: true, error: DUPLICATE_SKIPPED };

    await insertActivityLog(
      {
        orgId: ctx.orgId,
        entityType: "classification_memory",
        entityId: created.id,
        action: "memory_imported",
        actorId: ctx.userId,
        changes: {
          matchKind: values.matchKind,
          docKind: values.answerDocKind,
          partyId: values.answerPartyId,
          enabled: values.enabled,
          accounts: values.answerLines.map((line) => ({
            side: line.lineMatch.side,
            accountId: line.accountId,
          })),
        },
      },
      tx,
    );
    return { name, success: true };
  });
}

// ============================================================================
// Dispatch — what src/routes/api/-export-import.ts calls
// ============================================================================

export async function exportInboxConfigEntity(
  db: DbExecutor,
  orgId: string,
  entity: InboxConfigEntityKey,
  options: { ids?: readonly string[] } = {},
): Promise<unknown[]> {
  switch (entity) {
    case "ruleSnapshots":
      return exportRuleSnapshots(db, orgId, options);
    case "routines":
      return exportRoutines(db, orgId, options);
    case "classificationMemories":
      return exportClassificationMemories(db, orgId, options);
  }
}

/**
 * Import rows the route already validated against `inboxConfigRowSchema(entity)`. They are parsed
 * once more here so the handlers work on typed rows; the schemas' transforms are idempotent.
 */
export async function importInboxConfigEntity(
  ctx: InboxConfigImportContext,
  entity: InboxConfigEntityKey,
  rows: readonly Record<string, unknown>[],
): Promise<InboxConfigImportResult[]> {
  switch (entity) {
    case "ruleSnapshots":
      return importRuleSnapshots(
        ctx,
        rows.map((row) => ruleSnapshotExportRowSchema.parse(row)),
      );
    case "routines":
      return importRoutines(
        ctx,
        rows.map((row) => routineExportRowSchema.parse(row)),
      );
    case "classificationMemories":
      return importClassificationMemories(
        ctx,
        rows.map((row) => classificationMemoryExportRowSchema.parse(row)),
      );
  }
}

/** Cherry-pick listing for Settings → Export: id plus a display name. Disabled rows included. */
export async function listInboxConfigRecords(
  db: DbExecutor,
  orgId: string,
  entity: InboxConfigEntityKey,
): Promise<InboxConfigListRecord[]> {
  switch (entity) {
    case "ruleSnapshots": {
      const rows = await db
        .select({
          id: ruleSnapshots.id,
          label: ruleSnapshots.label,
          createdAt: exactUtc(ruleSnapshots.createdAt),
          ruleCount: sql<number>`jsonb_array_length(${ruleSnapshots.snapshot})::int`,
        })
        .from(ruleSnapshots)
        .where(eq(ruleSnapshots.organizationId, orgId))
        .orderBy(asc(ruleSnapshots.createdAt), asc(ruleSnapshots.id));
      return rows.map((row) => ({
        id: row.id,
        name: row.label ?? "Untitled snapshot",
        subtitle: row.createdAt.slice(0, 16).replace("T", " "),
        extra: `${row.ruleCount} rules`,
      }));
    }
    case "routines": {
      const rows = await db
        .select({
          id: routines.id,
          name: routines.name,
          triggerKind: routines.triggerKind,
          enabled: routines.enabled,
        })
        .from(routines)
        .where(eq(routines.organizationId, orgId))
        .orderBy(asc(routines.createdAt), asc(routines.id));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        subtitle: row.triggerKind,
        extra: row.enabled ? "enabled" : "disabled",
      }));
    }
    case "classificationMemories": {
      const rows = await db
        .select({
          id: classificationMemories.id,
          matchKind: classificationMemories.matchKind,
          matchKey: classificationMemories.matchKey,
          docKind: classificationMemories.answerDocKind,
          enabled: classificationMemories.enabled,
        })
        .from(classificationMemories)
        .where(eq(classificationMemories.organizationId, orgId))
        .orderBy(asc(classificationMemories.createdAt), asc(classificationMemories.id));
      const partyIds = rows.flatMap((row) => (row.matchKind === "party" ? [row.matchKey] : []));
      const partyRows =
        partyIds.length > 0
          ? await db
              .select({ id: parties.id, name: parties.name })
              .from(parties)
              .where(and(eq(parties.organizationId, orgId), inArray(parties.id, partyIds)))
          : [];
      return rows.map((row) => ({
        id: row.id,
        name:
          row.matchKind === "party"
            ? (partyRows.find((party) => party.id === row.matchKey)?.name ??
              "A party that no longer exists")
            : describeMatchKey(row.matchKind as MemoryMatchKind, row.matchKey),
        subtitle: row.matchKind,
        extra: row.enabled ? row.docKind : `${row.docKind ?? "no answer"}, off`,
      }));
    }
  }
}
