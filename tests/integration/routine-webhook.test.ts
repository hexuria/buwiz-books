/**
 * The generic webhook routine end to end (Inbox v2 §3, build step 4).
 *
 * Every rejection — bad signature, stale timestamp, oversize body, missing
 * secret — must leave no row behind: verification happens before the first
 * insert. An accepted payload becomes an ingestion event and a
 * `routine_webhook` job whose handler lands a "Needs you" Inbox item. A
 * replayed event id is suppressed per routine and LOGGED, never dropped
 * silently; a disabled routine records the payload without processing it.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mockEvent } from "h3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/trigger", () => ({ triggerWorker: vi.fn() }));

import { db, withOrgContext, type DbExecutor } from "@/db";
import { organization, user } from "@/db/schema/auth";
import {
  inboxItems,
  ingestionEvents,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
  sourceRecords,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { loadJevPaperFacts } from "@/lib/inbox/jev-approval/proposal";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { processRoutineWebhookJob } from "@/lib/jobs/handlers/routine-webhook";
import { orgDateOf } from "@/lib/org-calendar";
import { triggerWorker } from "@/lib/jobs/trigger";
import {
  createRoutine,
  rotateRoutineWebhookSecret,
  setRoutineEnabled,
} from "@/lib/routines/service";
import { signRoutineWebhook } from "@/lib/routines/webhook-signature";
import webhookHandler from "../../server/routes/api/routines/[routineId]/webhook.post";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

interface Fixture {
  orgId: string;
  userId: string;
  routineId: string;
  secret: string;
}

async function createFixture(label: string): Promise<Fixture> {
  const suffix = randomUUID();
  const orgId = `${label}-org-${suffix}`;
  const userId = `${label}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Webhook Admin",
    email: `${suffix}@webhook.test`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Webhook Co", slug: `${label}-${suffix}` });
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "PHP",
    timezone: "Asia/Manila",
  });
  const asOrg = <T>(fn: (tx: DbExecutor) => Promise<T>) =>
    withOrgContext(orgId, userId, "admin", fn);
  await asOrg(async (tx) => {
    const snapshot = await loadCoaSnapshot(tx, orgId);
    await executeCoaPlan(
      tx,
      orgId,
      planCoaPreset(snapshot, COA_PRESETS.general_small_business, { onConflict: "renumber" }),
      null,
    );
  });
  const routine = await asOrg((tx) =>
    createRoutine(tx, {
      orgId,
      actorId: userId,
      routine: { triggerKind: "webhook", name: "Receipts webhook" },
    }),
  );
  const { secret } = await asOrg((tx) =>
    rotateRoutineWebhookSecret(tx, { orgId, actorId: userId, routineId: routine.id }),
  );
  return { orgId, userId, routineId: routine.id, secret };
}

interface Delivery {
  body?: string;
  timestamp?: string;
  signature?: string;
  eventId?: string | null;
  secret?: string;
  headers?: Record<string, string>;
}

function nowSeconds() {
  return String(Math.floor(Date.now() / 1000));
}

function deliver(fixture: Pick<Fixture, "routineId" | "secret">, delivery: Delivery = {}) {
  const body = delivery.body ?? JSON.stringify({ vendor: "Acme", total: "84.25" });
  const timestamp = delivery.timestamp ?? nowSeconds();
  const eventId = delivery.eventId === null ? null : (delivery.eventId ?? randomUUID());
  const signature =
    delivery.signature ??
    signRoutineWebhook(delivery.secret ?? fixture.secret, timestamp, eventId ?? "", body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-buwiz-timestamp": timestamp,
    "x-buwiz-signature": signature,
    ...delivery.headers,
  };
  if (eventId !== null) headers["x-buwiz-event-id"] = eventId;
  const event = mockEvent(`http://localhost/api/routines/${fixture.routineId}/webhook`, {
    method: "POST",
    headers,
    body,
  });
  event.context.params = { routineId: fixture.routineId };
  return webhookHandler(event) as Promise<Record<string, unknown>>;
}

async function eventsFor(orgId: string) {
  return db.select().from(ingestionEvents).where(eq(ingestionEvents.organizationId, orgId));
}

async function claimJob(jobId: string, workerId: string) {
  const [job] = await db
    .update(processingJobs)
    .set({ status: "running", lockedBy: workerId, lockedUntil: new Date(Date.now() + 60_000) })
    .where(eq(processingJobs.id, jobId))
    .returning();
  return job;
}

describeDb("routine webhook", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture("webhook");
  });

  beforeEach(() => {
    vi.mocked(triggerWorker).mockClear();
  });

  it("accepts a signed payload and lands it in the Inbox as Needs you", async () => {
    const eventId = `evt-${randomUUID()}`;
    const body = JSON.stringify({ vendor: "Acme", total: "84.25", reference: "ACME-1" });
    const result = await deliver(fixture, { eventId, body });
    expect(result).toMatchObject({ received: true, queued: true });
    expect(triggerWorker).toHaveBeenCalledWith(["routine_webhook"]);

    const [event] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.id, result.ingestionEventId as string));
    expect(event).toMatchObject({
      organizationId: fixture.orgId,
      routineId: fixture.routineId,
      channel: "webhook",
      provider: `routine:${fixture.routineId}`,
      providerEventId: eventId,
      status: "received",
      payload: { vendor: "Acme", total: "84.25", reference: "ACME-1" },
    });
    expect(event.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.ingestionEventId, event.id));
    expect(job).toMatchObject({
      organizationId: fixture.orgId,
      routineId: fixture.routineId,
      jobType: "routine_webhook",
      status: "queued",
    });

    const workerId = `test-worker-${randomUUID()}`;
    const claimed = await claimJob(job.id, workerId);
    const handled = await processRoutineWebhookJob(claimed, { workerId });
    expect(handled).toMatchObject({ processed: true, jobId: job.id, deduplicated: false });

    const [source] = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.ingestionEventId, event.id));
    expect(source).toMatchObject({
      organizationId: fixture.orgId,
      recordType: "webhook_payload",
      externalId: eventId,
      providerStatus: "needs_information",
    });
    const [item] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, handled.inboxItemId as string));
    expect(item).toMatchObject({
      organizationId: fixture.orgId,
      sourceRecordId: source.id,
      state: "needs_information",
      itemType: "classify_source_record",
    });
    const [candidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, item.candidateId!));
    // The organization's own currency and calendar, not USD/UTC defaults.
    expect(candidate).toMatchObject({
      candidateType: "webhook_transaction",
      originalCurrency: "PHP",
      functionalCurrency: "PHP",
      status: "current",
      transactionDate: orgDateOf(event.occurredAt!, "Asia/Manila"),
    });
    // The routine signs its requests (HMAC): not email, so Jev has no sender to verify.
    const facts = await withOrgContext(fixture.orgId, "system", "admin", (tx) =>
      loadJevPaperFacts(tx, fixture.orgId, candidate.id),
    );
    expect(facts?.sender).toBeNull();
    const findings = await db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.inboxItemId, item.id));
    expect(findings).toMatchObject([{ ruleKey: "uncategorized", impact: "blocking" }]);

    const [completedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, job.id));
    expect(completedJob.status).toBe("completed");
    const [processedEvent] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.id, event.id));
    expect(processedEvent.status).toBe("processed");

    // Re-running the same job converges instead of duplicating the paper.
    await db
      .update(processingJobs)
      .set({ status: "running", lockedBy: workerId, completedAt: null })
      .where(eq(processingJobs.id, job.id));
    const rerun = await processRoutineWebhookJob({ ...claimed, status: "running" }, { workerId });
    expect(rerun).toMatchObject({ processed: true, deduplicated: true, inboxItemId: item.id });
    const sources = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.ingestionEventId, event.id));
    expect(sources).toHaveLength(1);
  });

  it("suppresses a duplicate event id and logs it instead of dropping it", async () => {
    const eventId = `evt-${randomUUID()}`;
    const body = JSON.stringify({ vendor: "Acme", total: "10.00" });
    const first = await deliver(fixture, { eventId, body });
    expect(first).toMatchObject({ received: true, queued: true });

    // A sender retry: same event, re-signed with a fresh timestamp.
    const retryTimestamp = String(Number(nowSeconds()) + 1);
    const second = await deliver(fixture, { eventId, body, timestamp: retryTimestamp });
    expect(second).toMatchObject({
      received: true,
      duplicate: true,
      ingestionEventId: first.ingestionEventId,
    });

    const events = (await eventsFor(fixture.orgId)).filter(
      ({ providerEventId }) => providerEventId === eventId,
    );
    expect(events).toHaveLength(1);
    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.ingestionEventId, events[0].id));
    expect(jobs).toHaveLength(1);

    const [suppressed] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, fixture.orgId),
          eq(workflowEvents.entityId, events[0].id),
          eq(workflowEvents.action, "exact_replay_suppressed"),
        ),
      );
    expect(suppressed).toMatchObject({
      entityType: "ingestion_event",
      actorType: "system",
      data: { routineId: fixture.routineId, eventId, samePayload: true },
    });

    // The same id with a DIFFERENT body is flagged in the log.
    await deliver(fixture, {
      eventId,
      body: JSON.stringify({ vendor: "Acme", total: "99.00" }),
      timestamp: String(Number(nowSeconds()) + 2),
    });
    const logged = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.entityId, events[0].id),
          eq(workflowEvents.action, "exact_replay_suppressed"),
        ),
      );
    expect(logged.map(({ data }) => data.samePayload).sort()).toEqual([false, true]);
  });

  it("dedupes per routine: another routine may reuse the same event id", async () => {
    const other = await withOrgContext(fixture.orgId, fixture.userId, "admin", async (tx) => {
      const routine = await createRoutine(tx, {
        orgId: fixture.orgId,
        actorId: fixture.userId,
        routine: { triggerKind: "webhook", name: "Second sender" },
      });
      const { secret } = await rotateRoutineWebhookSecret(tx, {
        orgId: fixture.orgId,
        actorId: fixture.userId,
        routineId: routine.id,
      });
      return { routineId: routine.id, secret };
    });
    const eventId = "1";
    const fromFirst = await deliver(fixture, { eventId });
    const fromSecond = await deliver(other, { eventId });
    expect(fromFirst).toMatchObject({ received: true, queued: true });
    expect(fromSecond).toMatchObject({ received: true, queued: true });
    expect(fromSecond.ingestionEventId).not.toBe(fromFirst.ingestionEventId);
  });

  describe("rejections leave no row behind", () => {
    async function expectNothingRecorded(eventId: string) {
      const events = (await eventsFor(fixture.orgId)).filter(
        ({ providerEventId }) => providerEventId === eventId,
      );
      expect(events).toHaveLength(0);
      expect(triggerWorker).not.toHaveBeenCalled();
    }

    it("rejects an invalid signature", async () => {
      const eventId = `evt-${randomUUID()}`;
      await expect(deliver(fixture, { eventId, signature: "0".repeat(64) })).rejects.toMatchObject({
        statusCode: 401,
      });
      await expectNothingRecorded(eventId);
    });

    it("rejects a signature made with the wrong secret", async () => {
      const eventId = `evt-${randomUUID()}`;
      await expect(
        deliver(fixture, { eventId, secret: "bwz_whsec_not-the-routine-secret" }),
      ).rejects.toMatchObject({ statusCode: 401 });
      await expectNothingRecorded(eventId);
    });

    it("rejects an expired timestamp even when correctly signed", async () => {
      const eventId = `evt-${randomUUID()}`;
      const stale = String(Math.floor(Date.now() / 1000) - 301);
      await expect(deliver(fixture, { eventId, timestamp: stale })).rejects.toMatchObject({
        statusCode: 401,
      });
      await expectNothingRecorded(eventId);
    });

    it("rejects a body over 1 MB, declared or not", async () => {
      const oversize = JSON.stringify({ blob: "x".repeat(1024 * 1024) });
      const declaredId = `evt-${randomUUID()}`;
      await expect(
        deliver(fixture, {
          eventId: declaredId,
          body: oversize,
          headers: { "content-length": String(Buffer.byteLength(oversize)) },
        }),
      ).rejects.toMatchObject({ statusCode: 413 });
      await expectNothingRecorded(declaredId);

      const undeclaredId = `evt-${randomUUID()}`;
      await expect(
        deliver(fixture, { eventId: undeclaredId, body: oversize }),
      ).rejects.toMatchObject({ statusCode: 413 });
      await expectNothingRecorded(undeclaredId);
    });

    it("requires the event id header", async () => {
      await expect(deliver(fixture, { eventId: null })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("returns 404 for an unknown or malformed routine", async () => {
      await expect(
        deliver({ routineId: randomUUID(), secret: fixture.secret }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        deliver({ routineId: "not-a-uuid", secret: fixture.secret }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects every delivery to a routine that has no secret yet", async () => {
      const unsigned = await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
        createRoutine(tx, {
          orgId: fixture.orgId,
          actorId: fixture.userId,
          routine: { triggerKind: "webhook", name: "No secret yet" },
        }),
      );
      const eventId = `evt-${randomUUID()}`;
      await expect(
        deliver({ routineId: unsigned.id, secret: "anything" }, { eventId }),
      ).rejects.toMatchObject({ statusCode: 401 });
      await expectNothingRecorded(eventId);
    });

    it("stops accepting the old secret the moment it is rotated", async () => {
      const rotated = await createFixture("webhook-rotate");
      const oldSecret = rotated.secret;
      await withOrgContext(rotated.orgId, rotated.userId, "admin", (tx) =>
        rotateRoutineWebhookSecret(tx, {
          orgId: rotated.orgId,
          actorId: rotated.userId,
          routineId: rotated.routineId,
        }),
      );
      await expect(deliver({ ...rotated, secret: oldSecret })).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  it("refuses a delivery to a disabled routine with 503, stores nothing, and takes the retry once enabled", async () => {
    const paused = await createFixture("webhook-disabled");
    const setEnabled = (enabled: boolean) =>
      withOrgContext(paused.orgId, paused.userId, "admin", (tx) =>
        setRoutineEnabled(tx, {
          orgId: paused.orgId,
          actorId: paused.userId,
          routineId: paused.routineId,
          enabled,
        }),
      );
    await setEnabled(false);
    await expect(deliver(paused, { eventId: "evt-paused" })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(triggerWorker).not.toHaveBeenCalled();
    expect(await eventsFor(paused.orgId)).toHaveLength(0);
    expect(
      await db.select().from(processingJobs).where(eq(processingJobs.organizationId, paused.orgId)),
    ).toHaveLength(0);

    // The sender retries after the routine is turned back on: an ordinary first delivery.
    await setEnabled(true);
    const retried = await deliver(paused, { eventId: "evt-paused" });
    expect(retried).toMatchObject({ received: true, queued: true });
    const [event] = await eventsFor(paused.orgId);
    expect(event).toMatchObject({ routineId: paused.routineId, status: "received" });
    expect(
      await db.select().from(processingJobs).where(eq(processingJobs.organizationId, paused.orgId)),
    ).toHaveLength(1);
  });

  it("refuses a captured request replayed under a new event id, and writes nothing", async () => {
    const fixture = await createFixture("webhook-replay-new-id");
    const timestamp = nowSeconds();
    const body = JSON.stringify({ vendor: "Acme", total: "84.25" });
    const signature = signRoutineWebhook(fixture.secret, timestamp, "evt-original", body);
    await expect(
      deliver(fixture, { timestamp, body, signature, eventId: "evt-original" }),
    ).resolves.toMatchObject({ received: true, queued: true });
    await expect(
      deliver(fixture, { timestamp, body, signature, eventId: "evt-forged" }),
    ).rejects.toMatchObject({ statusCode: 401 });
    const events = await eventsFor(fixture.orgId);
    expect(events).toHaveLength(1);
    expect(events[0].providerEventId).toBe("evt-original");
  });
});
