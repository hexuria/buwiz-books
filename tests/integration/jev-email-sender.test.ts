/**
 * Jev never approves an email it cannot trace to the vendor (Inbox v2 §8,
 * build step 11). The Resend/Svix signature proves Resend sent the webhook, not
 * who sent the email: an email spoofing a known vendor's address, with the
 * vendor's own bank details and under the lane's cap, must stay with a person.
 *
 * Every test runs the real pipeline end to end: the Resend webhook records the
 * email, the email job reads the message's raw header section and records the
 * sender verdict, stage 2's job answers the paper from a remembered correction
 * (no model), and the vendor's lane is at auto. Only the provider (Resend, the
 * document store) and the attachment's extraction are stubbed.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mockEvent } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Nothing may reach a model: the memory answers every paper here.
  vi.stubEnv("AI_MODE", "mock");
});

/** What extraction reads off an attachment. */
interface StubbedExtraction {
  economicEventClass: string;
  direction: string;
  amount: string;
  currency: string;
  date: string;
  party: string;
  reference: string;
  description: string;
}

interface StubbedEmail {
  data: Record<string, unknown>;
  /** The raw message's header section; null when Resend offers no raw download. */
  rawHeaders: string | null;
}

const provider = vi.hoisted(() => ({
  webhookPayload: null as Record<string, unknown> | null,
  emails: new Map<string, StubbedEmail>(),
  extractionByFilename: new Map<string, StubbedExtraction>(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      receiving: {
        get: vi.fn(async (id: string) => {
          const email = provider.emails.get(id);
          return email
            ? { data: email.data, error: null }
            : { data: null, error: { message: `No stubbed email ${id}` } };
        }),
        attachments: {
          get: vi.fn(async ({ id }: { id: string }) => ({
            data: { download_url: `https://attachments.test/${id}` },
            error: null,
          })),
        },
      },
    };

    webhooks = {
      verify: vi.fn(() => provider.webhookPayload),
    };
  },
}));

vi.mock("@/lib/storage", () => ({
  isR2Configured: () => true,
  uploadToR2: async (key: string) => ({ r2Key: key, r2Bucket: "jev-email-sender-test" }),
  deleteFromR2: async () => undefined,
  downloadFromR2: async () => Buffer.from("test"),
}));

vi.mock("@/lib/inbox/email-attachment-extraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inbox/email-attachment-extraction")>();
  const { and: whereAll, eq: equals } = await import("drizzle-orm");
  const { documents: documentTable } = await import("@/db/schema/documents");
  // What extraction reads off the invoice, cached on the document as the real
  // extractor caches it.
  const cachedExtraction = vi.fn(
    async (
      database: typeof import("@/db").db,
      input: { organizationId: string; documentId: string; filename: string },
    ) => {
      const result = provider.extractionByFilename.get(input.filename);
      if (!result) throw new Error(`No stubbed extraction for ${input.filename}`);
      const where = whereAll(
        equals(documentTable.organizationId, input.organizationId),
        equals(documentTable.id, input.documentId),
      );
      const [existing] = await database.select().from(documentTable).where(where).limit(1);
      const [updated] = await database
        .update(documentTable)
        .set({
          metadata: {
            ...existing.metadata,
            inboxExtraction: { version: 1, cachedAt: "2026-08-26T00:00:00.000Z", result },
          },
        })
        .where(where)
        .returning();
      return updated;
    },
  );
  return {
    ...actual,
    ensureEmailAttachmentExtraction: cachedExtraction,
    ensureDocumentMatchingExtraction: cachedExtraction,
  };
});

