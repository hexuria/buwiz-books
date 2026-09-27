// ============================================================================
// Jev approves a paper (Inbox v2 spec §8, build step 11).
//
// The `jev_auto_approve` job is enqueued after stage 2 when the paper's
// proposal already passed every check (./after-classification.ts). It then
// decides again, from scratch, under the candidate's lifecycle lock — the
// lock every approval, correction and rejection takes — with the paper's lane
// and the organization's Jev settings share-locked, so a demotion or a switch
// turned off cannot land halfway through:
//
//   held      any check fails (a person edited it, a finding appeared, the
//             period closed, the lane was demoted, the switch is off, the
//             paper was sampled as a spot check). The paper stays in Needs
//             you; a `jev_auto_approval_held` workflow event says why.
//   approved  approveInboxItem runs — the same function a person's approval
//             runs, through the same posting cores — as the system actor
//             carrying a grant minted here, and only here, for this paper.
//
// The approval runs in a savepoint: if it refuses the paper (any error),
// nothing it wrote survives and the paper is held with the refusal as the
// reason. Every failure degrades to Needs you, never to wrong books.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { inboxItems, processingJobs, workflowEvents } from "@/db/schema/inbox";
import { findAutonomyLane } from "@/lib/ai/autonomy-lanes";
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import { retryPolicyFor } from "@/lib/jobs/retry-policy";
import { mintJevApprovalGrant } from "@/lib/posting/system-approval-grant";
import { lockInboxCandidateLifecycle } from "../lifecycle-lock";
import { approveInboxItem } from "../service";
import { JEV_AUTO_APPROVAL_HELD_ACTION } from "./feedback";
import { evaluateJevApproval, type JevHold } from "./predicate";
import {
  evaluationRecordOf,
  jevApprovalInputOf,
  JEV_LANE_KEY,
  loadJevPaperFacts,
  type JevEvaluationRecord,
} from "./proposal";
import { loadJevApprovalSettings } from "./settings";

export const JEV_AUTO_APPROVE_JOB_TYPE = "jev_auto_approve";

export interface JevAutoApprovePayload {
  candidateId: string;
  candidateRevision: number;
}

