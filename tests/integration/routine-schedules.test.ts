/**
 * Schedule routines through the worker drain (Inbox v2 §3, build step 5).
 *
 * A fake clock (`now`) drives every claim, so the assertions are about slots,
 * not wall time. Pinned:
 *   - concurrent claims of one due routine produce exactly one job;
 *   - a claim advances next_run_at and a repeat pass does not refire the slot;
 *   - a late pass fires the missed slot once and resumes in the future;
 *   - disabled routines never fire, and a routine disabled after its slot was
 *     enqueued is skipped by the handler;
 *   - the handler runs the named schedule source and records the run.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/trigger", () => ({ triggerWorker: vi.fn() }));

import { db, withOrgContext, type DbExecutor } from "@/db";
import { organization, user } from "@/db/schema/auth";
import { processingJobs, workflowEvents } from "@/db/schema/inbox";
import { routines } from "@/db/schema/routines";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { processRoutineScheduleRunJob } from "@/lib/jobs/handlers/routine-schedule-run";
import {
  JOB_HANDLERS,
  runJobWorker,
  type JobContext,
  type ProcessingJob,
} from "@/lib/jobs/registry";
import { ROUTINE_SCHEDULE_RUN_JOB_TYPE } from "@/lib/routines/config";
import { computeNextRunAt, type ScheduleConfig } from "@/lib/routines/schedule";
import { SCHEDULE_SOURCES } from "@/lib/routines/schedule-sources";
import { claimDueRoutine, enqueueDueRoutineRuns } from "@/lib/routines/scheduler";
import { createRoutine, setRoutineEnabled, updateRoutine } from "@/lib/routines/service";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** 14:00 in Manila is 06:00 UTC every day of the year (no DST). */
const MANILA_DAILY: ScheduleConfig = { preset: "daily", at: "14:00", timezone: "Asia/Manila" };
const SLOT = new Date("2031-03-10T06:00:00.000Z");
const NEXT_SLOT = new Date("2031-03-11T06:00:00.000Z");

const createdOrgs: string[] = [];
const registeredSources: string[] = [];
const registeredJobTypes: string[] = [];

async function createOrg(label: string): Promise<string> {
  const orgId = `${label}-${randomUUID()}`;
  await db.insert(organization).values({ id: orgId, name: "Schedule Co", slug: orgId });
  createdOrgs.push(orgId);
  return orgId;
}

async function insertScheduleRoutine(
  orgId: string,
  options: {
    nextRunAt: Date | null;
    enabled?: boolean;
    config?: Record<string, unknown>;
  },
) {
  const [row] = await db
    .insert(routines)
    .values({
      organizationId: orgId,
      name: "Nightly pull",
      enabled: options.enabled ?? true,
      triggerKind: "schedule",
      triggerConfig: options.config ?? { ...MANILA_DAILY, source: "noop" },
      nextRunAt: options.nextRunAt,
    })
    .returning();
  return row;
}

async function jobsFor(routineId: string) {
  return db.select().from(processingJobs).where(eq(processingJobs.routineId, routineId));
}

async function readRoutine(routineId: string) {
  const [row] = await db.select().from(routines).where(eq(routines.id, routineId));
  return row;
}

async function claimForTest(job: ProcessingJob): Promise<{ job: ProcessingJob; ctx: JobContext }> {
  const workerId = `schedule-test-${randomUUID()}`;
  const [claimed] = await db
    .update(processingJobs)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedUntil: new Date(Date.now() + 60_000),
      attempts: job.attempts + 1,
    })
    .where(eq(processingJobs.id, job.id))
    .returning();
  return { job: claimed, ctx: { workerId } };
}

function registerSource(run: (typeof SCHEDULE_SOURCES)[string]["run"]): string {
  const key = `test_${randomUUID().slice(0, 8)}`;
  SCHEDULE_SOURCES[key] = { label: "test source", run };
  registeredSources.push(key);
  return key;
}

afterAll(async () => {
  for (const key of registeredSources) delete SCHEDULE_SOURCES[key];
  for (const jobType of registeredJobTypes) delete JOB_HANDLERS[jobType];
  // Cascades to routines and their jobs, so nothing due is left behind for
  // any later drain.
  if (createdOrgs.length > 0) {
    await db.delete(organization).where(inArray(organization.id, createdOrgs));
  }
});

