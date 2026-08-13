/**
 * Integration tests for `runJobWorker` — the claim-and-drain loop every worker
 * route runs, and the one piece of the job queue nothing covered.
 *
 * Unlike the per-handler suites, these jobs are seeded as `queued`: exercising
 * the CLAIM is the point, so nothing here is pre-leased. Handlers are fakes
 * registered into the exported `JOB_HANDLERS` record, and each fake performs
 * its own fenced completion update — that is the registry's documented handler
 * contract, not a shortcut.
 *
 * The load-bearing case is `terminalizes the agent run behind an exhausted
 * statement_ocr job`. Terminalization used to be gated to inbound email, so an
 * exhausted pipeline job flipped its own row to `failed` while its agent_run
 * stayed `running` forever — the client poller could never observe a terminal
 * state and could only ever time out.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/facade", () => ({ aiComplete: vi.fn() }));
vi.mock("@/lib/jobs/trigger", () => ({ triggerWorker: vi.fn() }));

import { db } from "@/db";
import { agentRuns } from "@/db/schema/ai";
import { organization } from "@/db/schema/auth";
import { processingJobs } from "@/db/schema/inbox";
import {
  JOB_HANDLERS,
  ProcessingJobFailedError,
  runJobWorker,
  type JobContext,
  type JobHandler,
  type ProcessingJob,
} from "@/lib/jobs/registry";
import { retryPolicyFor } from "@/lib/jobs/retry-policy";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const registeredJobTypes: string[] = [];

/**
 * Register a fake handler under a job type unique to this run.
 *
 * Unique rather than fixed on purpose: these tests intentionally leave rows
 * behind (a requeued job, an undrained third job) and there is no truncation
 * between suites, so a fixed type would let one run's leftovers be claimed by
 * the next.
 */
function registerFakeJobType(handler: JobHandler): string {
  const jobType = `test_drain_${randomUUID().slice(0, 8)}`;
  JOB_HANDLERS[jobType] = handler;
  registeredJobTypes.push(jobType);
  return jobType;
}

/**
 * The handler contract: a handler owns its own completion, fenced by the
 * worker ID it was handed, so a slow predecessor can never overwrite the state
 * its successor already wrote.
 */
async function completeUnderLease(job: ProcessingJob, ctx: JobContext) {
  const [completed] = await db
    .update(processingJobs)
    .set({
      status: "completed",
      lockedBy: null,
      lockedUntil: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processingJobs.id, job.id),
        eq(processingJobs.status, "running"),
        eq(processingJobs.lockedBy, ctx.workerId),
      ),
    )
    .returning({ id: processingJobs.id });
  return Boolean(completed);
}

async function createOrg(label: string): Promise<string> {
  const orgId = `${label}-${randomUUID()}`;
  await db.insert(organization).values({ id: orgId, name: "Drain Co", slug: orgId });
  return orgId;
}

interface SeedOptions {
  orgId: string;
  jobType: string;
  runAt?: Date;
  attempts?: number;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
}

async function seedQueuedJob(options: SeedOptions): Promise<ProcessingJob> {
  const [job] = await db
    .insert(processingJobs)
    .values({
      organizationId: options.orgId,
      jobType: options.jobType,
      status: "queued",
      attempts: options.attempts ?? 0,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      runAt: options.runAt ?? new Date(Date.now() - 60_000),
      payload: options.payload ?? {},
    })
    .returning();
  return job as ProcessingJob;
}

async function readJob(jobId: string) {
  const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
  return row;
}

