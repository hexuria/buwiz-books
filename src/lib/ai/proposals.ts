// ============================================================================
// Proposal service — lifecycle of the single approval primitive.
//
//   pending ──approve──▶ approved      (applier writes, feedback "accepted")
//   pending ──correct──▶ corrected     (applier writes the USER's payload,
//                                       feedback "corrected" + diff)
//   pending ──reject───▶ rejected      (no write, feedback "rejected")
//   pending ──expire───▶ expired       (housekeeping, no feedback)
//
// All mutations run on ctx.db (inside the caller's org-context transaction),
// claim the row with a status-guarded UPDATE first, and roll back atomically
// if the applier fails. Feedback rows are written in the same transaction —
// they are the flywheel's ground-truth labels.
// ============================================================================

import { and, eq, lt, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import {
  aiActionProposals,
  aiRunFeedback,
  type AiProposalKind,
  type AiProposalStatus,
} from "../../db/schema/ai";
import { roleHasPermission } from "../auth-middleware";
import { AuthorizationError } from "../auth-errors";
import { proposalPayloadSchemas } from "./proposal-types";
import { PROPOSAL_APPLIERS, type ApplierContext } from "./proposal-appliers";
import { canAutoApply } from "./autonomy";
import { getOrgAiSettings } from "./settings";

const DEFAULT_EXPIRY_DAYS = 30;

export interface CreateProposalInput {
  orgId: string;
  kind: AiProposalKind;
  payload: Record<string, unknown>;
  invocationId?: string | null;
  /** 0–1 */
  confidence?: number | null;
  sourceRef?: { entityType: string; entityId: string };
  createdBy?: string;
  expiresInDays?: number;
}

export type ProposalRow = typeof aiActionProposals.$inferSelect;

/** Validate the payload for its kind and insert a pending proposal. */
export async function createProposal(
  db: DbExecutor,
  input: CreateProposalInput,
): Promise<ProposalRow> {
  const schema = proposalPayloadSchemas[input.kind];
  const payload = schema.parse(input.payload) as Record<string, unknown>;

  const [row] = await db
    .insert(aiActionProposals)
    .values({
      organizationId: input.orgId,
      kind: input.kind,
      proposal: payload,
      invocationId: input.invocationId ?? null,
      confidence: input.confidence != null ? String(input.confidence) : null,
      sourceRef: input.sourceRef,
      createdBy: input.createdBy,
      expiresAt: new Date(
        Date.now() + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
      ),
    })
    .returning();
  return row;
}

/**
 * Create a proposal and, when the org has EARNED auto-apply for this kind,
 * apply it immediately (status "auto_applied") using the very same applier
 * the review UI calls — so the permission checks and write path are
 * identical. Structurally-manual kinds and unknown confidences never qualify.
 *
 * An auto-applied proposal still carries feedback: a human who later reverts
 * it produces a "corrected" label, which is what drives auto-demotion.
 */
export async function createProposalWithAutonomy(
  ctx: ApplierContext,
  input: Omit<CreateProposalInput, "orgId">,
): Promise<{ proposal: ProposalRow; autoApplied: boolean }> {
  const proposal = await createProposal(ctx.db, { ...input, orgId: ctx.orgId });

  const settings = await getOrgAiSettings(ctx.orgId);
  const eligible = canAutoApply({
    kind: input.kind,
    autonomy: settings.autonomy,
    confidence: input.confidence ?? null,
    threshold: settings.confidenceThresholds[input.kind] ?? null,
  });
  if (!eligible) return { proposal, autoApplied: false };

  const applier = PROPOSAL_APPLIERS[input.kind];
  if (!applier) return { proposal, autoApplied: false };
  // Auto-apply still requires the underlying permission — the acting user's
  // role gates it exactly as a manual approval would.
  for (const perm of applier.requiredPermissions(proposal.proposal)) {
    if (!roleHasPermission(ctx.role, perm.resource, perm.action)) {
      return { proposal, autoApplied: false };
    }
  }

  await applier.apply(ctx, proposal.proposal);
  const [applied] = await ctx.db
    .update(aiActionProposals)
    .set({ status: "auto_applied", appliedAt: new Date() })
    .where(
      and(
        eq(aiActionProposals.id, proposal.id),
        eq(aiActionProposals.organizationId, ctx.orgId),
        eq(aiActionProposals.status, "pending"),
      ),
    )
    .returning();

  return { proposal: applied ?? proposal, autoApplied: Boolean(applied) };
}

export interface ListProposalsFilter {
  status?: AiProposalStatus;
  kind?: AiProposalKind;
  sourceRef?: { entityType: string; entityId: string };
  limit?: number;
}

export async function listProposals(
  db: DbExecutor,
  orgId: string,
  filter: ListProposalsFilter = {},
): Promise<ProposalRow[]> {
  const conditions = [eq(aiActionProposals.organizationId, orgId)];
  if (filter.status) conditions.push(eq(aiActionProposals.status, filter.status));
  if (filter.kind) conditions.push(eq(aiActionProposals.kind, filter.kind));
  if (filter.sourceRef) {
    conditions.push(
      sql`${aiActionProposals.sourceRef} @> ${JSON.stringify(filter.sourceRef)}::jsonb`,
    );
  }
  return db
    .select()
    .from(aiActionProposals)
    .where(and(...conditions))
    .orderBy(sql`${aiActionProposals.createdAt} DESC`)
    .limit(filter.limit ?? 100);
}

/**
 * Claim a pending proposal (status-guarded UPDATE — double-approve safe) and
 * return the claimed row. Throws if the proposal is missing or not pending.
 */
async function claimPending(
  db: DbExecutor,
  orgId: string,
  proposalId: string,
  toStatus: AiProposalStatus,
  userId: string,
): Promise<ProposalRow> {
  const [claimed] = await db
    .update(aiActionProposals)
    .set({
      status: toStatus,
      approvedBy: toStatus === "rejected" ? null : userId,
      appliedAt: toStatus === "rejected" ? null : new Date(),
    })
    .where(
      and(
        eq(aiActionProposals.id, proposalId),
        eq(aiActionProposals.organizationId, orgId),
        eq(aiActionProposals.status, "pending"),
      ),
    )
    .returning();
  if (!claimed) {
    throw new Error("Proposal not found or no longer pending");
  }
  return claimed;
}

function assertApplierPermissions(
  ctx: ApplierContext,
  kind: AiProposalKind,
  payload: unknown,
): NonNullable<(typeof PROPOSAL_APPLIERS)[AiProposalKind]> {
  const applier = PROPOSAL_APPLIERS[kind];
  if (!applier) {
    throw new Error(`No applier registered for proposal kind "${kind}"`);
  }
  for (const perm of applier.requiredPermissions(payload)) {
    if (!roleHasPermission(ctx.role, perm.resource, perm.action)) {
      throw new AuthorizationError(perm.resource, perm.action);
    }
  }
  return applier;
}

async function recordFeedback(
  db: DbExecutor,
  input: {
    orgId: string;
    proposalId: string;
    invocationId: string | null;
    verdict: "accepted" | "corrected" | "rejected";
    correction?: Record<string, unknown>;
    userId: string;
  },
): Promise<void> {
  await db.insert(aiRunFeedback).values({
    organizationId: input.orgId,
    proposalId: input.proposalId,
    invocationId: input.invocationId,
    verdict: input.verdict,
    correction: input.correction,
    userId: input.userId,
  });
}

/** Load a pending proposal without claiming it (for pre-claim checks). */
async function loadPending(
  db: DbExecutor,
  orgId: string,
  proposalId: string,
): Promise<ProposalRow> {
  const [row] = await db
    .select()
    .from(aiActionProposals)
    .where(
      and(
        eq(aiActionProposals.id, proposalId),
        eq(aiActionProposals.organizationId, orgId),
        eq(aiActionProposals.status, "pending"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("Proposal not found or no longer pending");
  }
  return row;
}

/** Approve: apply the proposed payload as-is. */
export async function approveProposal(
  ctx: ApplierContext,
  proposalId: string,
): Promise<{ proposal: ProposalRow; result: Record<string, unknown> | null }> {
  // Permission check BEFORE the claim: a denied approval must leave the
  // proposal pending without relying on the caller's transaction to roll
  // the claim back.
  const pending = await loadPending(ctx.db, ctx.orgId, proposalId);
  assertApplierPermissions(ctx, pending.kind, pending.proposal);
  const claimed = await claimPending(ctx.db, ctx.orgId, proposalId, "approved", ctx.userId);
  const applier = assertApplierPermissions(ctx, claimed.kind, claimed.proposal);
  const result = await applier.apply(ctx, claimed.proposal);
  await recordFeedback(ctx.db, {
    orgId: ctx.orgId,
    proposalId: claimed.id,
    invocationId: claimed.invocationId,
    verdict: "accepted",
    userId: ctx.userId,
  });
  return { proposal: claimed, result };
}

/** Correct: apply the USER's corrected payload; the diff is the label. */
export async function correctProposal(
  ctx: ApplierContext,
  proposalId: string,
  correctedPayload: Record<string, unknown>,
): Promise<{ proposal: ProposalRow; result: Record<string, unknown> | null }> {
  const pending = await loadPending(ctx.db, ctx.orgId, proposalId);
  const schema = proposalPayloadSchemas[pending.kind];
  const corrected = schema.parse(correctedPayload) as Record<string, unknown>;
  assertApplierPermissions(ctx, pending.kind, corrected);
  const claimed = await claimPending(ctx.db, ctx.orgId, proposalId, "corrected", ctx.userId);
  const applier = assertApplierPermissions(ctx, claimed.kind, corrected);
  const result = await applier.apply(ctx, corrected);
  await recordFeedback(ctx.db, {
    orgId: ctx.orgId,
    proposalId: claimed.id,
    invocationId: claimed.invocationId,
    verdict: "corrected",
    correction: fieldDiff(claimed.proposal, corrected),
    userId: ctx.userId,
  });
  return { proposal: claimed, result };
}

/** Reject: no write; the rejection itself is the label. */
export async function rejectProposal(
  ctx: ApplierContext,
  proposalId: string,
  reason?: string,
): Promise<ProposalRow> {
  const claimed = await claimPending(ctx.db, ctx.orgId, proposalId, "rejected", ctx.userId);
  await recordFeedback(ctx.db, {
    orgId: ctx.orgId,
    proposalId: claimed.id,
    invocationId: claimed.invocationId,
    verdict: "rejected",
    correction: reason ? { reason } : undefined,
    userId: ctx.userId,
  });
  return claimed;
}

/**
 * Housekeeping: expire stale pending proposals. Returns the count expired.
 * Pass orgId when calling from an org-scoped path (e.g. opportunistically
 * before a list); omit only from a trusted cross-org maintenance job.
 */
export async function expireStaleProposals(
  db: DbExecutor,
  opts: { orgId?: string; now?: Date } = {},
): Promise<number> {
  const conditions = [
    eq(aiActionProposals.status, "pending"),
    lt(aiActionProposals.expiresAt, opts.now ?? new Date()),
  ];
  if (opts.orgId) conditions.push(eq(aiActionProposals.organizationId, opts.orgId));
  const expired = await db
    .update(aiActionProposals)
    .set({ status: "expired" })
    .where(and(...conditions))
    .returning({ id: aiActionProposals.id });
  return expired.length;
}

/** Field-level diff { field: { old, new } } — matches the activity_logs shape. */
export function fieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const oldVal = before[key];
    const newVal = after[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diff[key] = { old: oldVal ?? null, new: newVal ?? null };
    }
  }
  return diff;
}
