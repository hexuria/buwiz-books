// ============================================================================
// Lane feedback: a person's decision on a paper Jev proposed (Inbox v2 §8).
//
// Every human approval, rejection and correction of a candidate carrying a
// recorded proposal (./proposal.ts), and every undo of a Jev approval, labels
// that proposal ONCE for its lane (ai_run_feedback.label_key is unique):
//
//   approve  the entry as approved matches everything the proposal answered
//            -> accepted; anything it answered was changed -> corrected
//   correct  something the proposal answered changed -> corrected. A
//            correction that only fills what Jev left blank (the payment
//            side stage 2 never picks) is not a verdict yet: the approval
//            that follows labels it against the same proposal
//   reject   -> rejected
//   undo     a person reversed Jev's own approval -> rejected
//
// "What the proposal answered" is its date, currency, counterparty (when it
// named one) and every line: account (when it chose one), side and amount.
// Amounts count because an approval posts them: an extraction error a person
// had to fix is a paper Jev should not have approved.
//
// The label carries the lane's view at proposal time — confidence, whether
// Jev would have approved it and why not, spot check — so agreement and
// calibration are computed per lane. After each new label the lane's
// demotion check runs; it is never allowed to fail the person's action.
// ============================================================================

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { aiAutonomyLanes, aiRunFeedback } from "@/db/schema/ai";
import { workflowEvents } from "@/db/schema/inbox";
import { demoteLaneIfSlipped } from "@/lib/ai/autonomy-lanes";
import { createLogger } from "@/lib/logger";
import { compareMoney } from "../money";
import {
  JEV_LANE_KEY,
  JEV_PROPOSAL_RECORDED_ACTION,
  latestJevProposal,
  type JevEntrySnapshot,
} from "./proposal";

const logger = createLogger("inbox.jev-lane-feedback");

/** The job's record of a paper it held instead of approving (./auto-approve.ts). */
export const JEV_AUTO_APPROVAL_HELD_ACTION = "jev_auto_approval_held";

export type JevLaneFeedbackAction = "approve" | "reject" | "correct" | "undo";
export type JevLaneVerdict = "accepted" | "corrected" | "rejected";

export interface ProposalComparison {
  same: boolean;
  changes: Record<string, { old: unknown; new: unknown }>;
}

type SnapshotLine = JevEntrySnapshot["lines"][number];

function sideOf(line: SnapshotLine): { side: "debit" | "credit" | null; amount: string | null } {
  if (line.debit != null && line.debit !== "") return { side: "debit", amount: line.debit };
  if (line.credit != null && line.credit !== "") return { side: "credit", amount: line.credit };
  return { side: null, amount: null };
}

function sameMoney(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return compareMoney(left, right) === 0;
}

/**
 * Pair every proposed line with a distinct decided line of the same side and
 * amount — and the same account where the proposal chose one. Accounts are
 * matched first, so a blank proposed line cannot claim a line an answered one
 * needs.
 */
function linesMatch(proposed: readonly SnapshotLine[], decided: readonly SnapshotLine[]): boolean {
  if (proposed.length !== decided.length) return false;
  const used = new Set<number>();
  const ordered = [
    ...proposed.filter((line) => line.accountId),
    ...proposed.filter((line) => !line.accountId),
  ];
  for (const line of ordered) {
    const want = sideOf(line);
    const index = decided.findIndex((candidate, position) => {
      if (used.has(position)) return false;
      const have = sideOf(candidate);
      if (have.side !== want.side || !sameMoney(have.amount, want.amount)) return false;
      return !line.accountId || candidate.accountId === line.accountId;
    });
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

/** Whether the decided entry keeps everything the proposal answered. Pure. */
export function compareWithProposal(
  proposal: JevEntrySnapshot,
  decided: JevEntrySnapshot,
): ProposalComparison {
  const changes: ProposalComparison["changes"] = {};
  if (proposal.transactionDate !== decided.transactionDate) {
    changes.transactionDate = { old: proposal.transactionDate, new: decided.transactionDate };
  }
  if (proposal.currency !== decided.currency) {
    changes.currency = { old: proposal.currency, new: decided.currency };
  }
  if (proposal.partyId !== null && proposal.partyId !== decided.partyId) {
    changes.partyId = { old: proposal.partyId, new: decided.partyId };
  }
  if (!linesMatch(proposal.lines, decided.lines)) {
    changes.lines = { old: proposal.lines, new: decided.lines };
  }
  return { same: Object.keys(changes).length === 0, changes };
}

/** Whether the paper was held back as a spot check at this revision. */
async function heldForSpotCheck(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
  revision: number,
): Promise<boolean> {
  const [held] = await db
    .select({ id: workflowEvents.id })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.organizationId, orgId),
        eq(workflowEvents.entityType, "transaction_candidate"),
        eq(workflowEvents.entityId, candidateId),
        inArray(workflowEvents.action, [
          JEV_PROPOSAL_RECORDED_ACTION,
          JEV_AUTO_APPROVAL_HELD_ACTION,
        ]),
        sql`${workflowEvents.data}->>'candidateRevision' = ${String(revision)}`,
        sql`${workflowEvents.data}->'evaluation'->>'heldForSpotCheck' = 'true'`,
      ),
    )
    .limit(1);
  return Boolean(held);
}

