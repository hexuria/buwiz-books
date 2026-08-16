/**
 * Typed processing-job handler registry and shared worker runner.
 *
 * Contract: the runner owns claim (via `claimNextProcessingJob`, restricted
 * to registered job types) and failure requeue (exponential backoff plus
 * terminal fencing). Handlers own the work — including any completion that
 * must be atomic with their final writes. A handler that RESOLVES has
 * completed its job (its result is returned to the scheduler; a
 * `processed: false` result signals a lost lease owned by a successor).
 * A handler that THROWS triggers the shared backoff-requeue logic.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { claimNextProcessingJob } from "@/lib/inbox/processing-job-lease";
import { terminalizeProcessingJobFailure } from "@/lib/inbox/terminal-processing-failure";
import { createLogger } from "@/lib/logger";
import { processBboxScanJob } from "./handlers/bbox-scan";
import { processCoaScaffoldJob } from "./handlers/coa-scaffold";
import { processMatchAssistJob } from "./handlers/match-assist";
import { processReflectionJob } from "./handlers/reflection";
import { processInboundEmailJob } from "./handlers/inbound-email";
import { processStandaloneDocumentJob } from "./handlers/standalone-document";
import { processStatementOcrJob } from "./handlers/statement-ocr";
import {
  BUSINESS_GROUP_PROJECTION_JOB_TYPE,
  processBusinessGroupProjectionJob,
} from "./handlers/business-group-projection";
import { retryPolicyFor } from "./retry-policy";

const logger = createLogger("api.internal.inbox-worker");

export interface JobContext {
  workerId: string;
}

export type ProcessingJob = typeof processingJobs.$inferSelect;

/**
 * Route-level result for one processed job. `processed: false` with
 * `reason: "lease_lost"` means a successor worker owns the job; extra
 * fields (e.g. documentId, skipped) are job-type specific.
 */
export interface JobHandlerResult {
  processed: boolean;
  jobId: string;
  reason?: string;
  [key: string]: unknown;
}

export type JobHandler = (job: ProcessingJob, ctx: JobContext) => Promise<JobHandlerResult>;

export const JOB_HANDLERS: Record<string, JobHandler> = {
  process_inbound_email: processInboundEmailJob,
  process_standalone_document: processStandaloneDocumentJob,
  statement_ocr: processStatementOcrJob,
  bbox_scan: processBboxScanJob,
  match_assist: processMatchAssistJob,
  ai_reflection: processReflectionJob,
  coa_scaffold: processCoaScaffoldJob,
  [BUSINESS_GROUP_PROJECTION_JOB_TYPE]: processBusinessGroupProjectionJob,
};

export const INBOX_JOB_TYPES = ["process_inbound_email", "process_standalone_document"];

/** Bounded drain: at most this many jobs are processed per worker request. */
export const MAX_JOBS_PER_REQUEST = 5;