import { db } from "@/db";
import {
  inboxItems,
  organizationAccountingSettings,
  processingJobs,
  sourceRecords,
  transactionCandidates,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import {
  CLASSIFY_INBOX_CANDIDATE_JOB_TYPE,
  candidateClassificationDedupeKey,
} from "@/lib/inbox/candidate-classification-job";
import { JEV_AUTO_APPROVE_JOB_TYPE } from "@/lib/inbox/jev-approval/auto-approve";
import { latestJevProposal } from "@/lib/inbox/jev-approval/proposal";
import { approveInboxItem } from "@/lib/inbox/service";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import type { JobHandlerResult, ProcessingJob } from "@/lib/jobs/registry";
import { processClassifyInboxCandidateJob } from "@/lib/jobs/handlers/classify-inbox-candidate";
import { processInboundEmailJob } from "@/lib/jobs/handlers/inbound-email";
import { processJevAutoApproveJob } from "@/lib/jobs/handlers/jev-auto-approve";
import resendWebhookHandler from "../../server/routes/api/inbound-email/resend.post";
import {
  asOrg,
  JEV_VENDOR_EMAIL,
  rememberVendorReceipts,
  setJevApprovalSettings,
  setLaneAuto,
  setupJevOrganization,
  type JevFixture,
} from "../utils/jev-fixture";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SENDER_UNVERIFIED_TEXT = "Sender could not be verified — Jev won't approve this on its own.";

type Organization = JevFixture & { inboundAddress: string; laneId: string };

/**
 * An organization that receives email, whose vendor's receipts are remembered
 * (build step 10), with the vendor's expense lane at auto and Jev approval on.
 */
async function emailOrganization(prefix: string): Promise<Organization> {
  const fixture = await setupJevOrganization(prefix);
  const inboundAddress = `books-${fixture.suffix}@in.buwiz.test`;
  await db
    .update(organizationAccountingSettings)
    .set({ inboundEmailAddress: inboundAddress })
    .where(eq(organizationAccountingSettings.organizationId, fixture.orgId));
  await setJevApprovalSettings(fixture.orgId, {
    inboxAutoapproveEnabled: true,
    inboxSpotCheckRate: "0",
  });
  const { first } = await rememberVendorReceipts(fixture);
  const firstProposal = await asOrg(fixture, (tx) =>
    latestJevProposal(tx, fixture.orgId, first.candidate.id),
  );
  const laneId = firstProposal!.laneId;
  await setLaneAuto(laneId, { amountCap: "500", confidenceThreshold: "0.95" });
  return { ...fixture, inboundAddress, laneId };
}

/** The raw header section, the receiving server's trace fields on top. */
function rawHeaders(input: { from: string; to: string; results: string[] }): string {
  return [
    "Return-Path: <bounce@mail.sender.example>",
    "Received: from mail.sender.example (mail.sender.example [203.0.113.7])",
    " by inbound-smtp.us-east-1.amazonaws.com with SMTP id jev-sender-test;",
    " Wed, 26 Aug 2026 10:00:00 +0000 (UTC)",
    "X-SES-Spam-Verdict: PASS",
    ...input.results.map((value) => `Authentication-Results: ${value}`),
    `From: ${input.from}`,
    `To: ${input.to}`,
    "Subject: Receipt from Paper Street Supply",
    `Message-ID: <${randomUUID()}@mail.sender.example>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="jev-boundary"',
  ].join("\r\n");
}

/** Claim one queued job and run its handler, the way the worker does. */
async function runQueued(
  orgId: string,
  jobType: string,
  dedupeKey: string,
  handler: (job: ProcessingJob, ctx: { workerId: string }) => Promise<JobHandlerResult>,
) {
  const workerId = `test-worker-${randomUUID()}`;
  const [job] = await db
    .update(processingJobs)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedUntil: new Date(Date.now() + 60_000),
      attempts: 1,
    })
    .where(
      and(
        eq(processingJobs.organizationId, orgId),
        eq(processingJobs.jobType, jobType),
        eq(processingJobs.status, "queued"),
        eq(processingJobs.dedupeKey, dedupeKey),
      ),
    )
    .returning();
  if (!job) throw new Error(`No queued ${jobType} job ${dedupeKey}.`);
  return handler(job, { workerId });
}

async function queuedJevJobs(orgId: string) {
  return db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.organizationId, orgId),
        eq(processingJobs.jobType, JEV_AUTO_APPROVE_JOB_TYPE),
        eq(processingJobs.status, "queued"),
      ),
    );
}

/**
 * One receipt from the vendor arrives by email: the webhook records it, the
 * email job processes it, and stage 2's job answers it. Returns the paper and
 * the proposal Jev recorded for it.
 */
async function deliverReceipt(
  org: Organization,
  input: {
    from: string;
    /** The receiving server's Authentication-Results, topmost first; null: no raw message. */
    results: string[] | null;
    amount: string;
    date: string;
  },
) {
  const emailId = `jev-sender-${randomUUID()}`;
  const attachmentId = `attachment-${randomUUID()}`;
  const filename = `receipt-${attachmentId}.pdf`;
  provider.extractionByFilename.set(filename, {
    economicEventClass: "purchase",
    direction: "outflow",
    amount: input.amount,
    currency: "USD",
    date: input.date,
    party: "Paper Street Supply",
    reference: `R-${randomUUID().slice(0, 8)}`,
    description: "Printer paper",
  });
  const attachment = { id: attachmentId, filename, content_type: "application/pdf" };
  provider.emails.set(emailId, {
    rawHeaders:
      input.results === null
        ? null
        : rawHeaders({ from: input.from, to: org.inboundAddress, results: input.results }),
    data: {
      object: "email",
      id: emailId,
      from: input.from,
      to: [org.inboundAddress],
      created_at: `${input.date}T10:00:00.000Z`,
      subject: "Receipt from Paper Street Supply",
      message_id: `<${emailId}@mail.sender.example>`,
      text: "",
      html: "",
      // Resend's parsed map: one value per name, whatever the message held.
      headers: { "authentication-results": "amazonses.com; dmarc=pass" },
      raw:
        input.results === null
          ? null
          : { download_url: `https://raw.test/${emailId}`, expires_at: "2026-08-27T00:00:00Z" },
      attachments: [
        { ...attachment, size: 2048, content_id: null, content_disposition: "attachment" },
      ],
    },
  });
  provider.webhookPayload = {
    type: "email.received",
    created_at: `${input.date}T10:00:00.000Z`,
    data: {
      email_id: emailId,
      created_at: `${input.date}T10:00:00.000Z`,
      from: input.from,
      to: [org.inboundAddress],
      bcc: [],
      cc: [],
      received_for: [org.inboundAddress],
      message_id: `<${emailId}@mail.sender.example>`,
      subject: "Receipt from Paper Street Supply",
      attachments: [attachment],
    },
  };
  const received = await resendWebhookHandler(
    mockEvent("http://localhost/api/inbound-email/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": `svix-${emailId}`,
        "svix-timestamp": "1787738400",
        "svix-signature": "test-signature",
      },
      body: JSON.stringify(provider.webhookPayload),
    }),
  );
  const inboxItemId = (received as { inboxItemId?: string }).inboxItemId;
  if (!inboxItemId) throw new Error("The webhook did not record the email.");

  await expect(
    runQueued(org.orgId, "process_inbound_email", `resend-email:${emailId}`, (job, ctx) =>
      processInboundEmailJob(job, ctx),
    ),
  ).resolves.toMatchObject({ processed: true });
  const [message] = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.organizationId, org.orgId),
        eq(sourceRecords.recordType, "email"),
        eq(sourceRecords.externalId, emailId),
      ),
    );
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, item.candidateId!));

  // Stage 2's real job: the memory answers the vendor's receipt.
  await expect(
    runQueued(
      org.orgId,
      CLASSIFY_INBOX_CANDIDATE_JOB_TYPE,
      candidateClassificationDedupeKey(candidate.id, candidate.revision),
      processClassifyInboxCandidateJob,
    ),
  ).resolves.toMatchObject({
    processed: true,
    memory: { outcome: "hit", matchKind: "party" },
  });
  const proposal = await asOrg(org, (tx) => latestJevProposal(tx, org.orgId, candidate.id));
  return { inboxItemId, candidateId: candidate.id, message, proposal };
}