describeDb("runJobWorker", () => {
  let sqlClient: postgres.Sql;

  beforeAll(async () => {
    ({ sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    for (const jobType of registeredJobTypes) delete JOB_HANDLERS[jobType];
    registeredJobTypes.length = 0;
    await sqlClient.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims a due job, dispatches it, and leaves it completed and unlocked", async () => {
    const seen: JobContext[] = [];
    const jobType = registerFakeJobType(async (job, ctx) => {
      seen.push(ctx);
      await completeUnderLease(job, ctx);
      return { processed: true, jobId: job.id };
    });
    const orgId = await createOrg("drain-ok");
    const seeded = await seedQueuedJob({ orgId, jobType });

    const result = await runJobWorker({ jobTypes: [jobType] });

    expect(result).toMatchObject({ processed: true, jobId: seeded.id });
    expect(result).not.toHaveProperty("drained");
    expect(seen).toHaveLength(1);
    // Each claim gets a caller-unique worker ID; the handler is fenced by it.
    expect(seen[0].workerId).toMatch(/^inbox-worker:/);

    const job = await readJob(seeded.id);
    expect(job).toMatchObject({ status: "completed", attempts: 1, lockedBy: null });
    expect(job.lockedUntil).toBeNull();
    expect(job.completedAt).not.toBeNull();
  });

  it("never claims a job type outside the requested filter", async () => {
    const handled: string[] = [];
    const claimedType = registerFakeJobType(async (job, ctx) => {
      handled.push(job.id);
      await completeUnderLease(job, ctx);
      return { processed: true, jobId: job.id };
    });
    const otherType = registerFakeJobType(async (job, ctx) => {
      handled.push(job.id);
      await completeUnderLease(job, ctx);
      return { processed: true, jobId: job.id };
    });
    const orgId = await createOrg("drain-filter");
    const seeded = await seedQueuedJob({ orgId, jobType: claimedType });

    const result = await runJobWorker({ jobTypes: [otherType] });

    expect(result).toEqual({ processed: false, reason: "queue_empty" });
    expect(handled).toEqual([]);
    // A targeted tick must leave the untargeted job exactly as it found it.
    expect(await readJob(seeded.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("stops at maxJobs and reports how many it drained", async () => {
    const jobType = registerFakeJobType(async (job, ctx) => {
      await completeUnderLease(job, ctx);
      return { processed: true, jobId: job.id };
    });
    const orgId = await createOrg("drain-bounded");
    const seeded = await Promise.all([
      seedQueuedJob({ orgId, jobType, runAt: new Date(Date.now() - 300_000) }),
      seedQueuedJob({ orgId, jobType, runAt: new Date(Date.now() - 200_000) }),
      seedQueuedJob({ orgId, jobType, runAt: new Date(Date.now() - 100_000) }),
    ]);

    const result = await runJobWorker({ jobTypes: [jobType], maxJobs: 2 });

    expect(result).toMatchObject({ processed: true, drained: 2 });
    const statuses = await Promise.all(seeded.map((job) => readJob(job.id)));
    expect(statuses.filter((job) => job.status === "completed")).toHaveLength(2);
    // The bound is a bound: the third job is still there for the next tick.
    expect(statuses.filter((job) => job.status === "queued")).toHaveLength(1);
  });

  it("does not claim a job whose runAt is still in the future", async () => {
    const handled: string[] = [];
    const jobType = registerFakeJobType(async (job, ctx) => {
      handled.push(job.id);
      await completeUnderLease(job, ctx);
      return { processed: true, jobId: job.id };
    });
    const orgId = await createOrg("drain-future");
    const seeded = await seedQueuedJob({
      orgId,
      jobType,
      runAt: new Date(Date.now() + 3_600_000),
    });

    const result = await runJobWorker({ jobTypes: [jobType] });

    expect(result).toEqual({ processed: false, reason: "queue_empty" });
    expect(handled).toEqual([]);
    expect(await readJob(seeded.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("requeues a failed job with the job type's backoff and rethrows", async () => {
    const jobType = registerFakeJobType(async () => {
      throw new Error("handler blew up");
    });
    const orgId = await createOrg("drain-retry");
    const seeded = await seedQueuedJob({ orgId, jobType });
    const expectedDelayMs = retryPolicyFor(jobType).backoffMs(1);

    const failedAt = Date.now();
    await expect(runJobWorker({ jobTypes: [jobType] })).rejects.toBeInstanceOf(
      ProcessingJobFailedError,
    );

    const job = await readJob(seeded.id);
    expect(job).toMatchObject({
      status: "queued",
      attempts: 1,
      lockedBy: null,
      lastError: "handler blew up",
    });
    expect(job.lockedUntil).toBeNull();
    // The requeue delay comes from the retry policy, not a hardcoded formula.
    const delayMs = job.runAt.getTime() - failedAt;
    expect(delayMs).toBeGreaterThan(expectedDelayMs - 15_000);
    expect(delayMs).toBeLessThan(expectedDelayMs + 15_000);
  });

  it("carries the failing job id on the thrown error", async () => {
    const jobType = registerFakeJobType(async () => {
      throw new Error("handler blew up");
    });
    const orgId = await createOrg("drain-retry-id");
    const seeded = await seedQueuedJob({ orgId, jobType });

    await expect(runJobWorker({ jobTypes: [jobType] })).rejects.toMatchObject({
      name: "ProcessingJobFailedError",
      jobId: seeded.id,
    });
  });

  it("terminalizes the agent run behind an exhausted statement_ocr job", async () => {
    const orgId = await createOrg("drain-terminal");
    const [run] = await db
      .insert(agentRuns)
      .values({ organizationId: orgId, kind: "statement_pipeline" })
      .returning();
    const maxAttempts = retryPolicyFor("statement_ocr").maxAttempts;
    const seeded = await seedQueuedJob({
      orgId,
      jobType: "statement_ocr",
      // Its final allowed attempt: the claim bumps attempts to maxAttempts.
      attempts: maxAttempts - 1,
      maxAttempts,
      payload: { reconciliationId: randomUUID(), documentId: randomUUID(), runId: run.id },
      // Oldest claimable row of this type, so the claim is deterministic.
      runAt: new Date(0),
    });

    const original = JOB_HANDLERS.statement_ocr;
    JOB_HANDLERS.statement_ocr = async () => {
      throw new Error("model provider is down");
    };
    try {
      await expect(runJobWorker({ jobTypes: ["statement_ocr"], maxJobs: 1 })).rejects.toMatchObject(
        { jobId: seeded.id },
      );
    } finally {
      JOB_HANDLERS.statement_ocr = original;
    }

    const job = await readJob(seeded.id);
    expect(job).toMatchObject({
      status: "failed",
      attempts: maxAttempts,
      lockedBy: null,
      lastError: "model provider is down",
    });

    // The regression: before the fix this run stayed `running` forever, so the
    // client poller had nothing terminal to observe and only ever timed out.
    const [terminalRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(terminalRun.status).toBe("failed");
    expect(terminalRun.finishedAt).not.toBeNull();
    expect(terminalRun.blockedReason).toMatchObject({
      kind: "job_exhausted",
      attempts: maxAttempts,
      maxAttempts,
      error: "model provider is down",
    });
  });

  it("lets exactly one of two concurrent workers process a single queued job", async () => {
    const handled: string[] = [];
    const jobType = registerFakeJobType(async (job, ctx) => {
      handled.push(ctx.workerId);
      await completeUnderLease(job, ctx);
      return { processed: true, jobId: job.id };
    });
    const orgId = await createOrg("drain-race");
    const seeded = await seedQueuedJob({ orgId, jobType });

    const [first, second] = await Promise.all([
      runJobWorker({ jobTypes: [jobType], maxJobs: 1 }),
      runJobWorker({ jobTypes: [jobType], maxJobs: 1 }),
    ]);

    // `FOR UPDATE SKIP LOCKED` plus the lease: one worker claims, the other
    // finds nothing rather than double-processing or blocking.
    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.processed)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.processed)).toEqual([
      { processed: false, reason: "queue_empty" },
    ]);
    expect(handled).toHaveLength(1);

    const job = await readJob(seeded.id);
    expect(job).toMatchObject({ status: "completed", attempts: 1, lockedBy: null });
  });

  it("reports no registered handlers rather than claiming an unhandled type", async () => {
    const result = await runJobWorker({ jobTypes: ["definitely_not_a_registered_job_type"] });
    expect(result).toEqual({ processed: false, reason: "no_registered_handlers" });
  });
});
