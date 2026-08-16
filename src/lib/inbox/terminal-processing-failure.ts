import { and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import {
  inboxItems,
  ingestionEvents,
  reviewFindings,
  sourceRecords,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { failRun } from "@/lib/ai/agent-run";

interface TerminalProcessingJob {
  id: string;
  organizationId: string;
  ingestionEventId: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

interface InboundEmailJobPayload {
  emailId?: string;
  sourceRecordId?: string;
  inboxItemId?: string;
}

/**
 * Terminalize the agent_run behind a failed pipeline job.
 *
 * Only job types that carry a `runId` in their payload can be resolved here.
 * `match_assist` creates its run inside the handler and fails it in its own
 * catch, and `bbox_scan` has no run at all — for those the processing_jobs
 * row with its `lastError` is the durable record.
 */
async function terminalizeAgentRunFailure(
  db: DbExecutor,
  job: TerminalProcessingJob,
  errorMessage: string,
) {
  const runId = (job.payload as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    return { workflowTerminalized: false, reason: "no_workflow" as const };
  }

  await failRun(
    db,
    runId,
    {
      kind: "job_exhausted",
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      error: errorMessage,
    },
    // Org-scoped: this path is reachable from a job payload with no session
    // context, so the run id alone must not be enough to write a row.
    job.organizationId,
  );
  return { workflowTerminalized: true, reason: "agent_run_failed" as const, runId };
}

/**
 * Apply the durable workflow side effects for a terminal processing failure.
 *
 * The processing_jobs row is fenced and transitioned by the caller. This
 * helper deliberately revalidates the Inbox lifecycle under row locks so an
 * expired or stale job can never reopen an already approved, rejected, or
 * superseded candidate.
 */
export async function terminalizeProcessingJobFailure(
  db: DbExecutor,
  input: {
    job: TerminalProcessingJob;
    errorMessage: string;
    now?: Date;
  },
) {
  const { job, errorMessage } = input;
  const now = input.now ?? new Date();

  // Non-inbound job types used to return here untouched, which meant an
  // exhausted statement_ocr job flipped its processing_jobs row to `failed`
  // while its agent_run stayed `running` forever — so the client poller
  // could never observe a terminal state and only ever timed out.
  if (job.jobType !== "process_inbound_email") {
    return terminalizeAgentRunFailure(db, job, errorMessage);
  }

  const payload = job.payload as InboundEmailJobPayload;
  let candidateId: string | null = null;
  let inboxItemId: string | null = null;

  if (payload.inboxItemId) {
    const [lifecycle] = await db
      .select({
        inboxItemId: inboxItems.id,
        inboxState: inboxItems.state,
        candidateId: transactionCandidates.id,
        candidateStatus: transactionCandidates.status,
      })
      .from(inboxItems)
      .innerJoin(transactionCandidates, eq(inboxItems.candidateId, transactionCandidates.id))
      .where(
        and(
          eq(inboxItems.organizationId, job.organizationId),
          eq(inboxItems.id, payload.inboxItemId),
        ),
      )
      .for("update", { of: [inboxItems, transactionCandidates] })
      .limit(1);

    if (
      lifecycle &&
      lifecycle.candidateId &&
      lifecycle.candidateStatus === "current" &&
      ["received", "processing", "needs_information", "ready_for_review"].includes(
        lifecycle.inboxState,
      )
    ) {
      inboxItemId = lifecycle.inboxItemId;
      candidateId = lifecycle.candidateId;
      await db
        .update(inboxItems)
        .set({
          state: "needs_information",
          lockVersion: sql`${inboxItems.lockVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(inboxItems.organizationId, job.organizationId),
            eq(inboxItems.id, lifecycle.inboxItemId),
          ),
        );
    }
  }

  // If the original candidate has already left its active review lifecycle,
  // keep the failed job terminal but do not mutate closed accounting evidence.
  if (!inboxItemId || !candidateId) {
    return { workflowTerminalized: false, reason: "lifecycle_closed" as const };
  }

  await db
    .insert(reviewFindings)
    .values({
      organizationId: job.organizationId,
      inboxItemId,
      candidateId,
      ruleKey: "source_processing_failed",
      impact: "blocking",
      subjectType: "processing_job",
      subjectId: job.id,
      fingerprint: `${candidateId}:source-processing-failed:${job.id}`,
      message: `Inbound email processing failed after ${job.attempts} attempt(s)${
        errorMessage ? ` (${errorMessage})` : ""
      }. The email and its attachments are safely stored. Retry processing, or resolve this finding with a documented exception.`,
      evidence: {
        source: "resend",
        emailId: payload.emailId,
        jobId: job.id,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: errorMessage,
      },
    })
    .onConflictDoUpdate({
      target: [reviewFindings.organizationId, reviewFindings.fingerprint],
      set: {
        state: "open",
        evidence: {
          source: "resend",
          emailId: payload.emailId,
          jobId: job.id,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          error: errorMessage,
        },
        lastSeenAt: now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
      },
    });

  await db
    .insert(workflowEvents)
    .values({
      organizationId: job.organizationId,
      inboxItemId,
      entityType: "processing_job",
      entityId: job.id,
      action: "source_processing_failed",
      actorType: "system",
      idempotencyKey: `inbox-job:${job.id}:terminal-failure`,
      data: {
        source: "resend",
        emailId: payload.emailId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: errorMessage,
      },
    })
    .onConflictDoNothing();

  if (payload.sourceRecordId) {
    await db
      .update(sourceRecords)
      .set({
        providerStatus: "processing_failed",
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceRecords.organizationId, job.organizationId),
          eq(sourceRecords.id, payload.sourceRecordId),
        ),
      );
  }
  if (job.ingestionEventId) {
    await db
      .update(ingestionEvents)
      .set({
        status: "failed",
        attempts: job.attempts,
        lastError: errorMessage,
        processedAt: now,
      })
      .where(
        and(
          eq(ingestionEvents.organizationId, job.organizationId),
          eq(ingestionEvents.id, job.ingestionEventId),
        ),
      );
  }

  return { workflowTerminalized: true, reason: "terminalized" as const };
}