describeDb("schedule routines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("claiming due routines", () => {
    it("produces exactly one job when concurrent claims race for the same slot", async () => {
      const orgId = await createOrg("sched-race");
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: SLOT });
      const now = new Date(SLOT.getTime() + 30_000);

      const direct = await Promise.all([
        claimDueRoutine(routine, now),
        claimDueRoutine(routine, now),
        claimDueRoutine(routine, now),
      ]);
      expect(direct.filter(({ outcome }) => outcome === "enqueued")).toHaveLength(1);
      expect(direct.filter(({ outcome }) => outcome === "not_due")).toHaveLength(2);

      // Whole passes racing too — the loser skips the locked or advanced row.
      const second = await insertScheduleRoutine(orgId, { nextRunAt: SLOT });
      const passes = await Promise.all(
        Array.from({ length: 4 }, () => enqueueDueRoutineRuns({ now, limit: 1000 })),
      );
      const enqueuedForSecond = passes
        .flat()
        .filter(({ routineId, outcome }) => routineId === second.id && outcome === "enqueued");
      expect(enqueuedForSecond).toHaveLength(1);

      for (const target of [routine, second]) {
        const jobs = await jobsFor(target.id);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          organizationId: orgId,
          jobType: ROUTINE_SCHEDULE_RUN_JOB_TYPE,
          status: "queued",
          dedupeKey: `routine:${target.id}:${SLOT.toISOString()}`,
          payload: { routineId: target.id, scheduledFor: SLOT.toISOString() },
        });
      }
    });

    it("advances next_run_at, and a repeat pass does not refire the slot", async () => {
      const orgId = await createOrg("sched-advance");
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: SLOT });
      const now = new Date(SLOT.getTime() + 5_000);

      expect(await claimDueRoutine(routine, now)).toMatchObject({
        outcome: "enqueued",
        scheduledFor: SLOT.toISOString(),
        nextRunAt: NEXT_SLOT.toISOString(),
      });
      const advanced = await readRoutine(routine.id);
      expect(advanced.nextRunAt?.toISOString()).toBe(NEXT_SLOT.toISOString());
      expect(advanced.lastRunAt?.toISOString()).toBe(now.toISOString());

      expect(await claimDueRoutine(routine, now)).toMatchObject({ outcome: "not_due" });
      expect(await jobsFor(routine.id)).toHaveLength(1);

      // The next slot fires on its own time, with its own dedupe key.
      const later = new Date(NEXT_SLOT.getTime() + 1_000);
      expect(await claimDueRoutine(routine, later)).toMatchObject({ outcome: "enqueued" });
      const jobs = await jobsFor(routine.id);
      expect(jobs.map(({ dedupeKey }) => dedupeKey).sort()).toEqual([
        `routine:${routine.id}:${SLOT.toISOString()}`,
        `routine:${routine.id}:${NEXT_SLOT.toISOString()}`,
      ]);
      expect((await readRoutine(routine.id)).nextRunAt?.toISOString()).toBe(
        "2031-03-12T06:00:00.000Z",
      );
    });

    it("fires a missed slot once and resumes at the next future slot", async () => {
      const orgId = await createOrg("sched-missed");
      const threeDaysLate = new Date("2031-03-13T09:00:00.000Z");
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: SLOT });

      expect(await claimDueRoutine(routine, threeDaysLate)).toMatchObject({
        outcome: "enqueued",
        scheduledFor: SLOT.toISOString(),
        nextRunAt: "2031-03-14T06:00:00.000Z",
      });
      expect(await claimDueRoutine(routine, threeDaysLate)).toMatchObject({ outcome: "not_due" });
      expect(await jobsFor(routine.id)).toHaveLength(1);
    });

    it("never fires a disabled routine", async () => {
      const orgId = await createOrg("sched-disabled");
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: SLOT, enabled: false });
      const now = new Date(SLOT.getTime() + 60_000);

      const claims = await enqueueDueRoutineRuns({ now, limit: 1000 });
      expect(claims.some(({ routineId }) => routineId === routine.id)).toBe(false);
      expect(await claimDueRoutine(routine, now)).toMatchObject({ outcome: "not_due" });
      expect(await jobsFor(routine.id)).toHaveLength(0);
      expect((await readRoutine(routine.id)).nextRunAt?.toISOString()).toBe(SLOT.toISOString());
    });

    it("lets the dedupe key absorb a slot whose job already exists", async () => {
      const orgId = await createOrg("sched-dedupe");
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: SLOT });
      // As if a crashed pass had enqueued the slot without advancing it.
      await db.insert(processingJobs).values({
        organizationId: orgId,
        routineId: routine.id,
        jobType: ROUTINE_SCHEDULE_RUN_JOB_TYPE,
        dedupeKey: `routine:${routine.id}:${SLOT.toISOString()}`,
        payload: { routineId: routine.id, scheduledFor: SLOT.toISOString() },
      });

      expect(await claimDueRoutine(routine, new Date(SLOT.getTime() + 1_000))).toMatchObject({
        outcome: "already_enqueued",
        nextRunAt: NEXT_SLOT.toISOString(),
      });
      expect(await jobsFor(routine.id)).toHaveLength(1);
    });

    it("stops firing an unreadable schedule and says why", async () => {
      const orgId = await createOrg("sched-invalid");
      const routine = await insertScheduleRoutine(orgId, {
        nextRunAt: SLOT,
        // Weekly without a weekday cannot mean one thing.
        config: { preset: "weekly", at: "09:00", timezone: "Asia/Manila", source: "noop" },
      });

      expect(await claimDueRoutine(routine, new Date(SLOT.getTime() + 1_000))).toMatchObject({
        outcome: "invalid_schedule",
        nextRunAt: null,
      });
      const stopped = await readRoutine(routine.id);
      expect(stopped.nextRunAt).toBeNull();
      expect(stopped.lastError).toMatch(/invalid/);
      expect(await jobsFor(routine.id)).toHaveLength(0);
      const [event] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.entityId, routine.id),
            eq(workflowEvents.action, "routine_schedule_failed"),
          ),
        );
      expect(event).toMatchObject({ organizationId: orgId, entityType: "routine" });
    });
  });

  describe("routine_schedule_run", () => {
    async function enqueueOne(orgId: string, config?: Record<string, unknown>) {
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: SLOT, config });
      await claimDueRoutine(routine, new Date(SLOT.getTime() + 1_000));
      const [job] = await jobsFor(routine.id);
      return { routine, job: job as ProcessingJob };
    }

    it("runs the noop source and records the run in workflow_events", async () => {
      const orgId = await createOrg("sched-run");
      const { routine, job } = await enqueueOne(orgId);
      const { job: claimed, ctx } = await claimForTest(job);

      await expect(processRoutineScheduleRunJob(claimed, ctx)).resolves.toMatchObject({
        processed: true,
        routineId: routine.id,
        source: "noop",
      });
      const [completed] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, job.id));
      expect(completed.status).toBe("completed");
      const [run] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.entityId, routine.id),
            eq(workflowEvents.action, "routine_schedule_run"),
          ),
        );
      expect(run).toMatchObject({
        organizationId: orgId,
        entityType: "routine",
        actorType: "system",
        data: {
          jobId: job.id,
          source: "noop",
          scheduledFor: SLOT.toISOString(),
          summary: { fetched: 0 },
        },
      });
    });

    it("hands the source its routine and slot, and persists the cursor it returns", async () => {
      const orgId = await createOrg("sched-cursor");
      const calls: unknown[] = [];
      const source = registerSource(async (input) => {
        calls.push(input);
        return { cursor: "page-2", summary: { fetched: 3 } };
      });
      const { routine, job } = await enqueueOne(orgId, { ...MANILA_DAILY, source });
      const { job: claimed, ctx } = await claimForTest(job);

      await processRoutineScheduleRunJob(claimed, ctx);
      expect(calls).toEqual([
        { organizationId: orgId, routineId: routine.id, cursor: null, scheduledFor: SLOT },
      ]);
      expect((await readRoutine(routine.id)).cursor).toBe("page-2");
    });

    it("lets a failing source throw so the runner retries with backoff", async () => {
      const orgId = await createOrg("sched-throws");
      const source = registerSource(async () => {
        throw new Error("provider unavailable");
      });
      const { routine, job } = await enqueueOne(orgId, { ...MANILA_DAILY, source });
      const { job: claimed, ctx } = await claimForTest(job);

      await expect(processRoutineScheduleRunJob(claimed, ctx)).rejects.toThrow(
        "provider unavailable",
      );
      const [stillRunning] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, job.id));
      expect(stillRunning.status).toBe("running");
      expect((await readRoutine(routine.id)).cursor).toBeNull();
      // Retire it so a later drain in this file never reclaims a throwing job.
      await db
        .update(processingJobs)
        .set({ status: "failed" })
        .where(eq(processingJobs.id, job.id));
    });

    it("skips a routine disabled after its slot was enqueued, without running the source", async () => {
      const orgId = await createOrg("sched-paused");
      const run = vi.fn(async () => ({ summary: {} }));
      const source = registerSource(run);
      const { routine, job } = await enqueueOne(orgId, { ...MANILA_DAILY, source });
      await db.update(routines).set({ enabled: false }).where(eq(routines.id, routine.id));
      const { job: claimed, ctx } = await claimForTest(job);

      await expect(processRoutineScheduleRunJob(claimed, ctx)).resolves.toMatchObject({
        processed: true,
        skipped: "routine_disabled",
      });
      expect(run).not.toHaveBeenCalled();
      const [skipped] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.entityId, routine.id),
            eq(workflowEvents.action, "routine_schedule_skipped"),
          ),
        );
      expect(skipped.data).toMatchObject({ reason: "routine_disabled", jobId: job.id });
    });

    it("records an unknown source as a routine failure", async () => {
      const orgId = await createOrg("sched-unknown");
      const { routine, job } = await enqueueOne(orgId, {
        ...MANILA_DAILY,
        source: "retired_source",
      });
      const { job: claimed, ctx } = await claimForTest(job);

      await expect(processRoutineScheduleRunJob(claimed, ctx)).resolves.toMatchObject({
        processed: true,
        skipped: "unknown_source",
      });
      expect((await readRoutine(routine.id)).lastError).toBe(
        'Unknown schedule source "retired_source".',
      );
      const [failed] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.entityId, routine.id),
            eq(workflowEvents.action, "routine_schedule_failed"),
          ),
        );
      expect(failed).toBeTruthy();
    });
  });

  describe("the worker drain", () => {
    it("fires due routines and runs them in the same pass", async () => {
      const orgId = await createOrg("sched-drain");
      // Due now in real time: the drain uses the real clock.
      const routine = await insertScheduleRoutine(orgId, {
        nextRunAt: new Date(Date.now() - 60_000),
      });

      await runJobWorker({ jobTypes: [ROUTINE_SCHEDULE_RUN_JOB_TYPE], maxJobs: 50 });

      const [job] = await jobsFor(routine.id);
      expect(job).toMatchObject({ status: "completed" });
      const after = await readRoutine(routine.id);
      expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("leaves schedules alone on a pass restricted to other job types", async () => {
      const orgId = await createOrg("sched-nudge");
      const dueAt = new Date(Date.now() - 60_000);
      const routine = await insertScheduleRoutine(orgId, { nextRunAt: dueAt });
      const otherType = `test_nudge_${randomUUID().slice(0, 8)}`;
      JOB_HANDLERS[otherType] = async (job) => ({ processed: true, jobId: job.id });
      registeredJobTypes.push(otherType);

      await runJobWorker({ jobTypes: [otherType] });

      expect(await jobsFor(routine.id)).toHaveLength(0);
      expect((await readRoutine(routine.id)).nextRunAt?.toISOString()).toBe(dueAt.toISOString());
      // Leave nothing due behind for other suites' drains.
      await db.update(routines).set({ enabled: false }).where(eq(routines.id, routine.id));
    });
  });
});

