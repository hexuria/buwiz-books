/**
 * Rule snapshots: creating, reading, and resolving the rule set that evaluates
 * a candidate (Inbox v2 spec §6).
 *
 * Session-free: request code reaches the create/list/get functions through
 * src/routes/api/-rule-snapshots.ts, and the candidate path calls
 * `resolveCandidateRuleSets` with the executor it already holds. Every query
 * carries an explicit organization predicate alongside RLS.
 *
 * WHICH RULES EVALUATE A CANDIDATE. A paper a routine brought in is traced
 * back to that routine through its primary source record's ingestion event
 * (`source_records.ingestion_event_id` -> `ingestion_events.routine_id`), the
 * provenance every routine intake path — inbound email, signed webhooks —
 * already records. When that routine pins a snapshot, the snapshot's rules
 * evaluate the candidate instead of the live `review_rule_configs`. Everything
 * else (manual entry, imports, bills, a routine with no pin) is evaluated
 * against live configs exactly as before. A routine's shadow snapshot is
 * evaluated too, and its findings are only logged (`recordShadowRuleEvaluation`).
 *
 * A pinned snapshot that cannot be read fails closed: evaluating a paper with
 * rules other than the ones its routine pins would be a silent substitution.
 * A shadow snapshot that cannot be read is skipped with a warning, because
 * shadow output never affects the books.
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import {
  ingestionEvents,
  organizationAccountingSettings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecords,
  transactionCandidateSources,
  workflowEvents,
} from "@/db/schema/inbox";
import { routines } from "@/db/schema/routines";
import { ruleSnapshots, type RuleSnapshotEntry } from "@/db/schema/rule-snapshots";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { createLogger } from "@/lib/logger";
import { toSerializableRecord, type SerializableJson } from "@/lib/serializable-json";
import {
  buildEffectiveRuleEntries,
  DEFAULT_BOOK_RULE_FALLBACKS,
  ruleConfigMapFromEntries,
  ruleSnapshotEntriesSchema,
  type AppliedRuleSet,
  type BookRuleFallbacks,
  type RuleConfigView,
  type RuleSetProvenance,
} from "./rule-set";
import type { ReviewFindingDraft } from "./types";

const logger = createLogger("inbox.rule-snapshots");

export const RULE_SNAPSHOT_LABEL_MAX_LENGTH = 120;

export const createRuleSnapshotInputSchema = z.object({
  label: z.string().trim().max(RULE_SNAPSHOT_LABEL_MAX_LENGTH).optional(),
});
export const ruleSnapshotIdInputSchema = z.object({ snapshotId: z.string().uuid() });

/** A snapshot entry as it crosses a server-function boundary. */
export interface RuleSnapshotEntryView {
  ruleKey: string;
  enabled: boolean;
  impact: "blocking" | "warning";
  config: Record<string, SerializableJson>;
  formulaVersion: number;
}

export interface RuleSnapshotPin {
  routineId: string;
  routineName: string;
  /** `active` = the routine's enforced rules; `shadow` = evaluated and logged only. */
  slot: "active" | "shadow";
}

export interface RuleSnapshotSummary {
  id: string;
  label: string | null;
  createdBy: string | null;
  createdAt: Date;
  ruleCount: number;
  pinnedBy: RuleSnapshotPin[];
}

export interface RuleSnapshotDetail extends Omit<RuleSnapshotSummary, "ruleCount"> {
  snapshot: RuleSnapshotEntryView[];
}

function toEntryView(entry: RuleSnapshotEntry): RuleSnapshotEntryView {
  return {
    ruleKey: entry.ruleKey,
    enabled: entry.enabled,
    impact: entry.impact,
    config: toSerializableRecord(entry.config),
    formulaVersion: entry.formulaVersion,
  };
}

/** The organization's live rule configs, keyed by rule — the read the candidate path always made. */
export async function loadLiveRuleConfigs(
  db: DbExecutor,
  orgId: string,
): Promise<Map<string, RuleConfigView>> {
  const configuredRules = await db
    .select({
      key: reviewRuleDefinitions.key,
      enabled: reviewRuleConfigs.enabled,
      impact: reviewRuleConfigs.impact,
      config: reviewRuleConfigs.config,
    })
    .from(reviewRuleConfigs)
    .innerJoin(reviewRuleDefinitions, eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id))
    .where(eq(reviewRuleConfigs.organizationId, orgId));
  return new Map(configuredRules.map((rule) => [rule.key, rule]));
}

/**
 * The accounting-settings thresholds. An organization without a settings row
 * gets the column defaults — exactly what the row holds once the first
 * candidate creates it.
 */
