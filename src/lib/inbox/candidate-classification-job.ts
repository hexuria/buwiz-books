// ============================================================================
// Enqueue side of inbox stage 2 (classify_inbox_candidate).
//
// Kept apart from the classifier so the enrichment path — which runs inside
// request transactions as well as worker ones — can queue the job without
// importing the AI façade. The job is keyed by candidate AND revision: a
// candidate re-enriched from new facts gets a fresh classification, and a
// job for an older revision finds the candidate moved on and skips.
// ============================================================================

import type { DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { retryPolicyFor } from "@/lib/jobs/retry-policy";

export const CLASSIFY_INBOX_CANDIDATE_JOB_TYPE = "classify_inbox_candidate";

/**
 * Bump when the classification contract changes, so a re-run is not deduped away.
 * 2: the memory layer answers before any model (inbox v2 step 10).
 */
export const CANDIDATE_CLASSIFICATION_VERSION = 2;

export interface ClassifyInboxCandidatePayload {
  candidateId: string;
  candidateRevision: number;
}

export function candidateClassificationDedupeKey(
  candidateId: string,
  candidateRevision: number,
): string {
  return `inbox-candidate-classification:v${CANDIDATE_CLASSIFICATION_VERSION}:${candidateId}:${candidateRevision}`;
}

/** Queue stage 2 for one candidate revision. Idempotent while the job is live. */
export async function enqueueCandidateClassification(
  db: DbExecutor,
  input: { orgId: string; candidateId: string; candidateRevision: number },
): Promise<string | null> {
  const payload: ClassifyInboxCandidatePayload = {
    candidateId: input.candidateId,
    candidateRevision: input.candidateRevision,
  };
  const [created] = await db
    .insert(processingJobs)
    .values({
      organizationId: input.orgId,
      jobType: CLASSIFY_INBOX_CANDIDATE_JOB_TYPE,
      dedupeKey: candidateClassificationDedupeKey(input.candidateId, input.candidateRevision),
      payload: { ...payload },
      maxAttempts: retryPolicyFor(CLASSIFY_INBOX_CANDIDATE_JOB_TYPE).maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  return created?.id ?? null;
}
