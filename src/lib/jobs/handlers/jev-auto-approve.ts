/**
 * Job handler for `jev_auto_approve` — Jev approving one Inbox paper through
 * its earned autonomy lane (src/lib/inbox/jev-approval/auto-approve.ts).
 *
 * The org comes from the job row, never the payload. The decision, the
 * approval (or the hold) and the job's completion commit in one org-context
 * transaction: a lost lease rolls the approval back with it, so a successor
 * cannot approve the same paper twice. A paper that no longer qualifies is a
 * completed job, not a failure — it simply stays in Needs you.
 */
import { withOrgContext } from "@/db";
import {
  runJevAutoApproval,
  type JevAutoApprovePayload,
} from "@/lib/inbox/jev-approval/auto-approve";
import { completeProcessingJob } from "@/lib/inbox/processing-job-lease";
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

class LeaseLostError extends Error {}

export async function processJevAutoApproveJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const payload = job.payload as Partial<JevAutoApprovePayload>;
  if (typeof payload.candidateId !== "string" || typeof payload.candidateRevision !== "number") {
    throw new Error("Jev auto-approval job payload is incomplete.");
  }
  const candidateId = payload.candidateId;
  const candidateRevision = payload.candidateRevision;
  try {
    const outcome = await withOrgContext(
      job.organizationId,
      JEV_AUDIT_ACTOR_ID,
      "admin",
      async (tx) => {
        const result = await runJevAutoApproval(tx, {
          orgId: job.organizationId,
          candidateId,
          candidateRevision,
        });
        if (!(await completeProcessingJob(tx, job.id, ctx.workerId))) throw new LeaseLostError();
        return result;
      },
    );
    return { processed: true, jobId: job.id, candidateId, ...outcome };
  } catch (error) {
    if (error instanceof LeaseLostError) {
      return { processed: false, reason: "lease_lost", jobId: job.id };
    }
    throw error;
  }
}
