import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { mockEvent } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resendState = vi.hoisted(() => ({
  email: {
    data: {
      from: '"Acme" <receipts@acme.com>',
      to: ["books@test.local"],
      subject: "Order confirmation ACME-4242",
      message_id: "message-1",
      text: "Order # ACME-4242. Total: USD 84.25. Date: 2026-07-24. Thank you for your order.",
      html: "",
      attachments: [] as {
        id: string;
        filename: string;
        content_type: string;
      }[],
    },
    error: null as { message: string } | null,
  },
  extractedByFilename: {} as Record<
    string,
    {
      economicEventClass: string;
      direction: string;
      amount: string;
      currency: string;
      date: string;
      party: string;
      reference: string;
      description: string;
    }
  >,
  webhookPayload: null as Record<string, unknown> | null,
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      receiving: {
        get: vi.fn(async () =>
          resendState.email.error
            ? { data: null, error: resendState.email.error }
            : { data: resendState.email.data, error: null },
        ),
        attachments: {
          get: vi.fn(async ({ id }: { id: string }) => ({
            data: { download_url: `https://attachments.test/${id}` },
            error: null,
          })),
        },
      },
    };

    webhooks = {
      verify: vi.fn(() => resendState.webhookPayload),
    };
  },
}));

vi.mock("@/lib/storage", () => ({
  isR2Configured: () => true,
  uploadToR2: async (key: string) => ({
    r2Key: key,
    r2Bucket: "inbound-email-test",
  }),
  deleteFromR2: async () => undefined,
  downloadFromR2: async () => Buffer.from("test"),
}));

vi.mock("@/lib/inbox/email-attachment-extraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inbox/email-attachment-extraction")>();
  const { and, eq } = await import("drizzle-orm");
  const { documents } = await import("@/db/schema/documents");
  // The handler calls the tx-level ensureDocumentMatchingExtraction (it
  // already holds an org-context transaction); the root-db wrapper stays
  // mocked too for any caller that still goes through it.
  const fakeExtraction = vi.fn(
    async (
      database: typeof import("@/db").db,
      input: { organizationId: string; documentId: string; filename: string },
    ) => {
      const result = resendState.extractedByFilename[input.filename];
      if (!result) throw new Error(`No extraction result for ${input.filename}`);
      const [existing] = await database
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, input.organizationId),
            eq(documents.id, input.documentId),
          ),
        )
        .limit(1);
      const [updated] = await database
        .update(documents)
        .set({
          metadata: {
            ...existing.metadata,
            inboxExtraction: {
              version: 1,
              cachedAt: "2026-07-24T00:00:00.000Z",
              result,
            },
          },
        })
        .where(
          and(
            eq(documents.organizationId, input.organizationId),
            eq(documents.id, input.documentId),
          ),
        )
        .returning();
      return updated;
    },
  );
  return {
    ...actual,
    ensureEmailAttachmentExtraction: fakeExtraction,
    ensureDocumentMatchingExtraction: fakeExtraction,
  };
});

