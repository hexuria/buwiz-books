// ============================================================================
// Autonomy lanes — earned authority per vendor and kind of paper (Inbox v2 §8).
//
// Same rules as per-kind autonomy (./autonomy.ts), computed over ONE lane's
// feedback rows (ai_run_feedback.lane_id):
//
//   - lanes are created at `watch` the first time a proposal is seen for them;
//   - promotion is admin-only and one step at a time (watch -> suggest ->
//     auto). Eligibility (AUTONOMY_CRITERIA over the lane's labels) is
//     re-verified at the moment of the flip, under the lane's row lock; an
//     `auto` promotion also sets the lane's amount cap and a confidence
//     threshold its reliability table supports (./lane-calibration.ts);
//   - demotion narrows authority, so it is automatic: after every new label,
//     an `auto` lane whose trailing window slipped below the demotion rate
//     drops to `suggest`. An admin may also demote by hand at any time.
//
// Every change writes a workflow event and an activity log row. All of it runs
// on the caller's org-context executor.
// ============================================================================

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import {
  aiAutonomyLanes,
  aiRunFeedback,
  type AutonomyLaneKey,
  type AutonomyLaneLevel,
} from "../../db/schema/ai";
import { user } from "../../db/schema/auth";
import { workflowEvents } from "../../db/schema/inbox";
import { parties } from "../../db/schema/parties";
import { insertActivityLog } from "../insert-activity-log";
import { compareMoney, parseMoneyToScaled, scaledToMoney } from "../inbox/money";
import {
  AUTONOMY_CRITERIA,
  judgeAutonomyEligibility,
  shouldDemoteFromVerdicts,
  type AutonomyEligibility,
} from "./autonomy";
import {
  buildReliabilityTable,
  validateLaneThreshold,
  type CalibrationSample,
  type ReliabilityTable,
} from "./lane-calibration";

export type AutonomyLaneRow = typeof aiAutonomyLanes.$inferSelect;

export interface AutonomyLaneIdentity {
  laneKey: AutonomyLaneKey;
  partyId: string | null;
  docKind: string | null;
}

const LEVEL_RANK: Record<AutonomyLaneLevel, number> = { watch: 0, suggest: 1, auto: 2 };

/** What lane papers are counted in, for the eligibility sentence. */
const LANE_NOUN = "papers";

function identityWhere(orgId: string, identity: AutonomyLaneIdentity) {
  return and(
    eq(aiAutonomyLanes.organizationId, orgId),
    eq(aiAutonomyLanes.laneKey, identity.laneKey),
    identity.partyId === null
      ? isNull(aiAutonomyLanes.partyId)
      : eq(aiAutonomyLanes.partyId, identity.partyId),
    identity.docKind === null
      ? isNull(aiAutonomyLanes.docKind)
      : eq(aiAutonomyLanes.docKind, identity.docKind),
  );
}

/** The lane for an identity, or null. Optionally row-locked. */
export async function findAutonomyLane(
  db: DbExecutor,
  orgId: string,
  identity: AutonomyLaneIdentity,
  options: { lock?: "update" | "share" } = {},
): Promise<AutonomyLaneRow | null> {
  const query = db.select().from(aiAutonomyLanes).where(identityWhere(orgId, identity)).limit(1);
  const [row] = options.lock ? await query.for(options.lock) : await query;
  return row ?? null;
}

/**
 * The lane for an identity, created at `watch` on first sight. The party must
 * belong to the organization. Serialized per identity, so two papers seen at
 * once cannot create the same lane twice.
 */
