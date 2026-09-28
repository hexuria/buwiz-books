/**
 * Job handler for `routine_schedule_run` (Inbox v2 spec §3, build step 5).
 *
 * Runs the schedule source a routine names (`trigger_config.source`, see
 * src/lib/routines/schedule-sources.ts) and records the run in
 * workflow_events. No real source exists yet; `noop` records the run and
 * fetches nothing.
 *
 * The routine is read inside withOrgContext(job.organizationId) and must
 * belong to that organization — the payload alone decides nothing. The source
 * runs OUTSIDE any transaction (it owns its own I/O and saves); the run record,
 * cursor, and fenced completion then commit together.
 */
import { and, eq } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { workflowEvents } from "@/db/schema/inbox";
import { routines } from "@/db/schema/routines";
import { completeProcessingJob } from "@/lib/inbox/processing-job-lease";
import { createLogger } from "@/lib/logger";
import { parseScheduleTriggerConfig } from "@/lib/routines/config";
import { getScheduleSource } from "@/lib/routines/schedule-sources";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.routine-schedule-run");

type SkipReason =
  | "routine_missing"
  | "not_a_schedule"
  | "routine_disabled"
  | "invalid_schedule"
  | "unknown_source"
  | "invalid_payload";

/** Reasons that mean the routine is misconfigured, not merely paused. */
const FAILURE_REASONS: ReadonlySet<SkipReason> = new Set(["invalid_schedule", "unknown_source"]);

export async function processRoutineScheduleRunJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const orgTx = <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
    withOrgContext(job.organizationId, "system", "admin", fn);
  const scheduledForRaw = (job.payload as { scheduledFor?: unknown }).scheduledFor;
  const scheduledFor =
    typeof scheduledForRaw === "string" && !Number.isNaN(Date.parse(scheduledForRaw))
      ? new Date(scheduledForRaw)
      : null;

  const routineId = job.routineId;
  const routine = routineId
    ? await orgTx(async (tx) => {
        const [row] = await tx
          .select()
          .from(routines)
          .where(and(eq(routines.organizationId, job.organizationId), eq(routines.id, routineId)))
          .limit(1);
        return row ?? null;
      })
    : null;
  const config = routine ? parseScheduleTriggerConfig(routine.triggerConfig) : null;
  const source = config ? getScheduleSource(config.source) : null;

  let skipReason: SkipReason | null = null;
  if (!routine) skipReason = "routine_missing";
  else if (routine.triggerKind !== "schedule") skipReason = "not_a_schedule";
  // Disabled after the slot was enqueued: the pause wins.
  else if (!routine.enabled) skipReason = "routine_disabled";
  else if (!config) skipReason = "invalid_schedule";
  else if (!source) skipReason = "unknown_source";
  else if (!scheduledFor) skipReason = "invalid_payload";

  if (skipReason || !routine || !config || !source || !scheduledFor) {
    const reason = skipReason ?? "invalid_payload";
    const failed = FAILURE_REASONS.has(reason);
    const detail =
      reason === "unknown_source"
        ? `Unknown schedule source "${config?.source}".`
        : reason === "invalid_schedule"
          ? "The schedule configuration is invalid."
          : null;
    const completed = await orgTx(async (tx) => {
      if (!(await completeProcessingJob(tx, job.id, ctx.workerId))) return false;
      if (!routine) return true;
      if (failed) {
        await tx
          .update(routines)
          .set({ lastError: detail, updatedAt: new Date() })
          .where(and(eq(routines.organizationId, job.organizationId), eq(routines.id, routine.id)));
      }
      await tx
        .insert(workflowEvents)
        .values({
          organizationId: job.organizationId,
          entityType: "routine",
          entityId: routine.id,
          action: failed ? "routine_schedule_failed" : "routine_schedule_skipped",
          actorType: "system",
          idempotencyKey: `routine:${routine.id}:job:${job.id}:${reason}`,
          data: {
            jobId: job.id,
            reason,
            detail,
            scheduledFor: scheduledFor?.toISOString() ?? null,
          },
        })
        .onConflictDoNothing();
      return true;
    });
    if (!completed) return { processed: false, reason: "lease_lost", jobId: job.id };
    logger.warn("Schedule routine run skipped", { jobId: job.id, routineId, reason });
    return { processed: true, jobId: job.id, skipped: reason };
  }

  const result = await source.run({
    organizationId: job.organizationId,
    routineId: routine.id,
    cursor: routine.cursor,
    scheduledFor,
  });

  const finalized = await orgTx(async (tx) => {
    if (!(await completeProcessingJob(tx, job.id, ctx.workerId))) return false;
    await tx
      .update(routines)
      .set({
        lastError: null,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(routines.organizationId, job.organizationId), eq(routines.id, routine.id)));
    await tx
      .insert(workflowEvents)
      .values({
        organizationId: job.organizationId,
        entityType: "routine",
        entityId: routine.id,
        action: "routine_schedule_run",
        actorType: "system",
        // One record per slot, however many times a lost lease re-runs it.
        idempotencyKey: `routine:${routine.id}:run:${scheduledFor.toISOString()}`,
        data: {
          jobId: job.id,
          source: config.source,
          scheduledFor: scheduledFor.toISOString(),
          summary: result.summary,
        },
      })
      .onConflictDoNothing();
    return true;
  });
  if (!finalized) {
    logger.warn("Schedule routine lease expired before completion; successor owns the job", {
      jobId: job.id,
      workerId: ctx.workerId,
    });
    return { processed: false, reason: "lease_lost", jobId: job.id };
  }
  return { processed: true, jobId: job.id, routineId: routine.id, source: config.source };
}