import { db } from "@/db";
import { member, organization, user } from "@/db/schema/auth";
import {
  inboxItems,
  ingestionEvents,
  integrationSources,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
  sourceMatchCandidates,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { runDuplicateMatchingForSource } from "@/lib/inbox/duplicate-engine";
import workerHandler from "../../server/routes/api/internal/inbox-worker.post";
import resendWebhookHandler from "../../server/routes/api/inbound-email/resend.post";

const integrationDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

interface Fixture {
  organizationId: string;
  userId: string;
  sourceId: string;
  ingestionEventId: string;
  parentSourceRecordId: string;
  candidateId: string;
  inboxItemId: string;
  jobId: string;
  emailId: string;
}

async function createFixture(label: string, maxAttempts = 8): Promise<Fixture> {
  const suffix = randomUUID();
  const organizationId = `${label}-org-${suffix}`;
  const userId = `${label}-user-${suffix}`;
  const emailId = `${label}-email-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Inbound Email Test",
    email: `${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Inbound Email Test",
    slug: `${label}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${label}-member-${suffix}`,
    organizationId,
    userId,
    role: "owner",
  });
  await db.insert(organizationAccountingSettings).values({
    organizationId,
    baseCurrency: "USD",
    inboundEmailAddress: `${label}-${suffix}@books.test`,
    requireDifferentApprover: false,
  });
  const [source] = await db
    .insert(integrationSources)
    .values({
      organizationId,
      provider: "resend",
      channel: "email",
      externalSourceId: `resend:${suffix}`,
      name: "Inbound email",
    })
    .returning();
  const [event] = await db
    .insert(ingestionEvents)
    .values({
      organizationId,
      sourceId: source.id,
      channel: "email",
      provider: "resend",
      providerEventId: `svix-${suffix}`,
      externalObjectId: emailId,
      externalVersion: "1",
      status: "received",
      occurredAt: new Date("2026-07-24T00:00:00.000Z"),
    })
    .returning();
  const [parent] = await db
    .insert(sourceRecords)
    .values({
      organizationId,
      sourceId: source.id,
      ingestionEventId: event.id,
      recordType: "email",
      externalId: emailId,
      providerStatus: "received",
      description: "Order confirmation ACME-4242",
      rawData: { from: "receipts@acme.com" },
    })
    .returning();
  const [candidate] = await db
    .insert(transactionCandidates)
    .values({
      organizationId,
      sourceRecordId: parent.id,
      candidateType: "email_transaction",
      transactionDate: "2026-07-24",
      transactionType: "journal",
      memo: "Order confirmation ACME-4242",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1",
    })
    .returning();
  await db.insert(transactionCandidateSources).values({
    organizationId,
    candidateId: candidate.id,
    sourceRecordId: parent.id,
    relationship: "origin",
    isPrimary: true,
  });
  const [item] = await db
    .insert(inboxItems)
    .values({
      organizationId,
      candidateId: candidate.id,
      sourceRecordId: parent.id,
      itemType: "classify_source_record",
      state: "processing",
      title: "Order confirmation ACME-4242",
    })
    .returning();
  await db.insert(reviewFindings).values({
    organizationId,
    inboxItemId: item.id,
    candidateId: candidate.id,
    ruleKey: "uncategorized",
    impact: "blocking",
    subjectType: "transaction_candidate",
    subjectId: candidate.id,
    fingerprint: `${candidate.id}:1:uncategorized`,
    message: "Needs categories",
  });
  const [job] = await db
    .insert(processingJobs)
    .values({
      organizationId,
      ingestionEventId: event.id,
      jobType: "process_inbound_email",
      dedupeKey: `resend-email:${emailId}`,
      payload: {
        emailId,
        sourceRecordId: parent.id,
        inboxItemId: item.id,
      },
      maxAttempts,
      runAt: new Date("2000-01-01T00:00:00.000Z"),
    })
    .returning();
  return {
    organizationId,
    userId,
    sourceId: source.id,
    ingestionEventId: event.id,
    parentSourceRecordId: parent.id,
    candidateId: candidate.id,
    inboxItemId: item.id,
    jobId: job.id,
    emailId,
  };
}

async function runWorker() {
  return workerHandler(
    mockEvent("http://localhost/api/internal/inbox-worker", {
      method: "POST",
      headers: { authorization: "Bearer worker-test-secret" },
    }),
  );
}