export async function ensureAutonomyLane(
  db: DbExecutor,
  orgId: string,
  identity: AutonomyLaneIdentity,
): Promise<AutonomyLaneRow> {
  if (identity.partyId) {
    const [party] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.id, identity.partyId), eq(parties.organizationId, orgId)))
      .limit(1);
    if (!party) throw new Error("The lane's party does not belong to this organization.");
  }
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`ai-autonomy-lane:${orgId}:${identity.laneKey}:${identity.partyId ?? ""}:${identity.docKind ?? ""}`}, 0::bigint)
    )
  `);
  const existing = await findAutonomyLane(db, orgId, identity);
  if (existing) return existing;
  const [created] = await db
    .insert(aiAutonomyLanes)
    .values({
      organizationId: orgId,
      laneKey: identity.laneKey,
      partyId: identity.partyId,
      docKind: identity.docKind,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const concurrent = await findAutonomyLane(db, orgId, identity);
  if (!concurrent) throw new Error("Unable to create the autonomy lane.");
  return concurrent;
}

export async function loadAutonomyLane(
  db: DbExecutor,
  orgId: string,
  laneId: string,
  options: { lock?: "update" | "share" } = {},
): Promise<AutonomyLaneRow | null> {
  const query = db
    .select()
    .from(aiAutonomyLanes)
    .where(and(eq(aiAutonomyLanes.id, laneId), eq(aiAutonomyLanes.organizationId, orgId)))
    .limit(1);
  const [row] = options.lock ? await query.for(options.lock) : await query;
  return row ?? null;
}

/** AUTONOMY_CRITERIA over this lane's labels only. */
export async function computeLaneEligibility(
  db: DbExecutor,
  orgId: string,
  laneId: string,
): Promise<AutonomyEligibility> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${aiRunFeedback.verdict} = 'accepted')::int`,
    })
    .from(aiRunFeedback)
    .where(and(eq(aiRunFeedback.organizationId, orgId), eq(aiRunFeedback.laneId, laneId)));
  return judgeAutonomyEligibility(Number(row?.total ?? 0), Number(row?.accepted ?? 0), LANE_NOUN);
}

function confidenceOf(evidence: unknown): number | null {
  const value =
    evidence && typeof evidence === "object"
      ? (evidence as Record<string, unknown>).confidence
      : null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

async function laneCalibrationSamples(
  db: DbExecutor,
  orgId: string,
  laneIds: string[],
): Promise<Map<string, CalibrationSample[]>> {
  const samples = new Map<string, CalibrationSample[]>();
  if (laneIds.length === 0) return samples;
  const rows = await db
    .select({
      laneId: aiRunFeedback.laneId,
      verdict: aiRunFeedback.verdict,
      evidence: aiRunFeedback.laneEvidence,
    })
    .from(aiRunFeedback)
    .where(and(eq(aiRunFeedback.organizationId, orgId), inArray(aiRunFeedback.laneId, laneIds)));
  for (const row of rows) {
    const confidence = confidenceOf(row.evidence);
    if (!row.laneId || confidence === null) continue;
    const list = samples.get(row.laneId) ?? [];
    list.push({ confidence, accepted: row.verdict === "accepted" });
    samples.set(row.laneId, list);
  }
  return samples;
}

/** The lane's reliability table: confidence buckets -> observed acceptance. */
export async function loadLaneReliability(
  db: DbExecutor,
  orgId: string,
  laneId: string,
): Promise<ReliabilityTable> {
  const samples = await laneCalibrationSamples(db, orgId, [laneId]);
  return buildReliabilityTable(samples.get(laneId) ?? []);
}

/** The lane's trailing-window verdict, newest label first. */
export async function shouldDemoteLane(
  db: DbExecutor,
  orgId: string,
  laneId: string,
): Promise<boolean> {
  const recent = await db
    .select({ verdict: aiRunFeedback.verdict })
    .from(aiRunFeedback)
    .where(and(eq(aiRunFeedback.organizationId, orgId), eq(aiRunFeedback.laneId, laneId)))
    .orderBy(desc(aiRunFeedback.createdAt), desc(aiRunFeedback.id))
    .limit(AUTONOMY_CRITERIA.demotionWindow);
  return shouldDemoteFromVerdicts(recent.map((row) => row.verdict));
}

async function recordLaneChange(
  db: DbExecutor,
  input: {
    orgId: string;
    lane: AutonomyLaneRow;
    action: "jev_lane_promoted" | "jev_lane_demoted" | "jev_lane_limits_changed";
    actorType: "user" | "system";
    actorId: string | null;
    inboxItemId?: string | null;
    data: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(workflowEvents).values({
    organizationId: input.orgId,
    inboxItemId: input.inboxItemId ?? null,
    entityType: "ai_autonomy_lane",
    entityId: input.lane.id,
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    data: {
      laneKey: input.lane.laneKey,
      partyId: input.lane.partyId,
      docKind: input.lane.docKind,
      ...input.data,
    },
  });
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "ai_autonomy_lane",
      entityId: input.lane.id,
      action: input.action,
      actorId: input.actorId ?? "system",
      changes: input.data,
    },
    db,
  );
}

