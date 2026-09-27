// ============================================================================
// After stage 2: record Jev's proposal for its lane, and queue Jev's approval
// when the proposal already passes every check.
//
// Called from the classify_inbox_candidate job, inside the transaction that
// applies the classification (its beforeCommit hook), so the proposal record
// and the queued approval commit with the draft they describe. The approval
// job decides again from scratch under the candidate's lifecycle lock; this is
// only the "may pass" filter that keeps it from running for papers that
// cannot. It runs in a savepoint and never throws: a lane that cannot be
// recorded costs its label and nothing else — the classified draft still lands
// in the Inbox for a person.
// ============================================================================

import type { DbExecutor } from "@/db";
import { createLogger } from "@/lib/logger";
import { enqueueJevAutoApproval } from "./auto-approve";
import { recordJevProposal, type JevProposalRecord } from "./proposal";

const logger = createLogger("inbox.jev-proposal");

export async function recordJevProposalAfterClassification(
  tx: DbExecutor,
  input: { orgId: string; candidateId: string },
): Promise<JevProposalRecord | null> {
  try {
    return await tx.transaction(async (savepoint) => {
      const proposal = await recordJevProposal(savepoint, input);
      if (proposal?.evaluation.approve) {
        await enqueueJevAutoApproval(savepoint, {
          orgId: input.orgId,
          candidateId: input.candidateId,
          candidateRevision: proposal.candidateRevision,
        });
      }
      return proposal;
    });
  } catch (error) {
    logger.error("Jev proposal could not be recorded (the classified draft is kept)", {
      orgId: input.orgId,
      candidateId: input.candidateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