async function createReceiptSource(fixture: Fixture) {
  const [source] = await db
    .insert(sourceRecords)
    .values({
      organizationId: fixture.organizationId,
      recordType: "receipt_upload",
      externalId: `receipt-${randomUUID()}`,
      providerStatus: "processed",
      transactionDate: "2026-07-24",
      effectiveDate: "2026-07-24",
      description: "Order confirmation ACME-4242",
      amount: "84.25",
      originalAmount: "84.25",
      currency: "USD",
      originalCurrency: "USD",
      functionalAmount: "84.25",
      functionalCurrency: "USD",
      economicEventClass: "purchase",
      direction: "outflow",
      normalizedParty: "acme",
      normalizedReference: "acme4242",
      matcherInputHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    })
    .returning();
  const [candidate] = await db
    .insert(transactionCandidates)
    .values({
      organizationId: fixture.organizationId,
      sourceRecordId: source.id,
      transactionDate: "2026-07-24",
      transactionType: "pay_out",
      memo: "Order confirmation ACME-4242",
      referenceNumber: "ACME-4242",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      originalTotal: "84.25",
      functionalTotal: "84.25",
    })
    .returning();
  await db.insert(transactionCandidateSources).values({
    organizationId: fixture.organizationId,
    candidateId: candidate.id,
    sourceRecordId: source.id,
    relationship: "origin",
    isPrimary: true,
  });
  await db.insert(inboxItems).values({
    organizationId: fixture.organizationId,
    candidateId: candidate.id,
    sourceRecordId: source.id,
    state: "ready_for_review",
    title: "Receipt ACME-4242",
  });
  return source;
}