/**
 * Auto-demotion, evaluated after every new label on a lane. Narrows authority
 * only: an `auto` lane whose trailing window slipped below the demotion rate
 * drops to `suggest`, with demoted_at stamped and a workflow event naming the
 * label that tripped it. Promotion is never automatic.
 */
export async function demoteLaneIfSlipped(
  db: DbExecutor,
  input: {
    orgId: string;
    laneId: string;
    /** The person (or system actor) whose label tripped the check. */
    triggeredBy: string | null;
    inboxItemId?: string | null;
    feedbackId?: string | null;
  },
): Promise<boolean> {
  const lane = await loadAutonomyLane(db, input.orgId, input.laneId, { lock: "update" });
  if (!lane || lane.level !== "auto") return false;
  if (!(await shouldDemoteLane(db, input.orgId, lane.id))) return false;
  const now = new Date();
  const [demoted] = await db
    .update(aiAutonomyLanes)
    .set({ level: "suggest", demotedAt: now, updatedAt: now })
    .where(and(eq(aiAutonomyLanes.id, lane.id), eq(aiAutonomyLanes.organizationId, input.orgId)))
    .returning();
  await recordLaneChange(db, {
    orgId: input.orgId,
    lane: demoted,
    action: "jev_lane_demoted",
    actorType: "system",
    actorId: input.triggeredBy,
    inboxItemId: input.inboxItemId,
    data: {
      fromLevel: lane.level,
      toLevel: "suggest",
      automatic: true,
      window: AUTONOMY_CRITERIA.demotionWindow,
      demotionRate: AUTONOMY_CRITERIA.demotionRate,
      feedbackId: input.feedbackId ?? null,
    },
  });
  return true;
}

/** A positive decimal amount cap that fits numeric(20,8), normalized. */
export function parseLaneAmountCap(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{1,12}(?:\.\d{1,8})?$/.test(trimmed) || parseMoneyToScaled(trimmed) <= 0n) {
    throw new Error("The amount cap must be a positive amount with at most 8 decimal places.");
  }
  return scaledToMoney(parseMoneyToScaled(trimmed));
}

/**
 * Promote a lane one level, admin-only (the server function checks the role).
 * Eligibility is re-verified here, under the lane's row lock, at the moment of
 * the flip. `auto` also needs the lane's party, an amount cap, and a threshold
 * its reliability table supports.
 */
export async function promoteAutonomyLane(
  db: DbExecutor,
  input: {
    orgId: string;
    laneId: string;
    to: "suggest" | "auto";
    actorId: string;
    amountCap?: string | null;
    confidenceThreshold?: string | null;
  },
): Promise<AutonomyLaneRow> {
  const lane = await loadAutonomyLane(db, input.orgId, input.laneId, { lock: "update" });
  if (!lane) throw new Error("Lane not found.");
  const from = lane.level;
  const expectedFrom = input.to === "suggest" ? "watch" : "suggest";
  if (from !== expectedFrom) {
    throw new Error(
      `A lane at ${from} cannot be promoted to ${input.to}; lanes move one step at a time (watch → suggest → auto).`,
    );
  }
  const eligibility = await computeLaneEligibility(db, input.orgId, lane.id);
  if (!eligibility.eligible) {
    throw new Error(`This lane has not earned ${input.to} yet. ${eligibility.reason}`);
  }

  const patch: Partial<typeof aiAutonomyLanes.$inferInsert> = {};
  if (input.to === "auto") {
    if (!lane.partyId) {
      throw new Error(
        "A lane without a vendor or customer can never approve: new parties always need a person.",
      );
    }
    if (!input.amountCap?.trim()) throw new Error("Set an amount cap for this lane.");
    if (!input.confidenceThreshold?.trim()) {
      throw new Error("Set a confidence threshold for this lane.");
    }
    patch.amountCap = parseLaneAmountCap(input.amountCap);
    const table = await loadLaneReliability(db, input.orgId, lane.id);
    const threshold = validateLaneThreshold(input.confidenceThreshold, table);
    if (!threshold.ok) throw new Error(threshold.reason);
    patch.confidenceThreshold = String(threshold.value);
  }

  const now = new Date();
  const [promoted] = await db
    .update(aiAutonomyLanes)
    .set({
      ...patch,
      level: input.to,
      promotedBy: input.actorId,
      promotedAt: now,
      updatedAt: now,
    })
    .where(and(eq(aiAutonomyLanes.id, lane.id), eq(aiAutonomyLanes.organizationId, input.orgId)))
    .returning();
  await recordLaneChange(db, {
    orgId: input.orgId,
    lane: promoted,
    action: "jev_lane_promoted",
    actorType: "user",
    actorId: input.actorId,
    data: {
      fromLevel: from,
      toLevel: input.to,
      amountCap: promoted.amountCap,
      confidenceThreshold: promoted.confidenceThreshold,
      eligibility: {
        total: eligibility.total,
        accepted: eligibility.accepted,
        acceptanceRate: eligibility.acceptanceRate,
      },
    },
  });
  return promoted;
}