async function runJevApproval(org: Organization, candidateId: string, revision: number) {
  return runQueued(
    org.orgId,
    JEV_AUTO_APPROVE_JOB_TYPE,
    `jev-auto-approve:${candidateId}:${revision}`,
    processJevAutoApproveJob,
  );
}

async function postedJournal(candidateId: string) {
  const [candidate] = await db
    .select({ postedJournalHeaderId: transactionCandidates.postedJournalHeaderId })
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, candidateId));
  return candidate.postedJournalHeaderId;
}

/** What the Inbox strip says about a paper still waiting. */
async function listed(org: Organization, inboxItemId: string) {
  const list = await asOrg(org, (tx) => listInboxV2Items(tx, org.orgId));
  return list.items.find((row) => row.id === inboxItemId);
}

const VENDOR_FROM = `"Paper Street Supply" <${JEV_VENDOR_EMAIL}>`;

describeDb("Jev and the sender of an emailed paper", () => {
  const prior = {
    apiKey: process.env.RESEND_API_KEY,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  };
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.RESEND_API_KEY = "resend-test-key";
    process.env.RESEND_WEBHOOK_SECRET = "resend-webhook-test-secret";
    globalThis.fetch = vi.fn(async (request: string | URL | Request) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      if (url.startsWith("https://raw.test/")) {
        const email = provider.emails.get(url.slice("https://raw.test/".length));
        if (!email?.rawHeaders) return new Response("gone", { status: 404 });
        return new Response(`${email.rawHeaders}\r\n\r\n--jev-boundary\r\nThe receipt.\r\n`);
      }
      // Each attachment's own bytes, so no two papers share a file.
      if (url.startsWith("https://attachments.test/")) return new Response(Buffer.from(url));
      return new Response("{}");
    }) as never;
  });

  afterAll(() => {
    process.env.RESEND_API_KEY = prior.apiKey;
    process.env.RESEND_WEBHOOK_SECRET = prior.webhookSecret;
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    provider.webhookPayload = null;
  });

  it("posts an authenticated receipt from the vendor's own address by itself", async () => {
    const org = await emailOrganization("jev-sender-pass");
    const paper = await deliverReceipt(org, {
      from: VENDOR_FROM,
      results: [
        "amazonses.com; spf=pass smtp.mailfrom=bounce@paperstreet.example; dkim=pass header.d=paperstreet.example; dmarc=pass header.from=paperstreet.example",
      ],
      amount: "52.40",
      date: "2026-08-26",
    });
    // The verdict was recorded on the email at ingest.
    expect(paper.message.rawData).toMatchObject({
      senderAuthentication: {
        version: 1,
        passed: true,
        reason: "passed",
        method: "dmarc",
        fromAddress: JEV_VENDOR_EMAIL,
        fromDomain: "paperstreet.example",
        authservId: "amazonses.com",
      },
    });
    expect(paper.proposal).toMatchObject({
      laneId: org.laneId,
      source: "memory",
      evaluation: { approve: true, holds: [] },
    });

    const result = await runJevApproval(org, paper.candidateId, paper.proposal!.candidateRevision);
    expect(result).toMatchObject({ processed: true, status: "approved", laneId: org.laneId });
    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.journalHeaderId as string));
    expect(journal).toMatchObject({
      status: "posted",
      createdBy: JEV_AUDIT_ACTOR_ID,
      totalAmount: "52.40000000",
      partyId: org.vendor.id,
    });
  });

  it("holds a spoofed receipt from the vendor's own address, even with a forged pass under the real verdict", async () => {
    const org = await emailOrganization("jev-sender-spoof");
    const paper = await deliverReceipt(org, {
      from: VENDOR_FROM,
      results: [
        // The receiving server's verdict, on top.
        "amazonses.com; spf=fail smtp.mailfrom=thief@lookalike.example; dkim=none; dmarc=fail header.from=paperstreet.example",
        // What the sender wrote into its own message.
        "amazonses.com; spf=pass smtp.mailfrom=paperstreet.example; dkim=pass header.d=paperstreet.example; dmarc=pass header.from=paperstreet.example",
      ],
      amount: "52.40",
      date: "2026-08-26",
    });
    expect(paper.message.rawData).toMatchObject({
      senderAuthentication: {
        passed: false,
        reason: "failed",
        method: null,
        results: { dmarc: "fail", dkim: "none", spf: "fail" },
      },
    });
    // Everything else passes: the vendor's remembered answer, under the cap.
    expect(paper.proposal!.evaluation).toMatchObject({
      approve: false,
      wouldApprove: false,
      holds: [
        {
          reason: "sender_unverified",
          scope: "paper",
          detail: "nothing passed for paperstreet.example (DMARC fail, DKIM none, SPF fail)",
        },
      ],
    });
    expect(await queuedJevJobs(org.orgId)).toEqual([]);
    expect(await postedJournal(paper.candidateId)).toBeNull();
    const row = await listed(org, paper.inboxItemId);
    expect(row).toMatchObject({ reason: "ready", reasonDetail: "sender_unverified" });
    expect(row!.reasonText).toContain(SENDER_UNVERIFIED_TEXT);
  });

  it.each([
    [
      "it carries no Authentication-Results header",
      [],
      "no_results",
      "it carries no authentication results",
    ],
    [
      "Resend offers no raw message to read",
      null,
      "no_headers",
      "its original headers were not available",
    ],
  ] as const)(
    "holds a receipt from the vendor's own address when %s",
    async (_label, results, reason, detail) => {
      const org = await emailOrganization("jev-sender-missing");
      const paper = await deliverReceipt(org, {
        from: VENDOR_FROM,
        results: results === null ? null : [...results],
        amount: "52.40",
        date: "2026-08-26",
      });
      expect(paper.message.rawData).toMatchObject({
        senderAuthentication: { passed: false, reason },
      });
      expect(paper.proposal!.evaluation.holds).toEqual([
        { reason: "sender_unverified", scope: "paper", detail },
      ]);
      expect(await queuedJevJobs(org.orgId)).toEqual([]);
      expect(await postedJournal(paper.candidateId)).toBeNull();
      expect(await listed(org, paper.inboxItemId)).toMatchObject({
        reasonDetail: "sender_unverified",
      });
    },
  );

  it("holds an authenticated receipt from a domain the vendor has not used, until a person approves one", async () => {
    const org = await emailOrganization("jev-sender-new-domain");
    const from = '"Paper Street Supply" <billing@paperstreet-mail.example>';
    const results = [
      "amazonses.com; spf=pass smtp.mailfrom=bounce@paperstreet-mail.example; dkim=pass header.d=paperstreet-mail.example; dmarc=pass header.from=paperstreet-mail.example",
    ];
    const first = await deliverReceipt(org, {
      from,
      results,
      amount: "61.30",
      date: "2026-08-26",
    });
    expect(first.message.rawData).toMatchObject({
      senderAuthentication: { passed: true, fromDomain: "paperstreet-mail.example" },
    });
    expect(first.proposal!.evaluation.holds).toEqual([
      {
        reason: "sender_unverified",
        scope: "paper",
        detail: "paperstreet-mail.example is not a domain this party has used",
      },
    ]);
    expect(await queuedJevJobs(org.orgId)).toEqual([]);

    // A person looks, and approves it: the vendor now uses that domain.
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, first.inboxItemId));
    const approved = await asOrg(
      org,
      (tx) =>
        approveInboxItem(
          { db: tx, orgId: org.orgId, userId: org.reviewerId, role: "admin" },
          {
            inboxItemId: item.id,
            expectedRevision: item.candidateRevision,
            expectedLockVersion: item.lockVersion,
          },
        ),
      org.reviewerId,
    );
    expect(approved.approvalOutcome).toBe("approved");

    const second = await deliverReceipt(org, {
      from,
      results,
      amount: "73.80",
      date: "2026-08-27",
    });
    expect(second.proposal!.evaluation).toMatchObject({ approve: true, holds: [] });
    await expect(
      runJevApproval(org, second.candidateId, second.proposal!.candidateRevision),
    ).resolves.toMatchObject({ processed: true, status: "approved" });
  });
});