integrationDescribe("inbound email worker recovery and splitting", () => {
  const priorWorkerSecret = process.env.INBOX_WORKER_SECRET;
  const priorResendKey = process.env.RESEND_API_KEY;
  const priorWebhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.INBOX_WORKER_SECRET = "worker-test-secret";
    process.env.RESEND_API_KEY = "resend-test-key";
    process.env.RESEND_WEBHOOK_SECRET = "resend-webhook-test-secret";
    globalThis.fetch = vi.fn(async () => new Response(Buffer.from("attachment-bytes"))) as never;
  });

  afterAll(() => {
    process.env.INBOX_WORKER_SECRET = priorWorkerSecret;
    process.env.RESEND_API_KEY = priorResendKey;
    process.env.RESEND_WEBHOOK_SECRET = priorWebhookSecret;
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    resendState.email.error = null;
    resendState.email.data = {
      from: '"Acme" <receipts@acme.com>',
      to: ["books@test.local"],
      subject: "Order confirmation ACME-4242",
      message_id: randomUUID(),
      text: "Order # ACME-4242. Total: USD 84.25. Date: 2026-07-24. Thank you for your order.",
      html: "",
      attachments: [],
    };
    resendState.extractedByFilename = {};
    resendState.webhookPayload = null;
  });

  it.each(["receipt_first", "email_first"] as const)(
    "matches a body-only purchase email with a later receipt in %s order",
    async (order) => {
      const fixture = await createFixture(`body-${order}`);
      const receipt = order === "receipt_first" ? await createReceiptSource(fixture) : null;

      await expect(runWorker()).resolves.toMatchObject({
        processed: true,
        jobId: fixture.jobId,
      });

      const [bodySource] = await db
        .select()
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, fixture.organizationId),
            eq(sourceRecords.parentSourceRecordId, fixture.parentSourceRecordId),
            eq(sourceRecords.recordType, "email_body"),
          ),
        );
      expect(bodySource).toMatchObject({
        economicEventClass: "purchase",
        direction: "outflow",
        originalAmount: "84.25000000",
        originalCurrency: "USD",
        normalizedParty: "acme",
        normalizedReference: "acme4242",
      });

      const receiptSource = receipt ?? (await createReceiptSource(fixture));
      if (order === "email_first") {
        await runDuplicateMatchingForSource(
          { db, orgId: fixture.organizationId, userId: fixture.userId },
          receiptSource.id,
          "document_attached",
        );
      }
      const duplicateCases = await db
        .select()
        .from(sourceMatchCandidates)
        .where(eq(sourceMatchCandidates.organizationId, fixture.organizationId));
      expect(duplicateCases).toHaveLength(1);
      expect(duplicateCases[0]).toMatchObject({
        state: "open",
        disposition: "blocking",
      });
    },
  );

  it("splits multiple transaction-bearing attachments into independently resolvable Inbox items", async () => {
    const fixture = await createFixture("multi-event");
    resendState.email.data.attachments = [
      {
        id: "attachment-one",
        filename: "receipt-one.pdf",
        content_type: "application/pdf",
      },
      {
        id: "attachment-two",
        filename: "receipt-two.pdf",
        content_type: "application/pdf",
      },
    ];
    resendState.email.data.text = "Please review the attached receipts.";
    resendState.extractedByFilename = {
      "receipt-one.pdf": {
        economicEventClass: "purchase",
        direction: "outflow",
        amount: "10.00",
        currency: "USD",
        date: "2026-07-23",
        party: "Coffee Shop",
        reference: "COFFEE-10",
        description: "Coffee",
      },
      "receipt-two.pdf": {
        economicEventClass: "purchase",
        direction: "outflow",
        amount: "25.00",
        currency: "USD",
        date: "2026-07-24",
        party: "Office Store",
        reference: "OFFICE-25",
        description: "Office supplies",
      },
    };

    await expect(runWorker()).resolves.toMatchObject({ processed: true });

    const children = await db
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, fixture.organizationId),
          eq(sourceRecords.parentSourceRecordId, fixture.parentSourceRecordId),
        ),
      );
    expect(children.filter(({ recordType }) => recordType === "email_attachment")).toHaveLength(2);
    const candidateLinks = await db
      .select()
      .from(transactionCandidateSources)
      .where(
        and(
          eq(transactionCandidateSources.organizationId, fixture.organizationId),
          inArray(
            transactionCandidateSources.sourceRecordId,
            children.map(({ id }) => id),
          ),
          eq(transactionCandidateSources.isPrimary, true),
        ),
      );
    expect(new Set(candidateLinks.map(({ candidateId }) => candidateId)).size).toBe(2);
    const items = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.organizationId, fixture.organizationId));
    expect(items).toHaveLength(2);
    // Standing proof that this pipeline SPLITS rather than quarantines. The
    // `multiple_transaction_documents` rule key was removed from the codebase because nothing
    // ever inserted it — only guards existed — and this assertion is why: the multi-attachment
    // path produces separate Inbox items, so a combined-posting quarantine never applies.
    const permanentQuarantine = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.organizationId),
          eq(reviewFindings.ruleKey, "multiple_transaction_documents"),
        ),
      );
    expect(permanentQuarantine).toHaveLength(0);
  });

  it("quarantines incomplete attachment evidence in its own Inbox item", async () => {
    const fixture = await createFixture("incomplete-attachment");
    resendState.email.data.attachments = [
      {
        id: "complete",
        filename: "receipt-complete.pdf",
        content_type: "application/pdf",
      },
      {
        id: "incomplete",
        filename: "scan-unknown.pdf",
        content_type: "application/pdf",
      },
    ];
    resendState.email.data.text = "Documents attached.";
    resendState.extractedByFilename = {
      "receipt-complete.pdf": {
        economicEventClass: "purchase",
        direction: "outflow",
        amount: "12.50",
        currency: "USD",
        date: "2026-07-24",
        party: "Cafe",
        reference: "CAFE-1250",
        description: "Lunch",
      },
      "scan-unknown.pdf": {
        economicEventClass: "other",
        direction: "unknown",
        amount: "",
        currency: "",
        date: "",
        party: "",
        reference: "",
        description: "Unknown scan",
      },
    };

    await expect(runWorker()).resolves.toMatchObject({ processed: true });

    const findings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.organizationId),
          eq(reviewFindings.ruleKey, "source_evidence_incomplete"),
          eq(reviewFindings.state, "open"),
        ),
      );
    expect(findings).toHaveLength(1);
    const [incompleteSource] = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, findings[0].subjectId!));
    expect(incompleteSource).toMatchObject({
      recordType: "email_attachment",
      providerStatus: "needs_information",
      economicEventClass: "other",
      direction: "unknown",
    });
    const [quarantinedItem] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, findings[0].inboxItemId!));
    expect(quarantinedItem.state).toBe("needs_information");
  });

  it("records terminal worker failure and exact webhook replay safely requeues it", async () => {
    const fixture = await createFixture("terminal-replay", 1);
    resendState.email.error = { message: "provider temporarily unavailable" };

    await expect(runWorker()).rejects.toMatchObject({ statusCode: 500 });
    const [failedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, fixture.jobId));
    expect(failedJob).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "provider temporarily unavailable",
    });
    const [failedItem] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, fixture.inboxItemId));
    expect(failedItem.state).toBe("needs_information");
    const [failureFinding] = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.organizationId),
          eq(reviewFindings.ruleKey, "source_processing_failed"),
        ),
      );
    expect(failureFinding.evidence).toMatchObject({
      jobId: fixture.jobId,
      attempts: 1,
      maxAttempts: 1,
    });
    const [failureAudit] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, fixture.organizationId),
          eq(workflowEvents.action, "source_processing_failed"),
        ),
      );
    expect(failureAudit.entityId).toBe(fixture.jobId);

    const [settings] = await db
      .select()
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, fixture.organizationId));
    const [event] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.id, fixture.ingestionEventId));
    resendState.webhookPayload = {
      type: "email.received",
      created_at: "2026-07-24T00:00:00.000Z",
      data: {
        email_id: fixture.emailId,
        from: "receipts@acme.com",
        to: [settings.inboundEmailAddress],
        subject: "Order confirmation ACME-4242",
        message_id: "message-replay",
        attachments: [],
      },
    };
    const webhookResult = await resendWebhookHandler(
      mockEvent("http://localhost/api/inbound-email/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": event.providerEventId!,
          "svix-timestamp": "1753315200",
          "svix-signature": "test-signature",
        },
        body: JSON.stringify(resendState.webhookPayload),
      }),
    );
    expect(webhookResult).toMatchObject({
      received: true,
      duplicate: true,
      requeued: true,
      inboxItemId: fixture.inboxItemId,
    });
    const [requeued] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, fixture.jobId));
    expect(requeued).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
    });
    const [processingItem] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, fixture.inboxItemId));
    expect(processingItem.state).toBe("processing");
  });

  it("suppresses a failed-job replay after the original candidate lifecycle has closed", async () => {
    const fixture = await createFixture("terminal-closed-replay", 1);
    resendState.email.error = { message: "provider temporarily unavailable" };

    await expect(runWorker()).rejects.toMatchObject({ statusCode: 500 });
    await db
      .update(transactionCandidates)
      .set({ status: "posted", updatedAt: new Date() })
      .where(eq(transactionCandidates.id, fixture.candidateId));
    await db
      .update(inboxItems)
      .set({ state: "approved", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(inboxItems.id, fixture.inboxItemId));
    await db
      .update(reviewFindings)
      .set({ state: "resolved", resolvedAt: new Date() })
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.organizationId),
          eq(reviewFindings.ruleKey, "source_processing_failed"),
        ),
      );

    const [settings] = await db
      .select()
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, fixture.organizationId));
    const [event] = await db
      .select()
      .from(ingestionEvents)
      .where(eq(ingestionEvents.id, fixture.ingestionEventId));
    resendState.webhookPayload = {
      type: "email.received",
      created_at: "2026-07-24T00:00:00.000Z",
      data: {
        email_id: fixture.emailId,
        from: "receipts@acme.com",
        to: [settings.inboundEmailAddress],
        subject: "Order confirmation ACME-4242",
        message_id: "message-closed-replay",
        attachments: [],
      },
    };
    const webhookResult = await resendWebhookHandler(
      mockEvent("http://localhost/api/inbound-email/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": event.providerEventId!,
          "svix-timestamp": "1753315200",
          "svix-signature": "test-signature",
        },
        body: JSON.stringify(resendState.webhookPayload),
      }),
    );
    expect(webhookResult).toMatchObject({
      received: true,
      duplicate: true,
      requeued: false,
    });
    const [stillFailed] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, fixture.jobId));
    expect(stillFailed.status).toBe("failed");
    const [stillApproved] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, fixture.inboxItemId));
    expect(stillApproved.state).toBe("approved");
  });
});