export async function loadRuleFallbacks(db: DbExecutor, orgId: string): Promise<BookRuleFallbacks> {
  const [settings] = await db
    .select({
      lowConfidenceThreshold: organizationAccountingSettings.lowConfidenceThreshold,
      missingReceiptThreshold: organizationAccountingSettings.missingReceiptThreshold,
      missingReceiptCurrency: organizationAccountingSettings.missingReceiptCurrency,
    })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  return settings ?? { ...DEFAULT_BOOK_RULE_FALLBACKS };
}

/** The organization's current effective rule configuration, as snapshot entries. */
export async function buildLiveRuleSnapshotEntries(
  db: DbExecutor,
  orgId: string,
): Promise<RuleSnapshotEntry[]> {
  const definitions = await db
    .select({
      key: reviewRuleDefinitions.key,
      group: reviewRuleDefinitions.group,
      defaultConfig: reviewRuleDefinitions.defaultConfig,
      formulaVersion: reviewRuleDefinitions.formulaVersion,
    })
    .from(reviewRuleDefinitions)
    .orderBy(asc(reviewRuleDefinitions.key));
  const configs = await db
    .select({
      key: reviewRuleDefinitions.key,
      enabled: reviewRuleConfigs.enabled,
      impact: reviewRuleConfigs.impact,
      config: reviewRuleConfigs.config,
    })
    .from(reviewRuleConfigs)
    .innerJoin(reviewRuleDefinitions, eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id))
    .where(eq(reviewRuleConfigs.organizationId, orgId));
  return buildEffectiveRuleEntries({
    definitions,
    configs,
    fallbacks: await loadRuleFallbacks(db, orgId),
  });
}

/**
 * Freeze the organization's live rule configuration into a new snapshot.
 *
 * Insert-only: this module has no update path, and the database rejects any
 * UPDATE of a snapshot row (0055's trigger).
 */
export async function createRuleSnapshot(
  db: DbExecutor,
  input: { orgId: string; actorId: string; label?: string | null },
): Promise<RuleSnapshotDetail> {
  const entries = await buildLiveRuleSnapshotEntries(db, input.orgId);
  if (entries.length === 0) {
    // An empty review_rule_definitions table is the documented silent failure
    // (CLAUDE.md): refusing here keeps it from minting an empty pack that
    // would evaluate differently the moment the catalog is seeded.
    throw new Error(
      "The review-rule catalog is not seeded on this database, so there are no rules to snapshot.",
    );
  }
  const label = input.label?.trim() || null;
  const [created] = await db
    .insert(ruleSnapshots)
    .values({
      organizationId: input.orgId,
      label,
      snapshot: entries,
      createdBy: input.actorId,
    })
    .returning();
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "rule_snapshot",
      entityId: created.id,
      action: "rule_snapshot_created",
      actorId: input.actorId,
      changes: { label: { old: null, new: label }, ruleCount: { old: null, new: entries.length } },
    },
    db,
  );
  return {
    id: created.id,
    label: created.label,
    createdBy: created.createdBy,
    createdAt: created.createdAt,
    pinnedBy: [],
    snapshot: entries.map(toEntryView),
  };
}

async function pinsFor(
  db: DbExecutor,
  orgId: string,
  snapshotIds: string[],
): Promise<Map<string, RuleSnapshotPin[]>> {
  const pins = new Map<string, RuleSnapshotPin[]>();
  if (snapshotIds.length === 0) return pins;
  const rows = await db
    .select({
      id: routines.id,
      name: routines.name,
      ruleSnapshotId: routines.ruleSnapshotId,
      shadowRuleSnapshotId: routines.shadowRuleSnapshotId,
    })
    .from(routines)
    .where(
      and(
        eq(routines.organizationId, orgId),
        or(
          inArray(routines.ruleSnapshotId, snapshotIds),
          inArray(routines.shadowRuleSnapshotId, snapshotIds),
        ),
      ),
    )
    .orderBy(asc(routines.createdAt), asc(routines.id));
  const add = (snapshotId: string | null, pin: RuleSnapshotPin) => {
    if (!snapshotId) return;
    pins.set(snapshotId, [...(pins.get(snapshotId) ?? []), pin]);
  };
  for (const row of rows) {
    add(row.ruleSnapshotId, { routineId: row.id, routineName: row.name, slot: "active" });
    add(row.shadowRuleSnapshotId, { routineId: row.id, routineName: row.name, slot: "shadow" });
  }
  return pins;
}

