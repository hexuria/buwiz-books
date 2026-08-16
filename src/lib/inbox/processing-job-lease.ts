import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { terminalizeProcessingJobFailure } from "./terminal-processing-failure";

export const DEFAULT_PROCESSING_JOB_LEASE_MS = 5 * 60_000;

export interface ProcessingJobLeaseSnapshot {
  status: string;
  runAt: Date;
  lockedUntil: Date | null;
  attempts: number;
  maxAttempts: number;
}

export interface ClaimProcessingJobOptions {
  workerId: string;
  now?: Date;
  leaseMs?: number;
  /**
   * Restrict the claim to these job types. Required in practice: a worker
   * tick dispatching a specific registry subset must not claim-and-fail a
   * job type it cannot handle, and a targeted self-trigger (e.g. statement
   * OCR) must not queue behind an unrelated backlog.
   */
  jobTypes?: string[];
}

export function isProcessingJobExpiredAndExhausted(
  job: ProcessingJobLeaseSnapshot,
  now: Date,
): boolean {
  return (
    job.status === "running" &&
    job.attempts >= job.maxAttempts &&
    (job.lockedUntil === null || job.lockedUntil <= now)
  );
}

export async function expireExhaustedProcessingJobs(database: DbExecutor, now: Date) {
  const expired = await database
    .update(processingJobs)
    .set({
      status: "failed",
      lockedBy: null,
      lockedUntil: null,
      lastError: sql`coalesce(${processingJobs.lastError}, 'Final processing attempt expired before completion.')`,
      updatedAt: now,
    })
    .where(
      and(
        eq(processingJobs.status, "running"),
        gte(processingJobs.attempts, processingJobs.maxAttempts),
        or(isNull(processingJobs.lockedUntil), lte(processingJobs.lockedUntil, now)),
      ),
    )
    .returning();

  for (const job of expired) {
    await terminalizeProcessingJobFailure(database, {
      job,
      errorMessage: job.lastError ?? "Final processing attempt expired before completion.",
      now,
    });
  }
  return expired;
}

/**
 * Pure lease predicate shared with focused tests.
 *
 * A queued job must be due. A running job is recoverable only after its lease
 * expires (or when legacy data has no lease). Exhausted jobs are never claimed.
 */
export function isProcessingJobClaimable(job: ProcessingJobLeaseSnapshot, now: Date): boolean {
  if (job.attempts >= job.maxAttempts) return false;
  if (job.status === "queued") return job.runAt <= now;
  if (job.status === "running") {
    return job.lockedUntil === null || job.lockedUntil <= now;
  }
  return false;
}

/**
 * Claim one due or abandoned job under a row lock.
 *
 * `FOR UPDATE SKIP LOCKED` ensures concurrent workers cannot claim the same
 * lease. Every claim receives a caller-unique worker ID; terminal updates must
 * include that ID so a slow, expired worker cannot overwrite its successor.
 */
export async function claimNextProcessingJob(
  database: DbExecutor,
  options: ClaimProcessingJobOptions,
) {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_PROCESSING_JOB_LEASE_MS;
  if (!options.workerId.trim()) throw new Error("A processing-job worker ID is required.");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("Processing-job lease duration must be positive.");
  }

  return database.transaction(async (tx) => {
    // A worker can crash after claiming the final allowed attempt. Such a row is
    // intentionally not claimable again, but it also must not remain "running"
    // forever. Expiring it first clears the previous lease owner, so any stale
    // terminal update remains fenced by its `status = running AND locked_by = …`
    // predicate and cannot overwrite the failed state.
    await expireExhaustedProcessingJobs(tx, now);

    const [available] = await tx
      .select()
      .from(processingJobs)
      .where(
        and(
          lt(processingJobs.attempts, processingJobs.maxAttempts),
          or(
            and(eq(processingJobs.status, "queued"), lte(processingJobs.runAt, now)),
            and(
              eq(processingJobs.status, "running"),
              or(isNull(processingJobs.lockedUntil), lte(processingJobs.lockedUntil, now)),
            ),
          ),
          ...(options.jobTypes && options.jobTypes.length > 0
            ? [inArray(processingJobs.jobType, options.jobTypes)]
            : []),
        ),
      )
      .orderBy(asc(processingJobs.runAt), asc(processingJobs.createdAt))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!available) return null;
    if (!isProcessingJobClaimable(available, now)) return null;

    const [claimed] = await tx
      .update(processingJobs)
      .set({
        status: "running",
        lockedBy: options.workerId,
        lockedUntil: new Date(now.getTime() + leaseMs),
        attempts: available.attempts + 1,
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(processingJobs.id, available.id))
      .returning();
    return claimed ?? null;
  });
}

/**
 * Extend a held lease mid-job (long multi-stage handlers extend between
 * stages so a slow stage doesn't look abandoned). Fenced by worker ID:
 * only the current lease owner can extend.
 */
export async function extendProcessingJobLease(
  database: DbExecutor,
  jobId: string,
  workerId: string,
  leaseMs: number = DEFAULT_PROCESSING_JOB_LEASE_MS,
  now: Date = new Date(),
): Promise<boolean> {
  const extended = await database
    .update(processingJobs)
    .set({ lockedUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(
      and(
        eq(processingJobs.id, jobId),
        eq(processingJobs.status, "running"),
        eq(processingJobs.lockedBy, workerId),
      ),
    )
    .returning({ id: processingJobs.id });
  return extended.length > 0;
}