/** Demote a lane by hand, admin-only. Narrowing needs no eligibility. */
export async function demoteAutonomyLane(
  db: DbExecutor,
  input: { orgId: string; laneId: string; to: "watch" | "suggest"; actorId: string },
): Promise<AutonomyLaneRow> {
  const lane = await loadAutonomyLane(db, input.orgId, input.laneId, { lock: "update" });
  if (!lane) throw new Error("Lane not found.");
  if (LEVEL_RANK[input.to] >= LEVEL_RANK[lane.level]) {
    throw new Error(`A lane at ${lane.level} cannot be demoted to ${input.to}.`);
  }
  const now = new Date();
  const [demoted] = await db
    .update(aiAutonomyLanes)
    .set({ level: input.to, demotedAt: now, updatedAt: now })
    .where(and(eq(aiAutonomyLanes.id, lane.id), eq(aiAutonomyLanes.organizationId, input.orgId)))
    .returning();
  await recordLaneChange(db, {
    orgId: input.orgId,
    lane: demoted,
    action: "jev_lane_demoted",
    actorType: "user",
    actorId: input.actorId,
    data: { fromLevel: lane.level, toLevel: input.to, automatic: false },
  });
  return demoted;
}

/**
 * Change an auto lane's cap or threshold, admin-only. The threshold must still
 * be one the reliability table supports; a change that WIDENS authority (a
 * higher cap, a lower threshold) re-verifies the lane's eligibility first.
 */
export async function setAutonomyLaneLimits(
  db: DbExecutor,
  input: {
    orgId: string;
    laneId: string;
    actorId: string;
    amountCap?: string | null;
    confidenceThreshold?: string | null;
  },
): Promise<AutonomyLaneRow> {
  const lane = await loadAutonomyLane(db, input.orgId, input.laneId, { lock: "update" });
  if (!lane) throw new Error("Lane not found.");
  if (lane.level !== "auto") {
    throw new Error("Limits are set when a lane is promoted to auto.");
  }
  const patch: Partial<typeof aiAutonomyLanes.$inferInsert> = {};
  let widens = false;
  if (input.amountCap != null) {
    const cap = parseLaneAmountCap(input.amountCap);
    if (lane.amountCap === null || compareMoney(cap, lane.amountCap) > 0) widens = true;
    patch.amountCap = cap;
  }
  if (input.confidenceThreshold != null) {
    const table = await loadLaneReliability(db, input.orgId, lane.id);
    const threshold = validateLaneThreshold(input.confidenceThreshold, table);
    if (!threshold.ok) throw new Error(threshold.reason);
    if (lane.confidenceThreshold === null || threshold.value < Number(lane.confidenceThreshold)) {
      widens = true;
    }
    patch.confidenceThreshold = String(threshold.value);
  }
  if (Object.keys(patch).length === 0) throw new Error("No lane limits supplied.");
  if (widens) {
    const eligibility = await computeLaneEligibility(db, input.orgId, lane.id);
    if (!eligibility.eligible) {
      throw new Error(`Widening this lane needs it to be eligible. ${eligibility.reason}`);
    }
  }
  const [changed] = await db
    .update(aiAutonomyLanes)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(aiAutonomyLanes.id, lane.id), eq(aiAutonomyLanes.organizationId, input.orgId)))
    .returning();
  await recordLaneChange(db, {
    orgId: input.orgId,
    lane: changed,
    action: "jev_lane_limits_changed",
    actorType: "user",
    actorId: input.actorId,
    data: {
      amountCap: { old: lane.amountCap, new: changed.amountCap },
      confidenceThreshold: { old: lane.confidenceThreshold, new: changed.confidenceThreshold },
      widened: widens,
    },
  });
  return changed;
}