describeDb("setting a schedule", () => {
  async function createChartedTenant() {
    const suffix = randomUUID();
    const orgId = `sched-set-org-${suffix}`;
    const userId = `sched-set-user-${suffix}`;
    await db.insert(user).values({
      id: userId,
      name: "Schedule Admin",
      email: `${suffix}@schedules.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({ id: orgId, name: "Schedule Co", slug: orgId });
    createdOrgs.push(orgId);
    await withOrgContext(orgId, userId, "admin", async (tx) => {
      const snapshot = await loadCoaSnapshot(tx, orgId);
      await executeCoaPlan(
        tx,
        orgId,
        planCoaPreset(snapshot, COA_PRESETS.general_small_business, { onConflict: "renumber" }),
        null,
      );
    });
    const asOrg = <T>(fn: (tx: DbExecutor) => Promise<T>) =>
      withOrgContext(orgId, userId, "admin", fn);
    return { orgId, userId, asOrg };
  }

  it("computes the first next_run_at on create, update, and enable; clears it on disable", async () => {
    const { orgId, userId, asOrg } = await createChartedTenant();
    const now = new Date("2031-03-10T02:00:00.000Z"); // 10:00 in Manila

    const created = await asOrg((tx) =>
      createRoutine(tx, {
        orgId,
        actorId: userId,
        now,
        routine: {
          triggerKind: "schedule",
          name: "Afternoon pull",
          schedule: MANILA_DAILY,
          source: "noop",
        },
      }),
    );
    expect(created).toMatchObject({
      triggerKind: "schedule",
      enabled: true,
      triggerConfig: { preset: "daily", at: "14:00", timezone: "Asia/Manila", source: "noop" },
    });
    expect(created.nextRunAt?.toISOString()).toBe(SLOT.toISOString());

    const weekly: ScheduleConfig = {
      preset: "weekly",
      at: "09:00",
      weekday: 5,
      timezone: "America/New_York",
    };
    const updated = await asOrg((tx) =>
      updateRoutine(tx, {
        orgId,
        actorId: userId,
        now,
        update: { routineId: created.id, schedule: weekly },
      }),
    );
    expect(updated.triggerConfig).toMatchObject({ ...weekly, source: "noop" });
    expect(updated.nextRunAt?.toISOString()).toBe(computeNextRunAt(weekly, now).toISOString());

    const disabled = await asOrg((tx) =>
      setRoutineEnabled(tx, { orgId, actorId: userId, routineId: created.id, enabled: false, now }),
    );
    expect(disabled.nextRunAt).toBeNull();

    // Re-enabling long after resumes at the next future slot, not a backlog.
    const muchLater = new Date("2031-06-01T00:00:00.000Z");
    const enabled = await asOrg((tx) =>
      setRoutineEnabled(tx, {
        orgId,
        actorId: userId,
        routineId: created.id,
        enabled: true,
        now: muchLater,
      }),
    );
    expect(enabled.nextRunAt?.toISOString()).toBe(
      computeNextRunAt(weekly, muchLater).toISOString(),
    );
  });

  it("rejects unknown sources and schedules on webhook routines", async () => {
    const { orgId, userId, asOrg } = await createChartedTenant();
    await expect(
      asOrg((tx) =>
        createRoutine(tx, {
          orgId,
          actorId: userId,
          routine: {
            triggerKind: "schedule",
            name: "Nope",
            schedule: MANILA_DAILY,
            source: "not_registered",
          },
        }),
      ),
    ).rejects.toThrow(/Unknown schedule source/);

    const webhook = await asOrg((tx) =>
      createRoutine(tx, {
        orgId,
        actorId: userId,
        routine: { triggerKind: "webhook", name: "Hook" },
      }),
    );
    await expect(
      asOrg((tx) =>
        updateRoutine(tx, {
          orgId,
          actorId: userId,
          update: { routineId: webhook.id, schedule: MANILA_DAILY },
        }),
      ),
    ).rejects.toThrow("Only a schedule routine has a schedule.");
  });

  it("still needs a chart of accounts to enable a schedule", async () => {
    const orgId = await createOrg("sched-no-chart");
    const userId = `sched-no-chart-user-${randomUUID()}`;
    await db.insert(user).values({
      id: userId,
      name: "No Chart",
      email: `${userId}@schedules.test`,
      emailVerified: true,
    });
    await expect(
      withOrgContext(orgId, userId, "admin", (tx) =>
        createRoutine(tx, {
          orgId,
          actorId: userId,
          routine: {
            triggerKind: "schedule",
            name: "Too early",
            schedule: MANILA_DAILY,
            source: "noop",
          },
        }),
      ),
    ).rejects.toThrow("Set up your chart of accounts first.");
  });
});
