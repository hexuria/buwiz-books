/**
 * Fires due schedule routines (Inbox v2 spec §3, build step 5).
 *
 * Called at the top of every worker drain pass that may run
 * `routine_schedule_run` jobs (runJobWorker), so the Cloud Scheduler tick
 * that drains the queue also fires due routines — there is no second
 * scheduler to deploy or forget.
 *
 * Two phases per pass:
 *   1. An unlocked cross-organization scan for due candidates. The scheduler
 *      has no organization by definition — the same position as the job
 *      claim in processing-job-lease.ts — and reads only (id, organization_id).
 *   2. Per routine, ONE transaction in that routine's org context: re-select
 *      it FOR UPDATE SKIP LOCKED with the due predicate, enqueue its
 *      `routine_schedule_run` job (dedupe_key `routine:<id>:<slot ISO>`), set
 *      last_run_at and advance next_run_at. A concurrent worker either skips
 *      the locked row or, once this commits, finds it no longer due, so each
 *      slot fires exactly once; the dedupe key backs that up at the job table.
 *
 * A late pass (no worker ran for a while) fires the missed slot once and
 * resumes at the next FUTURE slot — never a storm of every missed one.
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { processingJobs, workflowEvents } from "@/db/schema/inbox";
import { routines } from "@/db/schema/routines";
import { createLogger } from "@/lib/logger";
import { ROUTINE_SCHEDULE_RUN_JOB_TYPE, parseScheduleTriggerConfig } from "./config";
import { computeNextRunAt } from "./schedule";

const logger = createLogger("routines.scheduler");

/** Bounded like the job drain: the rest fire on the next pass. */
export const MAX_ROUTINES_PER_PASS = 25;

export type DueRoutineOutcome = "enqueued" | "already_enqueued" | "not_due" | "invalid_schedule";

export interface DueRoutineClaim {
  routineId: string;
  organizationId: string;
  outcome: DueRoutineOutcome;
  scheduledFor?: string;
  nextRunAt?: string | null;
  jobId?: string;
}

export function routineRunDedupeKey(routineId: string, slot: Date): string {
  return `routine:${routineId}:${slot.toISOString()}`;
}

/** Fire one due routine, in its own org-context transaction. */
export async function claimDueRoutine(
  candidate: { id: string; organizationId: string },
  now: Date,
): Promise<DueRoutineClaim> {
  const base = { routineId: candidate.id, organizationId: candidate.organizationId };
  return withOrgContext(
    candidate.organizationId,
    "system",
    "admin",
    async (tx): Promise<DueRoutineClaim> => {
      const [routine] = await tx
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.organizationId, candidate.organizationId),
            eq(routines.id, candidate.id),
            eq(routines.enabled, true),
            eq(routines.triggerKind, "schedule"),
            lte(routines.nextRunAt, now),
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      // Locked by a concurrent pass, already advanced, or disabled meanwhile.
      if (!routine?.nextRunAt) return { ...base, outcome: "not_due" };

      const slot = routine.nextRunAt;
      const config = parseScheduleTriggerConfig(routine.triggerConfig);
      if (!config) {
        // Unreadable schedule: stop firing and say why, rather than fail every
        // pass forever. A human fixes the config, which recomputes next_run_at.
        const reason = "The schedule configuration is invalid; the routine stopped firing.";
        await tx
          .update(routines)
          .set({ nextRunAt: null, lastError: reason, updatedAt: now })
          .where(
            and(eq(routines.organizationId, routine.organizationId), eq(routines.id, routine.id)),
          );
        await tx
          .insert(workflowEvents)
          .values({
            organizationId: routine.organizationId,
            entityType: "routine",
            entityId: routine.id,
            action: "routine_schedule_failed",
            actorType: "system",
            idempotencyKey: `routine:${routine.id}:invalid:${slot.toISOString()}`,
            data: { scheduledFor: slot.toISOString(), reason },
          })
          .onConflictDoNothing();
        return {
          ...base,
          outcome: "invalid_schedule",
          scheduledFor: slot.toISOString(),
          nextRunAt: null,
        };
      }

      const nextRunAt = computeNextRunAt(config, now);
      const [job] = await tx
        .insert(processingJobs)
        .values({
          organizationId: routine.organizationId,
          routineId: routine.id,
          jobType: ROUTINE_SCHEDULE_RUN_JOB_TYPE,
          dedupeKey: routineRunDedupeKey(routine.id, slot),
          payload: { routineId: routine.id, scheduledFor: slot.toISOString() },
        })
        .onConflictDoNothing()
        .returning({ id: processingJobs.id });
      await tx
        .update(routines)
        .set({ lastRunAt: now, nextRunAt, updatedAt: now })
        .where(
          and(eq(routines.organizationId, routine.organizationId), eq(routines.id, routine.id)),
        );
      return {
        ...base,
        outcome: job ? "enqueued" : "already_enqueued",
        scheduledFor: slot.toISOString(),
        nextRunAt: nextRunAt.toISOString(),
        ...(job ? { jobId: job.id } : {}),
      };
    },
  );
}

/** Enqueue a run for every due schedule routine (bounded per pass). */
export async function enqueueDueRoutineRuns(
  options: { now?: Date; limit?: number } = {},
): Promise<DueRoutineClaim[]> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, options.limit ?? MAX_ROUTINES_PER_PASS);
  // The scheduler's one cross-organization read: unlocked, ids only. Every
  // write happens below, in the owning organization's context.
  const candidates = await db
    .select({ id: routines.id, organizationId: routines.organizationId })
    .from(routines)
    .where(
      and(
        eq(routines.enabled, true),
        eq(routines.triggerKind, "schedule"),
        isNotNull(routines.nextRunAt),
        lte(routines.nextRunAt, now),
      ),
    )
    .orderBy(asc(routines.nextRunAt), asc(routines.id))
    .limit(limit);

  const claims: DueRoutineClaim[] = [];
  for (const candidate of candidates) {
    try {
      claims.push(await claimDueRoutine(candidate, now));
    } catch (error) {
      // One routine's failure must not stop the others from firing.
      logger.error("Could not fire a due routine", {
        routineId: candidate.id,
        organizationId: candidate.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return claims;
}