export interface LaneAgreement {
  /** Human labels on this lane's proposals. */
  labeled: number;
  accepted: number;
  corrected: number;
  rejected: number;
  /** Labeled proposals Jev would have approved (the paper checks passed). */
  wouldApprove: number;
  /** Of those, the ones a person changed or rejected: approvals a human would undo. */
  wouldApproveUndone: number;
}

export interface AutonomyLaneSummary {
  lane: AutonomyLaneRow;
  partyName: string | null;
  promotedByName: string | null;
  agreement: LaneAgreement;
  eligibility: AutonomyEligibility;
  reliability: ReliabilityTable;
}

/** Every lane of one kind for the organization, with its agreement and calibration. */
export async function listAutonomyLanes(
  db: DbExecutor,
  orgId: string,
  laneKey: AutonomyLaneKey,
): Promise<AutonomyLaneSummary[]> {
  const lanes = await db
    .select({ lane: aiAutonomyLanes, partyName: parties.name, promotedByName: user.name })
    .from(aiAutonomyLanes)
    .leftJoin(
      parties,
      and(eq(parties.id, aiAutonomyLanes.partyId), eq(parties.organizationId, orgId)),
    )
    .leftJoin(user, eq(user.id, aiAutonomyLanes.promotedBy))
    .where(and(eq(aiAutonomyLanes.organizationId, orgId), eq(aiAutonomyLanes.laneKey, laneKey)))
    .orderBy(desc(aiAutonomyLanes.updatedAt), desc(aiAutonomyLanes.id));
  const laneIds = lanes.map((row) => row.lane.id);
  const counts =
    laneIds.length > 0
      ? await db
          .select({
            laneId: aiRunFeedback.laneId,
            labeled: sql<number>`count(*)::int`,
            accepted: sql<number>`count(*) filter (where ${aiRunFeedback.verdict} = 'accepted')::int`,
            corrected: sql<number>`count(*) filter (where ${aiRunFeedback.verdict} = 'corrected')::int`,
            rejected: sql<number>`count(*) filter (where ${aiRunFeedback.verdict} = 'rejected')::int`,
            wouldApprove: sql<number>`count(*) filter (where ${aiRunFeedback.laneEvidence}->>'wouldApprove' = 'true')::int`,
            wouldApproveUndone: sql<number>`count(*) filter (where ${aiRunFeedback.laneEvidence}->>'wouldApprove' = 'true' and ${aiRunFeedback.verdict} <> 'accepted')::int`,
          })
          .from(aiRunFeedback)
          .where(
            and(eq(aiRunFeedback.organizationId, orgId), inArray(aiRunFeedback.laneId, laneIds)),
          )
          .groupBy(aiRunFeedback.laneId)
      : [];
  const byLane = new Map(counts.map((row) => [row.laneId, row]));
  const samples = await laneCalibrationSamples(db, orgId, laneIds);
  return lanes.map(({ lane, partyName, promotedByName }) => {
    const row = byLane.get(lane.id);
    const agreement: LaneAgreement = {
      labeled: Number(row?.labeled ?? 0),
      accepted: Number(row?.accepted ?? 0),
      corrected: Number(row?.corrected ?? 0),
      rejected: Number(row?.rejected ?? 0),
      wouldApprove: Number(row?.wouldApprove ?? 0),
      wouldApproveUndone: Number(row?.wouldApproveUndone ?? 0),
    };
    return {
      lane,
      partyName: partyName ?? null,
      promotedByName: promotedByName ?? null,
      agreement,
      eligibility: judgeAutonomyEligibility(agreement.labeled, agreement.accepted, LANE_NOUN),
      reliability: buildReliabilityTable(samples.get(lane.id) ?? []),
    };
  });
}
