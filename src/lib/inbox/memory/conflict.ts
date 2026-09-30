// ============================================================================
// The memory_conflict finding (Inbox v2 §7): two remembered answers of the
// same specificity match one paper and disagree. Neither is applied and no
// model guesses in their place; this blocking system finding puts the paper
// in front of a person, with both answers in its evidence.
//
// Fingerprinted by candidate revision, like the book rules: every
// classification decides afresh, resolving the previous revision's finding
// before raising its own.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { reviewFindings } from "@/db/schema/inbox";
import type { MemoryMatchKind } from "./keys";
import type { MemoryAnswerGroup } from "./select";

export const MEMORY_CONFLICT_RULE_KEY = "memory_conflict";

const KIND_LABEL: Record<MemoryMatchKind, string> = {
  file_hash: "this file",
  sender_party: "this sender",
  party: "this party",
  line_text: "these words",
};

/** Resolve the open memory_conflict finding a previous classification raised. */
export async function resolveMemoryConflictFindings(
  db: DbExecutor,
  input: { orgId: string; inboxItemId: string },
): Promise<void> {
  await db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedAt: new Date(),
      resolutionNote: "Re-evaluated after the draft was classified.",
    })
    .where(
      and(
        eq(reviewFindings.organizationId, input.orgId),
        eq(reviewFindings.inboxItemId, input.inboxItemId),
        eq(reviewFindings.state, "open"),
        eq(reviewFindings.ruleKey, MEMORY_CONFLICT_RULE_KEY),
      ),
    );
}

export async function raiseMemoryConflictFinding(
  db: DbExecutor,
  input: {
    orgId: string;
    inboxItemId: string;
    candidateId: string;
    candidateRevision: number;
    matchKind: MemoryMatchKind;
    answers: readonly MemoryAnswerGroup[];
  },
): Promise<void> {
  const memoryCount = input.answers.reduce((count, group) => count + group.memoryIds.length, 0);
  await db
    .insert(reviewFindings)
    .values({
      organizationId: input.orgId,
      inboxItemId: input.inboxItemId,
      candidateId: input.candidateId,
      ruleKey: MEMORY_CONFLICT_RULE_KEY,
      impact: "blocking",
      subjectType: "transaction_candidate",
      subjectId: input.candidateId,
      fingerprint: `${input.candidateId}:${input.candidateRevision}:${MEMORY_CONFLICT_RULE_KEY}`,
      message: `${memoryCount} remembered answers for ${KIND_LABEL[input.matchKind]} disagree about this paper, so none was applied. Turn off the wrong one in Settings → Memories, then choose the answer here.`,
      evidence: {
        matchKind: input.matchKind,
        answers: input.answers.map((group) => ({
          memoryIds: group.memoryIds,
          docKind: group.application.docKind,
          partyId: group.application.partyId,
          lines: group.application.lines.map((line) => ({
            side: line.side,
            accountId: line.accountId,
          })),
        })),
      },
    })
    .onConflictDoNothing();
}
