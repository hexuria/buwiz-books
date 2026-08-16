import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organization } from "@/db/schema/auth";
import {
  inboxItems,
  ingestionEvents,
  processingJobs,
  reviewFindings,
  sourceRecords,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { expireExhaustedProcessingJobs } from "@/lib/inbox/processing-job-lease";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("processing job final-attempt crash recovery", () => {
  let db: any;
  let sqlClient: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  it("terminally fails an expired final-attempt lease and fences the crashed worker", async () => {
    const suffix = randomUUID();
    const orgId = `processing-job-crash-${suffix}`;
    const crashedWorkerId = `worker-crashed-${suffix}`;
    const now = new Date("2026-07-24T12:00:00.000Z");
    await db.insert(organization).values({
      id: orgId,
      name: "Processing job crash recovery",
      slug: `processing-job-crash-${suffix}`,
    });
    const [job] = await db
      .insert(processingJobs)
      .values({
        organizationId: orgId,
        jobType: "process_standalone_document",
        status: "running",
        attempts: 3,
        maxAttempts: 3,
        lockedBy: crashedWorkerId,
        lockedUntil: new Date("2026-07-24T11:59:59.000Z"),
        lastError: null,
      })
      .returning();

    const expired = await db.transaction((tx: any) => expireExhaustedProcessingJobs(tx, now));
    expect(expired.map(({ id }: { id: string }) => id)).toContain(job.id);

    const [failed] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 3,
      maxAttempts: 3,
      lockedBy: null,
      lockedUntil: null,
      lastError: "Final processing attempt expired before completion.",
    });

    const staleCompletion = await db
      .update(processingJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(processingJobs.id, job.id),
          eq(processingJobs.status, "running"),
          eq(processingJobs.lockedBy, crashedWorkerId),
        ),
      )
      .returning({ id: processingJobs.id });
    expect(staleCompletion).toEqual([]);

    const [stillFailed] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, job.id));
    expect(stillFailed.status).toBe("failed");
  });

  it("terminalizes the complete inbound-email workflow when its final lease expires", async () => {
    const suffix = randomUUID();
    const orgId = `processing-email-crash-${suffix}`;
    const now = new Date("2026-07-24T12:00:00.000Z");
    await db.insert(organization).values({
      id: orgId,
      name: "Processing email crash recovery",
      slug: `processing-email-crash-${suffix}`,
    });
    const [ingestionEvent] = await db
      .insert(ingestionEvents)
      .values({
        organizationId: orgId,
        channel: "email",
        provider: "resend",
        providerEventId: `event-${suffix}`,
        status: "processing",
      })
      .returning();
    const [source] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        ingestionEventId: ingestionEvent.id,
        recordType: "email",
        externalId: `email-${suffix}`,
        providerStatus: "processing",
      })
      .returning();
    const [candidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: orgId,
        sourceRecordId: source.id,
        candidateType: "email_transaction",
        transactionDate: "2026-07-24",
        transactionType: "journal",
        originalCurrency: "USD",
        functionalCurrency: "USD",
      })
      .returning();
    const [item] = await db
      .insert(inboxItems)
      .values({
        organizationId: orgId,
        candidateId: candidate.id,
        sourceRecordId: source.id,
        state: "processing",
        title: "Crashed inbound email",
      })
      .returning();
    const [job] = await db
      .insert(processingJobs)
      .values({
        organizationId: orgId,
        ingestionEventId: ingestionEvent.id,
        jobType: "process_inbound_email",
        status: "running",
        payload: {
          emailId: source.externalId,
          sourceRecordId: source.id,
          inboxItemId: item.id,
        },
        attempts: 3,
        maxAttempts: 3,
        lockedBy: `worker-crashed-${suffix}`,
        lockedUntil: new Date("2026-07-24T11:59:59.000Z"),
      })
      .returning();

    await db.transaction((tx: any) => expireExhaustedProcessingJobs(tx, now));

    const [failedItem] = await db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(failedItem).toMatchObject({
      state: "needs_information",
      lockVersion: item.lockVersion + 1,
    });
    const [failedSource] = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, source.id));
    expect(failedSource.providerStatus).toBe("processing_failed");
    const [failedEvent] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.id, ingestionEvent.id));
    expect(failedEvent).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "Final processing attempt expired before completion.",
    });
    const [finding] = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, orgId),
          eq(reviewFindings.ruleKey, "source_processing_failed"),
        ),
      );
    expect(finding).toMatchObject({
      state: "open",
      subjectId: job.id,
      candidateId: candidate.id,
    });
    const [audit] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, orgId),
          eq(workflowEvents.action, "source_processing_failed"),
        ),
      );
    expect(audit).toMatchObject({
      entityId: job.id,
      inboxItemId: item.id,
    });
  });
});
