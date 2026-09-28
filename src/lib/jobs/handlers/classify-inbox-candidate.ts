/**
 * Job handler for `classify_inbox_candidate` — inbox stage 2.
 *
 * Enqueued by candidate enrichment for one candidate revision. The org comes
 * from the job row, never the payload; the classifier runs every DB phase in
 * its own short withOrgContext transaction and calls the models between them.
 *
 * The job completes INSIDE the apply transaction (the classifier's
 * beforeCommit hook), so the classified draft and the completed job commit
 * together. The same hook records Jev's proposal for its approval lane
 * (src/lib/inbox/jev-approval), which never fails the classification. A skip — the candidate moved on, closed, or was already edited by
 * a reviewer — completes the job on its own. Model failures never throw: they
 * degrade the draft to "Needs you". Only a database error throws, which
 * requeues the job with backoff; until it succeeds the draft keeps its
 * placeholder lines and the blocking `uncategorized` finding it was born with.
 */
import { withOrgContext } from "@/db";
import { completeProcessingJob } from "@/lib/inbox/processing-job-lease";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import { recordJevProposalAfterClassification } from "@/lib/inbox/jev-approval/after-classification";
import type { ClassifyInboxCandidatePayload } from "@/lib/inbox/candidate-classification-job";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

export async function processClassifyInboxCandidateJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const payload = job.payload as Partial<ClassifyInboxCandidatePayload>;
  if (typeof payload.candidateId !== "string" || typeof payload.candidateRevision !== "number") {
    throw new Error("Inbox candidate classification job payload is incomplete.");
  }
  const orgId = job.organizationId;

  const result = await classifyInboxCandidate(
    { orgId, candidateId: payload.candidateId, candidateRevision: payload.candidateRevision },
    {
      beforeCommit: async (tx) => {
        if (!(await completeProcessingJob(tx, job.id, ctx.workerId))) return false;
        await recordJevProposalAfterClassification(tx, {
          orgId,
          candidateId: payload.candidateId!,
        });
        return true;
      },
    },
  );

  if (result.status === "lease_lost") {
    return { processed: false, reason: "lease_lost", jobId: job.id };
  }
  if (result.status === "skipped") {
    const completed = await withOrgContext(orgId, "system", "admin", (tx) =>
      completeProcessingJob(tx, job.id, ctx.workerId),
    );
    if (!completed) return { processed: false, reason: "lease_lost", jobId: job.id };
    return {
      processed: true,
      jobId: job.id,
      candidateId: payload.candidateId,
      skipped: result.reason,
    };
  }
  return {
    processed: true,
    jobId: job.id,
    candidateId: payload.candidateId,
    candidateRevision: result.candidateRevision,
    categoryLines: result.categoryLines,
    party: result.party,
    memory: {
      outcome: result.memory.outcome,
      matchKind: result.memory.matchKind,
      memoryIds: result.memory.memoryIds,
    },
    readyForReview: result.readyForReview,
    paymentDetailsChanged: result.paymentDetailsChanged,
    findingCount: result.findingCount,
  };
}
