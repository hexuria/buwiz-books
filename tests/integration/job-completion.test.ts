import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { processingJobs } from "../../src/db/schema/inbox";
import { completeProcessingJob } from "../../src/lib/inbox/processing-job-lease";
import { enqueueMatchAssistJob } from "../../src/lib/jobs/handlers/match-assist";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Audit PR-17 — the fenced completion primitive and the prefill-aware
 * match-assist dedupe, against real rows.
 */
describeDb("job completion and dedupe", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `job-done-${randomUUID()}`;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "Job Completion Org",
      slug: `jd-${randomUUID().slice(0, 8)}`,
    });
  });
  afterAll(async () => {
    await sql.end();
  });

  async function addRunningJob(workerId: string) {
    const [job] = await db
      .insert(processingJobs)
      .values({
        organizationId: ORG,
        jobType: "match_assist",
        status: "running",
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60_000),
      })
      .returning({ id: processingJobs.id });
    return job.id as string;
  }

  it("the lease owner completes exactly once; a stale worker cannot", async () => {
    const jobId = await addRunningJob("worker-a");

    // The wrong worker's completion is a no-op — the row stays running.
    expect(await completeProcessingJob(db, jobId, "worker-b")).toBe(false);
    let [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    expect(row.status).toBe("running");
    expect(row.lockedBy).toBe("worker-a");

    // The owner completes; the lease clears.
    expect(await completeProcessingJob(db, jobId, "worker-a")).toBe(true);
    [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    expect(row.status).toBe("completed");
    expect(row.lockedBy).toBeNull();
    expect(row.completedAt).not.toBeNull();

    // Completing again reports the lease as lost, not a second delivery.
    expect(await completeProcessingJob(db, jobId, "worker-a")).toBe(false);
  });

  it("a prefill request no longer coalesces into a queued suggest-only job", async () => {
    const reconciliationId = randomUUID();
    const suggestId = await enqueueMatchAssistJob(db, {
      organizationId: ORG,
      reconciliationId,
    });
    expect(suggestId).not.toBeNull();

    // The old single dedupe key made this return the suggest job's id and
    // drop the prefill flag on the floor.
    const prefillId = await enqueueMatchAssistJob(db, {
      organizationId: ORG,
      reconciliationId,
      prefill: true,
    });
    expect(prefillId).not.toBeNull();
    expect(prefillId).not.toBe(suggestId);

    // Same-flavor enqueue still dedupes onto the queued job.
    const suggestAgain = await enqueueMatchAssistJob(db, {
      organizationId: ORG,
      reconciliationId,
    });
    expect(suggestAgain).toBe(suggestId);
  });
});