export async function listRuleSnapshots(
  db: DbExecutor,
  orgId: string,
): Promise<RuleSnapshotSummary[]> {
  const rows = await db
    .select({
      id: ruleSnapshots.id,
      label: ruleSnapshots.label,
      createdBy: ruleSnapshots.createdBy,
      createdAt: ruleSnapshots.createdAt,
      ruleCount: sql<number>`jsonb_array_length(${ruleSnapshots.snapshot})::int`,
    })
    .from(ruleSnapshots)
    .where(eq(ruleSnapshots.organizationId, orgId))
    .orderBy(desc(ruleSnapshots.createdAt), desc(ruleSnapshots.id));
  const pins = await pinsFor(
    db,
    orgId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, pinnedBy: pins.get(row.id) ?? [] }));
}

/** Read one of this organization's snapshots, validating its stored shape. */
async function readSnapshotEntries(
  db: DbExecutor,
  orgId: string,
  snapshotId: string,
): Promise<{ row: typeof ruleSnapshots.$inferSelect; entries: RuleSnapshotEntry[] } | null> {
  const [row] = await db
    .select()
    .from(ruleSnapshots)
    .where(and(eq(ruleSnapshots.organizationId, orgId), eq(ruleSnapshots.id, snapshotId)))
    .limit(1);
  if (!row) return null;
  const parsed = ruleSnapshotEntriesSchema.safeParse(row.snapshot);
  if (!parsed.success) {
    throw new Error(`Rule snapshot ${snapshotId} is malformed and cannot evaluate anything.`);
  }
  return { row, entries: parsed.data };
}

export async function getRuleSnapshot(
  db: DbExecutor,
  orgId: string,
  snapshotId: string,
): Promise<RuleSnapshotDetail> {
  const found = await readSnapshotEntries(db, orgId, snapshotId);
  // Same message for another organization's snapshot and a missing one, so
  // this is not a cross-tenant existence oracle.
  if (!found) throw new Error("Rule snapshot not found.");
  const pins = await pinsFor(db, orgId, [snapshotId]);
  return {
    id: found.row.id,
    label: found.row.label,
    createdBy: found.row.createdBy,
    createdAt: found.row.createdAt,
    pinnedBy: pins.get(snapshotId) ?? [],
    snapshot: found.entries.map(toEntryView),
  };
}

/** A snapshot's entries as an applicable rule set, or null when the organization has no such snapshot. */
export async function loadSnapshotRuleSet(
  db: DbExecutor,
  orgId: string,
  snapshotId: string,
  routineId: string | null,
  fallbacks: BookRuleFallbacks,
): Promise<AppliedRuleSet | null> {
  const found = await readSnapshotEntries(db, orgId, snapshotId);
  if (!found) return null;
  return {
    provenance: { source: "snapshot", snapshotId, routineId },
    configByKey: ruleConfigMapFromEntries(found.entries),
    fallbacks,
  };
}

export interface CandidateRuleSets {
  routineId: string | null;
  /** The rules whose findings are real: the routine's pinned snapshot, or live configs. */
  active: AppliedRuleSet;
  /** The routine's shadow snapshot; its findings are logged, never enforced. */
  shadow: AppliedRuleSet | null;
}

/** The routine that brought a candidate's paper in, if any. */
async function routineForCandidate(db: DbExecutor, orgId: string, candidateId: string) {
  const [link] = await db
    .select({
      routineId: routines.id,
      ruleSnapshotId: routines.ruleSnapshotId,
      shadowRuleSnapshotId: routines.shadowRuleSnapshotId,
    })
    .from(transactionCandidateSources)
    .innerJoin(
      sourceRecords,
      and(
        eq(sourceRecords.id, transactionCandidateSources.sourceRecordId),
        eq(sourceRecords.organizationId, orgId),
      ),
    )
    .innerJoin(
      ingestionEvents,
      and(
        eq(ingestionEvents.id, sourceRecords.ingestionEventId),
        eq(ingestionEvents.organizationId, orgId),
      ),
    )
    .innerJoin(
      routines,
      and(eq(routines.id, ingestionEvents.routineId), eq(routines.organizationId, orgId)),
    )
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, candidateId),
      ),
    )
    // The primary source decides; then origin before supporting before
    // corroborating evidence; then the oldest record, so the answer is stable.
    .orderBy(
      desc(transactionCandidateSources.isPrimary),
      sql`case ${transactionCandidateSources.relationship} when 'origin' then 0 when 'supporting' then 1 else 2 end`,
      asc(sourceRecords.createdAt),
      asc(sourceRecords.id),
    )
    .limit(1);
  return link ?? null;
}

/**
 * The rule sets that evaluate this candidate: its routine's pinned snapshot
 * (or live configs), plus the routine's shadow snapshot when one is set.
 */