/** Constant-time check of the worker Bearer secret. */
export function isWorkerRequestAuthorized(value: string | undefined, secret: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const token = value.slice(7);
  const left = Buffer.from(token);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Thrown by `runJobWorker` after a job failed and its backoff requeue was
 * recorded. Routes translate this into an HTTP 500 so the scheduler sees
 * the failure, exactly as the original single-purpose route did.
 */
export class ProcessingJobFailedError extends Error {
  readonly jobId: string;

  constructor(jobId: string, options?: { cause?: unknown }) {
    super("Inbox worker job failed.", options);
    this.name = "ProcessingJobFailedError";
    this.jobId = jobId;
  }
}

/**
 * Requeue a failed job with exponential backoff, or terminalize it once its
 * attempts are exhausted. Byte-equivalent to the original route's catch
 * block. Returns true when the lease was already lost (the error must be
 * ignored because a successor owns the job).
 */
async function requeueFailedProcessingJob(
  job: ProcessingJob,
  workerId: string,
  error: unknown,
): Promise<boolean> {
  const retry = job.attempts < job.maxAttempts;
  const delayMs = retryPolicyFor(job.jobType).backoffMs(job.attempts);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const [released] = await db.transaction(async (tx) => {
    const updated = await tx
      .update(processingJobs)
      .set({
        status: retry ? "queued" : "failed",
        runAt: new Date(Date.now() + delayMs),
        lockedBy: null,
        lockedUntil: null,
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(processingJobs.id, job.id),
          eq(processingJobs.status, "running"),
          eq(processingJobs.lockedBy, workerId),
        ),
      )
      .returning({ id: processingJobs.id });
    if (updated.length === 0 || retry) {
      return updated;
    }
    // Every job type gets a terminalization pass now. Previously this was
    // gated to inbound email, so an exhausted statement_ocr job left its
    // agent_run at `running` forever and the client poller could never
    // reach a terminal state — it could only time out.
    await terminalizeProcessingJobFailure(tx, {
      job,
      errorMessage,
    });
    return updated;
  });
  if (!released) {
    logger.warn("Inbox worker error ignored after lease ownership changed", {
      jobId: job.id,
      workerId,
      error: String(error),
    });
    return true;
  }
  logger.error("Inbox worker job failed", {
    jobId: job.id,
    attempts: job.attempts,
    retry,
    error: String(error),
  });
  return false;
}

export interface RunJobWorkerOptions {
  /** Restrict claims to these job types (filtered to registered handlers). */
  jobTypes?: string[];
  /** Maximum jobs to process in this request (bounded drain). Default 5. */
  maxJobs?: number;
}

export type RunJobWorkerResult =
  | { processed: false; reason: "queue_empty" | "no_registered_handlers" }
  | JobHandlerResult;

/**
 * Claim-and-process loop shared by the worker routes.
 *
 * Processes up to `maxJobs` claimable jobs of the allowed types. Never
 * claims a job type without a registered handler. On a handler error the
 * job is requeued with backoff and `ProcessingJobFailedError` is thrown
 * (jobs completed earlier in the same request stay completed — they are
 * durable). The response keeps the original single-job shape; when more
 * than one job was handled, a `drained` count is added.
 */
export async function runJobWorker(options: RunJobWorkerOptions = {}): Promise<RunJobWorkerResult> {
  const requestedTypes =
    options.jobTypes && options.jobTypes.length > 0 ? options.jobTypes : Object.keys(JOB_HANDLERS);
  const jobTypes = requestedTypes.filter((jobType) => jobType in JOB_HANDLERS);
  if (jobTypes.length === 0) {
    return { processed: false, reason: "no_registered_handlers" };
  }
  const maxJobs = Math.max(1, options.maxJobs ?? MAX_JOBS_PER_REQUEST);

  const results: JobHandlerResult[] = [];
  for (let index = 0; index < maxJobs; index += 1) {
    const workerId = `inbox-worker:${randomUUID()}`;
    const job = await claimNextProcessingJob(db, {
      workerId,
      now: new Date(),
      jobTypes,
    });
    if (!job) break;

    let result: JobHandlerResult;
    try {
      const handler = JOB_HANDLERS[job.jobType];
      if (!handler) throw new Error(`Unsupported Inbox job type: ${job.jobType}`);
      result = await handler(job, { workerId });
    } catch (error) {
      const leaseLost = await requeueFailedProcessingJob(job, workerId, error);
      if (leaseLost) {
        results.push({ processed: false, reason: "lease_lost", jobId: job.id });
        break;
      }
      throw new ProcessingJobFailedError(job.id, { cause: error });
    }
    results.push(result);
    // A lost lease means a successor worker owns the job — stop draining.
    if (!result.processed) break;
  }

  if (results.length === 0) return { processed: false, reason: "queue_empty" };
  if (results.length === 1) return results[0];
  return { ...results[0], drained: results.length };
}
