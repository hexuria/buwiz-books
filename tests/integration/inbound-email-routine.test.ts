/**
 * Inbound email as the first webhook routine (Inbox v2 §3, build step 4).
 *
 * The first email for an organization provisions its email routine, and the
 * ingestion event and processing job both carry that routine. Disabling the
 * routine keeps the email — the ingestion event holds the full payload — but
 * processes nothing, not even a replay, and says so in workflow_events.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mockEvent } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resendState = vi.hoisted(() => ({
  webhookPayload: null as Record<string, unknown> | null,
}));

vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: vi.fn(() => resendState.webhookPayload) };
  },
}));
vi.mock("@/lib/jobs/trigger", () => ({ triggerWorker: vi.fn() }));

import { db, withOrgContext } from "@/db";
import { organization } from "@/db/schema/auth";
import {
  inboxItems,
  ingestionEvents,
  organizationAccountingSettings,
  processingJobs,
  sourceRecords,
  workflowEvents,
} from "@/db/schema/inbox";
import { routines } from "@/db/schema/routines";
import { ensureInboundEmailRoutine, setRoutineEnabled } from "@/lib/routines/service";
import resendWebhookHandler from "../../server/routes/api/inbound-email/resend.post";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function createOrg(label: string) {
  const suffix = randomUUID();
  const organizationId = `${label}-org-${suffix}`;
  const address = `${label}-${suffix}@books.test`;
  await db.insert(organization).values({
    id: organizationId,
    name: "Email Routine Co",
    slug: `${label}-${suffix}`,
  });
  await db.insert(organizationAccountingSettings).values({
    organizationId,
    baseCurrency: "USD",
    inboundEmailAddress: address,
  });
  return { organizationId, address };
}

function postEmail(input: { address: string; emailId: string; svixId: string }) {
  resendState.webhookPayload = {
    type: "email.received",
    created_at: "2026-09-20T03:00:00.000Z",
    data: {
      email_id: input.emailId,
      created_at: "2026-09-20T03:00:00.000Z",
      from: "receipts@acme.test",
      to: [input.address],
      subject: "Receipt ACME-77",
      message_id: `message-${input.emailId}`,
      attachments: [],
    },
  };
  return resendWebhookHandler(
    mockEvent("http://localhost/api/inbound-email/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": input.svixId,
        "svix-timestamp": "1790000000",
        "svix-signature": "test-signature",
      },
      body: JSON.stringify(resendState.webhookPayload),
    }),
  ) as Promise<Record<string, unknown>>;
}

describeDb("inbound email routine", () => {
  const priorWebhookSecret = process.env.RESEND_WEBHOOK_SECRET;

  beforeAll(() => {
    process.env.RESEND_WEBHOOK_SECRET = "resend-webhook-test-secret";
  });

  afterAll(() => {
    process.env.RESEND_WEBHOOK_SECRET = priorWebhookSecret;
  });

  beforeEach(() => {
    resendState.webhookPayload = null;
  });

  it("provisions the email routine on first email and tags the event and job with it", async () => {
    const org = await createOrg("email-routine");
    const emailId = `email-${randomUUID()}`;
    const result = await postEmail({ address: org.address, emailId, svixId: `svix-${emailId}` });
    expect(result).toMatchObject({ received: true });
    expect(result.inboxItemId).toBeTruthy();

    const orgRoutines = await db
      .select()
      .from(routines)
      .where(eq(routines.organizationId, org.organizationId));
    expect(orgRoutines).toHaveLength(1);
    const [routine] = orgRoutines;
    expect(routine).toMatchObject({
      triggerKind: "webhook",
      enabled: true,
      triggerConfig: { provider: "resend", auth: "svix" },
    });

    const [event] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.organizationId, org.organizationId));
    expect(event).toMatchObject({ routineId: routine.id, provider: "resend", status: "received" });
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.ingestionEventId, event.id));
    expect(job).toMatchObject({ routineId: routine.id, jobType: "process_inbound_email" });

    // The second email reuses the routine rather than provisioning another.
    const secondId = `email-${randomUUID()}`;
    await postEmail({ address: org.address, emailId: secondId, svixId: `svix-${secondId}` });
    const after = await db
      .select()
      .from(routines)
      .where(eq(routines.organizationId, org.organizationId));
    expect(after).toHaveLength(1);
  });

  it("records but does not process email while the routine is disabled", async () => {
    const org = await createOrg("email-disabled");
    await withOrgContext(org.organizationId, "system", "admin", async (tx) => {
      const routine = await ensureInboundEmailRoutine(tx, org.organizationId);
      // Disabling never needs a chart of accounts; this org has none.
      await setRoutineEnabled(tx, {
        orgId: org.organizationId,
        actorId: "system",
        routineId: routine.id,
        enabled: false,
      });
    });
    const emailId = `email-${randomUUID()}`;
    const svixId = `svix-${emailId}`;
    const result = await postEmail({ address: org.address, emailId, svixId });
    expect(result).toMatchObject({
      received: true,
      processed: false,
      reason: "routine_disabled",
    });

    const [event] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.organizationId, org.organizationId));
    expect(event).toMatchObject({
      status: "skipped",
      providerEventId: svixId,
      externalObjectId: emailId,
    });
    expect(event.routineId).toBeTruthy();
    expect(event.processedAt).toBeInstanceOf(Date);
    // Recorded: the full provider payload is kept for a later replay.
    expect(event.payload).toMatchObject({ data: { email_id: emailId } });

    // Not processed: no source, no Inbox item, no job.
    const sources = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.organizationId, org.organizationId));
    const items = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.organizationId, org.organizationId));
    const queued = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.organizationId, org.organizationId));
    expect([sources.length, items.length, queued.length]).toEqual([0, 0, 0]);

    const [skipped] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, org.organizationId),
          eq(workflowEvents.action, "routine_disabled_skipped"),
        ),
      );
    expect(skipped).toMatchObject({
      entityType: "ingestion_event",
      entityId: event.id,
      actorType: "system",
      data: { routineId: event.routineId, provider: "resend", emailId },
    });

    // A provider replay of the same event is still suppressed and still not processed.
    const replay = await postEmail({ address: org.address, emailId, svixId });
    expect(replay).toMatchObject({ received: true, duplicate: true, requeued: false });
    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.organizationId, org.organizationId));
    expect(jobs).toHaveLength(0);
  });
});