export async function resolveCandidateRuleSets(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
  fallbacks: BookRuleFallbacks,
): Promise<CandidateRuleSets> {
  const routine = await routineForCandidate(db, orgId, candidateId);
  const routineId = routine?.routineId ?? null;

  let active: AppliedRuleSet;
  if (routine?.ruleSnapshotId) {
    const pinned = await loadSnapshotRuleSet(
      db,
      orgId,
      routine.ruleSnapshotId,
      routineId,
      fallbacks,
    );
    if (!pinned) {
      throw new Error(
        "This paper's routine pins a rule snapshot that cannot be read, so its rules cannot be evaluated.",
      );
    }
    active = pinned;
  } else {
    active = {
      provenance: { source: "live", snapshotId: null, routineId },
      configByKey: await loadLiveRuleConfigs(db, orgId),
      fallbacks,
    };
  }

  let shadow: AppliedRuleSet | null = null;
  if (routine?.shadowRuleSnapshotId) {
    shadow = await loadSnapshotRuleSet(
      db,
      orgId,
      routine.shadowRuleSnapshotId,
      routineId,
      fallbacks,
    );
    if (!shadow) {
      logger.warn("Shadow rule snapshot not readable; shadow evaluation skipped", {
        organizationId: orgId,
        routineId,
        snapshotId: routine.shadowRuleSnapshotId,
      });
    }
  }
  return { routineId, active, shadow };
}

/** Provenance for a candidate no routine brought in. */
export const LIVE_RULE_SET_PROVENANCE: RuleSetProvenance = Object.freeze({
  source: "live",
  snapshotId: null,
  routineId: null,
});

function ruleKeysOf(findings: ReviewFindingDraft[]): string[] {
  return [...new Set(findings.map((finding) => finding.ruleKey))].sort();
}

/**
 * Log what a shadow snapshot WOULD have flagged, next to what was enforced.
 *
 * Storage decision: one `workflow_events` row per shadow evaluation, not a new
 * table and never `review_findings`. Approval and period close gate on open
 * `review_findings`, so that table must only ever hold enforced findings;
 * `workflow_events` is the existing append-only, RLS-scoped audit log that
 * nothing gates on, already indexed by (organization, entity) for replay, and
 * its idempotency key makes a retried evaluation write once.
 */
export async function recordShadowRuleEvaluation(
  db: DbExecutor,
  input: {
    orgId: string;
    inboxItemId: string;
    candidateId: string;
    candidateRevision: number;
    active: AppliedRuleSet;
    activeFindings: ReviewFindingDraft[];
    shadow: AppliedRuleSet;
    shadowFindings: ReviewFindingDraft[];
  },
): Promise<void> {
  const shadowSnapshotId = input.shadow.provenance.snapshotId;
  const enforcedKeys = ruleKeysOf(input.activeFindings);
  const shadowKeys = ruleKeysOf(input.shadowFindings);
  const enforcedImpact = new Map(input.activeFindings.map((f) => [f.ruleKey, f.impact]));
  const impactChanged = input.shadowFindings
    .filter((finding) => {
      const enforced = enforcedImpact.get(finding.ruleKey);
      return enforced !== undefined && enforced !== finding.impact;
    })
    .map((finding) => ({
      ruleKey: finding.ruleKey,
      enforced: enforcedImpact.get(finding.ruleKey)!,
      shadow: finding.impact,
    }));
  await db
    .insert(workflowEvents)
    .values({
      organizationId: input.orgId,
      inboxItemId: input.inboxItemId,
      entityType: "transaction_candidate",
      entityId: input.candidateId,
      action: "rule_shadow_evaluated",
      actorType: "system",
      idempotencyKey: `rule-shadow:${input.candidateId}:${input.candidateRevision}:${shadowSnapshotId}`,
      data: {
        routineId: input.shadow.provenance.routineId,
        candidateRevision: input.candidateRevision,
        shadowSnapshotId,
        enforced: {
          source: input.active.provenance.source,
          snapshotId: input.active.provenance.snapshotId,
          findings: input.activeFindings.map(({ ruleKey, impact }) => ({ ruleKey, impact })),
        },
        shadowFindings: input.shadowFindings.map(({ ruleKey, impact, message, evidence }) => ({
          ruleKey,
          impact,
          message,
          evidence,
        })),
        diff: {
          onlyInShadow: shadowKeys.filter((key) => !enforcedKeys.includes(key)),
          onlyEnforced: enforcedKeys.filter((key) => !shadowKeys.includes(key)),
          impactChanged,
        },
      },
    })
    .onConflictDoNothing();
}