export interface JevLaneLabel {
  feedbackId: string;
  laneId: string | null;
  verdict: JevLaneVerdict;
}

/**
 * Label the candidate's proposal for its lane, if it has one and it is not
 * labeled yet. Runs in the decision's own transaction, so the label and the
 * decision commit together.
 */
export async function recordJevLaneFeedback(
  db: DbExecutor,
  input: {
    orgId: string;
    candidateId: string;
    inboxItemId: string;
    action: JevLaneFeedbackAction;
    userId: string;
    /** The entry as the person approved or corrected it. */
    decided?: JevEntrySnapshot;
    note?: string | null;
  },
): Promise<JevLaneLabel | null> {
  const proposal = await latestJevProposal(db, input.orgId, input.candidateId);
  if (!proposal) return null;

  let verdict: JevLaneVerdict;
  let correction: Record<string, unknown> | null = null;
  if (input.action === "reject" || input.action === "undo") {
    verdict = "rejected";
    correction = { action: input.action, ...(input.note ? { note: input.note } : {}) };
  } else {
    if (!input.decided) throw new Error(`A ${input.action} label needs the decided entry.`);
    const comparison = compareWithProposal(proposal.snapshot, input.decided);
    if (comparison.same) {
      // Filling blanks is not a verdict; the approval that follows decides.
      if (input.action === "correct") return null;
      verdict = "accepted";
    } else {
      verdict = "corrected";
      correction = comparison.changes;
    }
  }

  // A lane can disappear under its label (its party was deleted); the label
  // stays, without a lane.
  const [lane] = await db
    .select({ id: aiAutonomyLanes.id })
    .from(aiAutonomyLanes)
    .where(
      and(eq(aiAutonomyLanes.organizationId, input.orgId), eq(aiAutonomyLanes.id, proposal.laneId)),
    )
    .limit(1);
  const laneId = lane?.id ?? null;

  const [inserted] = await db
    .insert(aiRunFeedback)
    .values({
      organizationId: input.orgId,
      laneId,
      verdict,
      correction,
      userId: input.userId,
      labelKey: `${JEV_LANE_KEY}:${input.candidateId}:${proposal.candidateRevision}`,
      laneEvidence: {
        laneKey: JEV_LANE_KEY,
        candidateId: input.candidateId,
        inboxItemId: input.inboxItemId,
        proposalRevision: proposal.candidateRevision,
        action: input.action,
        source: proposal.source,
        kind: proposal.kind,
        partyId: proposal.partyId,
        confidence: proposal.confidence,
        laneLevel: proposal.evaluation.laneLevel,
        wouldApprove: proposal.evaluation.wouldApprove,
        holds: proposal.evaluation.holds.map((hold) => hold.reason),
        threshold: proposal.evaluation.threshold,
        spotCheck: await heldForSpotCheck(
          db,
          input.orgId,
          input.candidateId,
          proposal.candidateRevision,
        ),
        autoApproved: input.action === "undo",
      },
    })
    .onConflictDoNothing()
    .returning({ id: aiRunFeedback.id });
  if (!inserted) return null;

  if (laneId) {
    try {
      // A savepoint: a failed check rolls back alone and never aborts the
      // person's decision, which has already been written.
      await db.transaction((savepoint) =>
        demoteLaneIfSlipped(savepoint, {
          orgId: input.orgId,
          laneId,
          triggeredBy: input.userId,
          inboxItemId: input.inboxItemId,
          feedbackId: inserted.id,
        }),
      );
    } catch (error) {
      logger.error("Lane demotion check failed (the label is recorded)", {
        orgId: input.orgId,
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { feedbackId: inserted.id, laneId, verdict };
}
