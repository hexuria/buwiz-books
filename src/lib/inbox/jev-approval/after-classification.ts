// ============================================================================
// After stage 2: record Jev's proposal for its lane.
//
// Called from the classify_inbox_candidate job, inside the transaction that
// applies the classification (its beforeCommit hook), so the proposal record
// commits with the draft it describes. It runs in a savepoint and never
// throws: a lane that cannot be recorded costs its label and nothing else —
// the classified draft still lands in the Inbox for a person.
// ============================================================================

import type { DbExecutor } from "@/db";
import { createLogger } from "@/lib/logger";
import { recordJevProposal, type JevProposalRecord } from "./proposal";

const logger = createLogger("inbox.jev-proposal");

export async function recordJevProposalAfterClassification(
  tx: DbExecutor,
  input: { orgId: string; candidateId: string },
): Promise<JevProposalRecord | null> {
  try {
    return await tx.transaction((savepoint) => recordJevProposal(savepoint, input));
  } catch (error) {
    logger.error("Jev proposal could not be recorded (the classified draft is kept)", {
      orgId: input.orgId,
      candidateId: input.candidateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