/** Queue Jev's approval of one candidate revision. Idempotent while the job is live. */
export async function enqueueJevAutoApproval(
  db: DbExecutor,
  input: { orgId: string; candidateId: string; candidateRevision: number },
): Promise<string | null> {
  const payload: JevAutoApprovePayload = {
    candidateId: input.candidateId,
    candidateRevision: input.candidateRevision,
  };
  const [created] = await db
    .insert(processingJobs)
    .values({
      organizationId: input.orgId,
      jobType: JEV_AUTO_APPROVE_JOB_TYPE,
      dedupeKey: `jev-auto-approve:${input.candidateId}:${input.candidateRevision}`,
      payload: { ...payload },
      maxAttempts: retryPolicyFor(JEV_AUTO_APPROVE_JOB_TYPE).maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  return created?.id ?? null;
}

export type JevAutoApprovalOutcome =
  | { status: "skipped"; reason: "not_found" | "stale_revision" | "not_proposed" }
  | { status: "held"; holds: JevHold[]; heldForSpotCheck: boolean }
  | { status: "approved"; journalHeaderId: string; billId: string | null; laneId: string };

async function recordHold(
  db: DbExecutor,
  input: {
    orgId: string;
    inboxItemId: string;
    candidateId: string;
    candidateRevision: number;
    laneId: string | null;
    evaluation: JevEvaluationRecord;
  },
): Promise<void> {
  await db
    .insert(workflowEvents)
    .values({
      organizationId: input.orgId,
      inboxItemId: input.inboxItemId,
      entityType: "transaction_candidate",
      entityId: input.candidateId,
      action: JEV_AUTO_APPROVAL_HELD_ACTION,
      actorType: "system",
      actorId: JEV_AUDIT_ACTOR_ID,
      idempotencyKey: `jev-auto-approval-held:${input.candidateId}:${input.candidateRevision}`,
      data: {
        candidateRevision: input.candidateRevision,
        laneId: input.laneId,
        evaluation: { ...input.evaluation },
      },
    })
    .onConflictDoNothing();
}

/** Decide, and if every check passes, approve. Runs in the job's org-context transaction. */
export async function runJevAutoApproval(
  tx: DbExecutor,
  input: { orgId: string; candidateId: string; candidateRevision: number },
): Promise<JevAutoApprovalOutcome> {
  const { orgId } = input;
  const [identity] = await tx
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(and(eq(inboxItems.organizationId, orgId), eq(inboxItems.candidateId, input.candidateId)))
    .limit(1);
  if (!identity) return { status: "skipped", reason: "not_found" };
  const lifecycle = await lockInboxCandidateLifecycle(tx, orgId, identity.id);
  if (!lifecycle) return { status: "skipped", reason: "not_found" };
  // A person (or new facts) moved the paper on: this proposal is not what is there now.
  if (lifecycle.candidate.revision !== input.candidateRevision) {
    return { status: "skipped", reason: "stale_revision" };
  }

  const facts = await loadJevPaperFacts(tx, orgId, input.candidateId);
  if (!facts?.answer) return { status: "skipped", reason: "not_proposed" };
  const lane = await findAutonomyLane(
    tx,
    orgId,
    { laneKey: JEV_LANE_KEY, partyId: facts.candidate.partyId, docKind: facts.kind },
    { lock: "share" },
  );
  const settings = await loadJevApprovalSettings(tx, orgId, { lock: "share" });
  const approvalInput = jevApprovalInputOf(facts, lane, settings);
  const decision = evaluateJevApproval(approvalInput);
  const evaluation = evaluationRecordOf(approvalInput, decision);
  const holdWith = async (holds: JevHold[]) => {
    const record = {
      ...evaluation,
      approve: false,
      heldForSpotCheck: decision.heldForSpotCheck,
      holds,
    };
    await recordHold(tx, {
      orgId,
      inboxItemId: facts.item.id,
      candidateId: facts.candidate.id,
      candidateRevision: facts.candidate.revision,
      laneId: lane?.id ?? null,
      evaluation: record,
    });
    return { status: "held", holds, heldForSpotCheck: record.heldForSpotCheck } as const;
  };
  if (!decision.approve || !lane || facts.answer.confidence === null) {
    return holdWith(decision.holds);
  }

  const grant = mintJevApprovalGrant({
    laneId: lane.id,
    candidateId: facts.candidate.id,
    candidateRevision: facts.candidate.revision,
    confidence: facts.answer.confidence,
  });
  try {
    const result = await tx.transaction((savepoint) =>
      approveInboxItem(
        { db: savepoint, orgId, userId: JEV_AUDIT_ACTOR_ID, role: "system" },
        {
          inboxItemId: facts.item.id,
          expectedRevision: facts.candidate.revision,
          expectedLockVersion: facts.item.lockVersion,
        },
        {
          systemApproval: {
            grant,
            laneId: lane.id,
            confidence: facts.answer!.confidence!,
            ruleSnapshotId: facts.ruleSet?.snapshotId ?? null,
            makerCheckerOptIn: settings.makerCheckerOptIn,
          },
        },
      ),
    );
    if (result.approvalOutcome === "blocked") {
      // The duplicate engine found a case at the last gate; it stays open for a person.
      return holdWith([{ reason: "duplicate_case", scope: "paper", detail: result.caseId }]);
    }
    return {
      status: "approved",
      journalHeaderId: result.journalHeaderId,
      billId: result.billId ?? null,
      laneId: lane.id,
    };
  } catch (error) {
    return holdWith([
      {
        reason: "approval_refused",
        scope: "paper",
        detail: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
