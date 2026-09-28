/**
 * Jev approving papers through its lane (Inbox v2 spec §8, build step 11).
 *
 * The system approval path is the SAME approveInboxItem a person's approval
 * runs, through the same posting cores, as the system actor carrying a grant
 * the job mints only after every check passed under the lifecycle lock. What
 * it writes names Jev everywhere and borrows no user.
 *
 * `categorize` stays structurally manual everywhere except the inbox_approve
 * lane (INBOX_APPROVE_LANE_EXCEPTIONS): a lane at auto approves a paper only
 * when every check passes, and every "always human" condition holds it.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Nothing here may reach a model: stage 2 runs on a stubbed classifier, and
  // mock mode answers anything else.
  vi.stubEnv("AI_MODE", "mock");
});

import { db } from "@/db";
import {
  aiActionProposals,
  aiAutonomyLanes,
  aiRunFeedback,
  organizationAiSettings,
} from "@/db/schema/ai";
import { organization } from "@/db/schema/auth";
import { activityLogs } from "@/db/schema/activity-logs";
import { bills } from "@/db/schema/bills";
import {
  inboxItems,
  organizationAccountingSettings,
  processingJobs,
  reviewDecisions,
  reviewFindings,
  sourceMatchCandidates,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { classificationMemories } from "@/db/schema/classification-memories";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { updateOrgAiConfig } from "@/lib/ai/org-ai-config";
import {
  CLASSIFY_INBOX_CANDIDATE_JOB_TYPE,
  candidateClassificationDedupeKey,
} from "@/lib/inbox/candidate-classification-job";
import { recordJevProposalAfterClassification } from "@/lib/inbox/jev-approval/after-classification";
import { latestJevProposal } from "@/lib/inbox/jev-approval/proposal";
import { undoJevApproval } from "@/lib/inbox/jev-approval/undo";
import { approveInboxItem } from "@/lib/inbox/service";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import { JEV_AUTO_APPROVE_JOB_TYPE } from "@/lib/inbox/jev-approval/auto-approve";
import { JEV_AUTO_APPROVAL_HELD_ACTION } from "@/lib/inbox/jev-approval/feedback";
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import { updateJevApprovalSettings } from "@/lib/inbox/jev-approval/settings";
import { processClassifyInboxCandidateJob } from "@/lib/jobs/handlers/classify-inbox-candidate";
import { processJevAutoApproveJob } from "@/lib/jobs/handlers/jev-auto-approve";
import { mintJevApprovalGrant } from "@/lib/posting/system-approval-grant";
import {
  asOrg,
  attachInboundMessage,
  classifyPaper,
  disableRule,
  rememberVendorReceipts,
  senderVerdict,
  setJevApprovalSettings,
  setLaneAuto,
  setupJevOrganization,
  stubbedJevClassifier,
  submitJevBill,
  submitJevExpense,
  uploadPaper,
  type JevFixture,
} from "../utils/jev-fixture";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Claim the queued Jev approval job for one candidate revision and run it through the handler. */
async function runQueuedJevJob(fixture: JevFixture, candidateId: string, revision: number) {
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
        eq(processingJobs.organizationId, fixture.orgId),
        eq(processingJobs.jobType, JEV_AUTO_APPROVE_JOB_TYPE),
        eq(processingJobs.status, "queued"),
        eq(processingJobs.dedupeKey, `jev-auto-approve:${candidateId}:${revision}`),
      ),
    )
    .returning();
  if (!job) throw new Error("No queued Jev approval job for this candidate revision.");
  const result = await processJevAutoApproveJob(job, { workerId });
  const [after] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
  return { result, job: after };
}

/** An org whose Jev switch is on, with no spot checks unless a test asks for them. */
async function readyOrganization(prefix: string) {
  const fixture = await setupJevOrganization(prefix);
  await setJevApprovalSettings(fixture.orgId, {
    inboxAutoapproveEnabled: true,
    inboxSpotCheckRate: "0",
  });
  return fixture;
}

/**
 * A ready org whose lane for the fixture vendor's expenses is at auto (cap 500,
 * threshold 0.95): the first paper creates the lane, an admin promoted it.
 */
async function autoLaneOrganization(prefix: string) {
  const fixture = await readyOrganization(prefix);
  const first = await submitJevExpense(fixture, { amount: "43.10", day: 1 });
  await setLaneAuto(first.proposal!.laneId, { amountCap: "500", confidenceThreshold: "0.95" });
  return { fixture, laneId: first.proposal!.laneId };
}

/** Submit a paper Jev proposed and record it the way stage 2's job does, queueing approval. */
async function proposeOnLane(
  fixture: JevFixture,
  input: Omit<Parameters<typeof submitJevExpense>[1], "record">,
) {
  const paper = await submitJevExpense(fixture, { ...input, record: false });
  const proposal = await asOrg(fixture, (tx) =>
    recordJevProposalAfterClassification(tx, {
      orgId: fixture.orgId,
      candidateId: paper.candidate.id,
    }),
  );
  return { ...paper, proposal };
}

async function queuedJevJobs(fixture: JevFixture) {
  return db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.organizationId, fixture.orgId),
        eq(processingJobs.jobType, JEV_AUTO_APPROVE_JOB_TYPE),
        eq(processingJobs.status, "queued"),
      ),
    );
}

async function journalsFor(candidateId: string) {
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, candidateId));
  return candidate.postedJournalHeaderId;
}

describeDb("Jev approves papers on an auto lane", () => {
  it("approves a paper that passes every check, through the path a person's approval takes", async () => {
    const { fixture, laneId } = await autoLaneOrganization("jev-auto-approves");
    const { item, candidate, proposal } = await proposeOnLane(fixture, {
      amount: "42.10",
      day: 3,
    });
    expect(proposal!.laneId).toBe(laneId);
    expect(proposal!.evaluation).toMatchObject({
      approve: true,
      wouldApprove: true,
      heldForSpotCheck: false,
      holds: [],
    });
    // Stage 2's hook queued Jev's approval for this revision.
    expect((await queuedJevJobs(fixture)).map((job) => job.payload)).toEqual([
      { candidateId: candidate.id, candidateRevision: candidate.revision },
    ]);

    const { result, job } = await runQueuedJevJob(fixture, candidate.id, candidate.revision);
    expect(result).toMatchObject({ processed: true, status: "approved", laneId });
    expect(job.status).toBe("completed");

    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.journalHeaderId as string));
    expect(journal).toMatchObject({ status: "posted", createdBy: JEV_AUDIT_ACTOR_ID });
    const [approved] = await db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(approved).toMatchObject({ state: "approved", resolvedBy: null });
    const [decision] = await db
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.inboxItemId, item.id));
    expect(decision).toMatchObject({ actorType: "system", actorKey: "jev", actorId: null });
    const [activity] = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.entityId, journal.id), eq(activityLogs.action, "approved_from_inbox")),
      );
    expect(activity.changes).toMatchObject({
      jevApproval: { laneId, confidence: 0.97, ruleSnapshotId: null },
    });
    // Jev's approval is not a label, and the paper has left the Inbox.
    expect(
      await db.select().from(aiRunFeedback).where(eq(aiRunFeedback.organizationId, fixture.orgId)),
    ).toEqual([]);
    const list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.some((row) => row.id === item.id)).toBe(false);
  });

  it("creates the vendor bill when it approves an emailed bill", async () => {
    const fixture = await readyOrganization("jev-auto-bill-lane");
    const first = await submitJevBill(fixture, { amount: "20.00", day: 2 });
    await setLaneAuto(first.proposal!.laneId, { amountCap: "500", confidenceThreshold: "0.95" });
    const paper = await submitJevBill(fixture, { amount: "64.20", day: 5, record: false });
    const proposal = await asOrg(fixture, (tx) =>
      recordJevProposalAfterClassification(tx, {
        orgId: fixture.orgId,
        candidateId: paper.candidate.id,
      }),
    );
    expect(proposal).toMatchObject({ kind: "vendor_bill", evaluation: { approve: true } });

    // The same bill from a message whose sender was never verified stays with a person.
    const unverified = await submitJevBill(fixture, { amount: "64.30", day: 6, sender: null });
    expect(unverified.proposal!.evaluation).toMatchObject({
      approve: false,
      holds: [
        {
          reason: "sender_unverified",
          scope: "paper",
          detail: "it was not checked when it arrived",
        },
      ],
    });

    const { result } = await runQueuedJevJob(fixture, paper.candidate.id, paper.candidate.revision);
    expect(result).toMatchObject({ status: "approved" });
    const [bill] = await db
      .select()
      .from(bills)
      .where(eq(bills.id, result.billId as string));
    expect(bill).toMatchObject({
      status: "awaiting_payment",
      amount: "64.20",
      approverId: JEV_AUDIT_ACTOR_ID,
      vendorId: fixture.vendor.id,
    });
  });

  type Mutation = (input: {
    fixture: JevFixture;
    laneId: string;
    paper: Awaited<ReturnType<typeof proposeOnLane>>;
  }) => Promise<void>;

  const ALWAYS_HUMAN: Array<[string, Mutation, string]> = [
    [
      "a new party would be created",
      async ({ fixture, paper }) => {
        await db.insert(aiActionProposals).values({
          organizationId: fixture.orgId,
          kind: "create_party",
          proposal: { entity: { name: "Paper Street Supply Ltd" } },
          sourceRef: { entityType: "transaction_candidate", entityId: paper.candidate.id },
        });
      },
      "new_party",
    ],
    [
      "the payee's bank details changed, even once a person resolved it",
      async ({ fixture, paper }) => {
        await db.insert(reviewFindings).values({
          organizationId: fixture.orgId,
          inboxItemId: paper.item.id,
          candidateId: paper.candidate.id,
          ruleKey: "party_payment_details_changed",
          impact: "blocking",
          state: "resolved",
          subjectType: "transaction_candidate",
          subjectId: paper.candidate.id,
          fingerprint: `${paper.candidate.id}:payment-details:test`,
          message: "Different bank details.",
        });
      },
      "payment_details_changed",
    ],
    [
      "it turns out to have come in an email whose sender could not be verified",
      async ({ fixture, paper }) => {
        await attachInboundMessage(
          fixture,
          paper.candidate.id,
          senderVerdict({
            passed: false,
            reason: "failed",
            method: null,
            results: { dmarc: "fail", dkim: "none", spf: "fail" },
          }),
        );
      },
      "sender_unverified",
    ],
    [
      "it may be a duplicate",
      async ({ fixture, paper }) => {
        const other = await submitJevExpense(fixture, { amount: "99.99", day: 28, record: false });
        const [left, right] = [
          paper.candidate.sourceRecordId!,
          other.candidate.sourceRecordId!,
        ].sort();
        await db.insert(sourceMatchCandidates).values({
          organizationId: fixture.orgId,
          leftSourceRecordId: left,
          rightSourceRecordId: right,
          matchType: "probable",
          score: "80",
        });
      },
      "duplicate_case",
    ],
    [
      "its period is closed",
      async ({ fixture }) => {
        await db
          .update(organization)
          .set({ closedThrough: "2026-08-31" })
          .where(eq(organization.id, fixture.orgId));
      },
      "period_locked",
    ],
    [
      "maker-checker is on and Jev was not opted in",
      async ({ fixture }) => {
        await db
          .update(organizationAccountingSettings)
          .set({ requireDifferentApprover: true })
          .where(eq(organizationAccountingSettings.organizationId, fixture.orgId));
      },
      "maker_checker",
    ],
    [
      "a warning is open",
      async ({ fixture, paper }) => {
        await db.insert(reviewFindings).values({
          organizationId: fixture.orgId,
          inboxItemId: paper.item.id,
          candidateId: paper.candidate.id,
          ruleKey: "transaction_in_parent_category",
          impact: "warning",
          subjectType: "transaction_candidate",
          subjectId: paper.candidate.id,
          fingerprint: `${paper.candidate.id}:warning:test`,
          message: "Post to a leaf category.",
        });
      },
      "open_warning",
    ],
    [
      "it is over the lane's cap",
      async ({ laneId }) => {
        await db
          .update(aiAutonomyLanes)
          .set({ amountCap: "10" })
          .where(eq(aiAutonomyLanes.id, laneId));
      },
      "over_cap",
    ],
    [
      "Jev's confidence is below the lane's threshold",
      async ({ laneId }) => {
        await db
          .update(aiAutonomyLanes)
          .set({ confidenceThreshold: "0.99" })
          .where(eq(aiAutonomyLanes.id, laneId));
      },
      "below_threshold",
    ],
    [
      "the organization's switch is off",
      async ({ fixture }) => {
        await setJevApprovalSettings(fixture.orgId, { inboxAutoapproveEnabled: false });
      },
      "autoapprove_off",
    ],
    [
      "the AI kill switch is on",
      async ({ fixture }) => {
        await setJevApprovalSettings(fixture.orgId, { killSwitch: true });
      },
      "ai_kill_switch",
    ],
    [
      "the lane was demoted after the paper was queued",
      async ({ laneId }) => {
        await db
          .update(aiAutonomyLanes)
          .set({ level: "suggest" })
          .where(eq(aiAutonomyLanes.id, laneId));
      },
      "lane_not_auto",
    ],
  ];

  it.each(ALWAYS_HUMAN)(
    "decides again under the lock and holds the paper when %s",
    async (_label, mutate, reason) => {
      const { fixture, laneId } = await autoLaneOrganization("jev-auto-human");
      const paper = await proposeOnLane(fixture, { amount: "42.10", day: 3 });
      expect(paper.proposal!.evaluation.approve).toBe(true);
      await mutate({ fixture, laneId, paper });

      const { result, job } = await runQueuedJevJob(
        fixture,
        paper.candidate.id,
        paper.candidate.revision,
      );
      expect(result).toMatchObject({ processed: true, status: "held", heldForSpotCheck: false });
      expect((result.holds as Array<{ reason: string }>).map((hold) => hold.reason)).toContain(
        reason,
      );
      expect(job.status).toBe("completed");
      expect(await journalsFor(paper.candidate.id)).toBeNull();
      const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, paper.item.id));
      expect(item.state).toBe("ready_for_review");
    },
  );

  it("a shadow-mode duplicate case is observe-only and does not hold Jev", async () => {
    const { fixture } = await autoLaneOrganization("jev-auto-shadow-dup");
    const paper = await proposeOnLane(fixture, { amount: "42.10", day: 3 });
    const other = await submitJevExpense(fixture, { amount: "99.99", day: 28, record: false });
    const [left, right] = [paper.candidate.sourceRecordId!, other.candidate.sourceRecordId!].sort();
    await db.insert(sourceMatchCandidates).values({
      organizationId: fixture.orgId,
      leftSourceRecordId: left,
      rightSourceRecordId: right,
      matchType: "probable",
      score: "80",
      disposition: "shadow",
    });

    const { result } = await runQueuedJevJob(fixture, paper.candidate.id, paper.candidate.revision);
    expect(result).toMatchObject({ status: "approved" });
  });

  it("skips a paper a person changed after it was queued", async () => {
    const { fixture } = await autoLaneOrganization("jev-auto-stale");
    const paper = await proposeOnLane(fixture, { amount: "42.10", day: 3 });
    await asOrg(
      fixture,
      (tx) =>
        correctInboxCandidate(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          {
            inboxItemId: paper.item.id,
            expectedRevision: paper.candidate.revision,
            expectedLockVersion: paper.item.lockVersion,
            transactionDate: "2026-08-03",
            transactionType: "pay_out",
            partyId: fixture.vendor.id,
            originalCurrency: "USD",
            lines: [
              {
                accountId: fixture.hardware.id,
                debit: "42.10",
                departmentId: fixture.department.id,
                locationId: fixture.location.id,
              },
              {
                accountId: fixture.bank.id,
                credit: "42.10",
                departmentId: fixture.department.id,
                locationId: fixture.location.id,
              },
            ],
          },
        ),
      fixture.reviewerId,
    );
    const { result } = await runQueuedJevJob(fixture, paper.candidate.id, paper.candidate.revision);
    expect(result).toMatchObject({ status: "skipped", reason: "stale_revision" });
    expect(await journalsFor(paper.candidate.id)).toBeNull();
  });

  it("holds a spot-check sample back before posting, and the person's decision labels the lane", async () => {
    const { fixture, laneId } = await autoLaneOrganization("jev-auto-spot");
    await setJevApprovalSettings(fixture.orgId, { inboxSpotCheckRate: "1" });
    const sampled = await proposeOnLane(fixture, { amount: "42.10", day: 3 });
    // Decided at proposal time: held back, so no approval is even queued.
    expect(sampled.proposal!.evaluation).toMatchObject({
      approve: false,
      wouldApprove: true,
      heldForSpotCheck: true,
      holds: [{ reason: "spot_check", scope: "sample" }],
    });
    expect(await queuedJevJobs(fixture)).toEqual([]);
    let list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.find((row) => row.id === sampled.item.id)).toMatchObject({
      reason: "spot_check",
      reasonText: "Jev would approve this — spot check.",
    });

    // The person approves it unchanged: an unbiased "accepted" for the lane.
    await asOrg(
      fixture,
      (tx) =>
        approveInboxItem(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          {
            inboxItemId: sampled.item.id,
            expectedRevision: sampled.candidate.revision,
            expectedLockVersion: sampled.item.lockVersion,
          },
        ),
      fixture.reviewerId,
    );
    const [label] = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.organizationId, fixture.orgId));
    expect(label).toMatchObject({
      laneId,
      verdict: "accepted",
      laneEvidence: { spotCheck: true, wouldApprove: true, autoApproved: false },
    });

    // Sampled only once queued (the share was raised meanwhile): the job holds it.
    await setJevApprovalSettings(fixture.orgId, { inboxSpotCheckRate: "0" });
    const later = await proposeOnLane(fixture, { amount: "42.20", day: 4 });
    expect(later.proposal!.evaluation.approve).toBe(true);
    await setJevApprovalSettings(fixture.orgId, { inboxSpotCheckRate: "1" });
    const { result } = await runQueuedJevJob(fixture, later.candidate.id, later.candidate.revision);
    expect(result).toMatchObject({ status: "held", heldForSpotCheck: true });
    expect(await journalsFor(later.candidate.id)).toBeNull();
    list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.find((row) => row.id === later.item.id)?.reason).toBe("spot_check");
  });

  it("acts only on papers in the job row's own organization", async () => {
    const { fixture: owner } = await autoLaneOrganization("jev-auto-tenant-a");
    const paper = await proposeOnLane(owner, { amount: "42.10", day: 3 });
    const intruder = await readyOrganization("jev-auto-tenant-b");
    const workerId = `test-worker-${randomUUID()}`;
    const [job] = await db
      .insert(processingJobs)
      .values({
        organizationId: intruder.orgId,
        jobType: JEV_AUTO_APPROVE_JOB_TYPE,
        status: "running",
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60_000),
        attempts: 1,
        payload: { candidateId: paper.candidate.id, candidateRevision: paper.candidate.revision },
      })
      .returning();
    const result = await processJevAutoApproveJob(job, { workerId });
    expect(result).toMatchObject({ processed: true, status: "skipped", reason: "not_found" });
    expect(await journalsFor(paper.candidate.id)).toBeNull();
  });

  it("end to end: stage 2 on a stubbed classifier leaves the payment side open, so nothing is queued", async () => {
    const { fixture, laneId } = await autoLaneOrganization("jev-auto-e2e-open");
    await disableRule(fixture.orgId, "missing_department");
    await disableRule(fixture.orgId, "missing_location");
    const { candidate } = await uploadPaper(fixture, {});
    const classified = await classifyPaper(fixture, candidate, stubbedJevClassifier("67200", 0.97));
    expect(classified).toMatchObject({ status: "classified", party: { outcome: "exact" } });
    const proposal = await asOrg(fixture, (tx) =>
      latestJevProposal(tx, fixture.orgId, candidate.id),
    );
    // Jev's pick is confident, but a paper stage 2 alone read is never complete.
    expect(proposal).toMatchObject({ laneId, source: "jev", confidence: 0.97 });
    expect(proposal!.evaluation.holds.map((hold) => hold.reason)).toContain("incomplete_entry");
    expect(await queuedJevJobs(fixture)).toEqual([]);
  });

  it("end to end: a remembered receipt on an auto lane posts by itself, and an undo counts against lane and memory", async () => {
    const fixture = await readyOrganization("jev-auto-e2e");
    // A reviewer settled one receipt from the vendor and asked Jev to remember it.
    const { first, memory } = await rememberVendorReceipts(fixture);
    const firstProposal = await asOrg(fixture, (tx) =>
      latestJevProposal(tx, fixture.orgId, first.candidate.id),
    );
    // The vendor's expense lane has earned auto on Jev's own answers.
    const laneId = firstProposal!.laneId;
    await setLaneAuto(laneId, { amountCap: "500", confidenceThreshold: "0.95" });

    // The vendor's next receipt: intake queues stage 2, and its real job runs
    // under AI_MODE=mock — the memory answers, so no model is asked anything.
    const next = await uploadPaper(fixture, { amount: "52.10", date: "2026-08-25" });
    const workerId = `test-worker-${randomUUID()}`;
    const [classifyJob] = await db
      .update(processingJobs)
      .set({
        status: "running",
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60_000),
        attempts: 1,
      })
      .where(
        and(
          eq(processingJobs.organizationId, fixture.orgId),
          eq(processingJobs.jobType, CLASSIFY_INBOX_CANDIDATE_JOB_TYPE),
          eq(
            processingJobs.dedupeKey,
            candidateClassificationDedupeKey(next.candidate.id, next.candidate.revision),
          ),
        ),
      )
      .returning();
    expect(await processClassifyInboxCandidateJob(classifyJob, { workerId })).toMatchObject({
      processed: true,
      memory: { outcome: "hit", matchKind: "party", memoryIds: [memory.memoryId] },
      readyForReview: true,
    });

    const proposal = await asOrg(fixture, (tx) =>
      latestJevProposal(tx, fixture.orgId, next.candidate.id),
    );
    expect(proposal).toMatchObject({
      laneId,
      source: "memory",
      confidence: 1,
      evaluation: { approve: true, holds: [] },
    });
    const { result } = await runQueuedJevJob(
      fixture,
      next.candidate.id,
      proposal!.candidateRevision,
    );
    expect(result).toMatchObject({ processed: true, status: "approved", laneId });

    // Posted as Jev, exactly the remembered entry at this receipt's own amount.
    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.journalHeaderId as string));
    expect(journal).toMatchObject({
      status: "posted",
      createdBy: JEV_AUDIT_ACTOR_ID,
      totalAmount: "52.10000000",
      transactionDate: "2026-08-25",
      partyId: fixture.vendor.id,
    });
    const posted = await db
      .select({
        accountId: journalLines.accountId,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, journal.id));
    expect(posted).toEqual(
      expect.arrayContaining([
        { accountId: fixture.officeSupplies.id, debit: "52.10000000", credit: null },
        { accountId: fixture.bank.id, debit: null, credit: "52.10000000" },
      ]),
    );
    expect(posted).toHaveLength(2);
    // The memory's answer, approved unchanged, is confirmed — by Jev.
    const [confirmed] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.entityId, next.candidate.id),
          eq(workflowEvents.action, "memory_confirmed"),
        ),
      );
    expect(confirmed).toMatchObject({ actorType: "system", actorId: JEV_AUDIT_ACTOR_ID });
    let list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.some((row) => row.id === next.inboxItemId)).toBe(false);

    // A person disagrees: reversal only, the paper back in the Inbox, and both
    // the lane and the memory count it.
    const undone = await asOrg(
      fixture,
      (tx) =>
        undoJevApproval(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          { journalHeaderId: journal.id, reason: "Paid personally" },
        ),
      fixture.reviewerId,
    );
    expect(undone.laneId).toBe(laneId);
    const [label] = await db
      .select()
      .from(aiRunFeedback)
      .where(
        and(eq(aiRunFeedback.organizationId, fixture.orgId), eq(aiRunFeedback.verdict, "rejected")),
      );
    expect(label).toMatchObject({
      laneId,
      laneEvidence: { source: "memory", autoApproved: true, confidence: 1 },
    });
    const [remembered] = await db
      .select()
      .from(classificationMemories)
      .where(eq(classificationMemories.id, memory.memoryId));
    expect(remembered).toMatchObject({ undos: 1, consecutiveUndos: 1 });
    list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.find((row) => row.id === next.inboxItemId)).toMatchObject({
      reason: "ready",
      reasonDetail: "remembered",
    });
  });
});

describeDb("categorize outside the inbox_approve lane", () => {
  it("is still refused for per-kind autonomy, at any accuracy", async () => {
    const fixture = await setupJevOrganization("jev-categorize-wall");
    await expect(
      updateOrgAiConfig(db, {
        orgId: fixture.orgId,
        actorId: fixture.userId,
        autonomy: { categorize: "auto_apply_high_confidence" },
      }),
    ).rejects.toThrow(/always applied by a human/);
    const [settings] = await db
      .select({ autonomy: organizationAiSettings.autonomy })
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, fixture.orgId));
    expect(settings?.autonomy ?? {}).toEqual({});
  });
});

describeDb("the organization's Jev settings", () => {
  it("are off by default, admin-changed with an audit row, and hold papers while off", async () => {
    const fixture = await setupJevOrganization("jev-auto-settings");
    const earlier = await submitJevExpense(fixture, { amount: "14.10", day: 2 });
    // No settings row at all: the switch reads off, and holds the paper.
    expect(earlier.proposal!.evaluation.holds.map((hold) => hold.reason)).toContain(
      "autoapprove_off",
    );

    const saved = await asOrg(fixture, (tx) =>
      updateJevApprovalSettings(tx, {
        orgId: fixture.orgId,
        actorId: fixture.userId,
        autoApproveEnabled: true,
        spotCheckRate: "0.2500",
      }),
    );
    expect(saved).toMatchObject({ autoApproveEnabled: true, spotCheckRate: 0.25 });
    const [audit] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.organizationId, fixture.orgId),
          eq(activityLogs.action, "jev_approval_settings_updated"),
        ),
      );
    expect(audit).toMatchObject({
      actorId: fixture.userId,
      changes: {
        autoApproveEnabled: { old: false, new: true },
        spotCheckRate: { old: 0.1, new: 0.25 },
      },
    });
    await expect(
      asOrg(fixture, (tx) =>
        updateJevApprovalSettings(tx, {
          orgId: fixture.orgId,
          actorId: fixture.userId,
          spotCheckRate: "1.5",
        }),
      ),
    ).rejects.toThrow(/between 0 and 1/);

    const later = await submitJevExpense(fixture, { amount: "14.20", day: 3 });
    expect(later.proposal!.evaluation.holds.map((hold) => hold.reason)).not.toContain(
      "autoapprove_off",
    );
    await asOrg(fixture, (tx) =>
      updateJevApprovalSettings(tx, {
        orgId: fixture.orgId,
        actorId: fixture.userId,
        autoApproveEnabled: false,
      }),
    );
    const off = await submitJevExpense(fixture, { amount: "14.30", day: 4 });
    expect(off.proposal!.evaluation.holds.map((hold) => hold.reason)).toContain("autoapprove_off");
  });
});

describeDb("the system approval path", () => {
  it("posts through the same approval and cores, naming Jev and borrowing no user", async () => {
    const fixture = await readyOrganization("jev-auto-path");
    const { item, candidate, proposal } = await submitJevExpense(fixture, {
      amount: "42.10",
      day: 3,
    });
    const grant = mintJevApprovalGrant({
      laneId: proposal!.laneId,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      confidence: 0.97,
    });
    const result = await asOrg(fixture, (tx) =>
      approveInboxItem(
        { db: tx, orgId: fixture.orgId, userId: JEV_AUDIT_ACTOR_ID, role: "system" },
        {
          inboxItemId: item.id,
          expectedRevision: candidate.revision,
          expectedLockVersion: item.lockVersion,
        },
        {
          systemApproval: {
            grant,
            laneId: proposal!.laneId,
            confidence: 0.97,
            ruleSnapshotId: null,
            makerCheckerOptIn: false,
          },
        },
      ),
    );
    expect(result).toMatchObject({ approvalOutcome: "approved", alreadyApproved: false });
    if (result.approvalOutcome !== "approved") throw new Error("unreachable");

    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.journalHeaderId));
    expect(journal).toMatchObject({ status: "posted", createdBy: JEV_AUDIT_ACTOR_ID });
    const [approved] = await db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(approved).toMatchObject({ state: "approved", resolvedBy: null });
    expect(approved.resolvedAt).toBeInstanceOf(Date);
    expect(approved.resolutionNote).toContain(proposal!.laneId);
    const [decision] = await db
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.inboxItemId, item.id));
    expect(decision).toMatchObject({
      decision: "approved",
      actorType: "system",
      actorKey: "jev",
      actorId: null,
      journalHeaderId: journal.id,
    });
    const [activity] = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.entityId, journal.id), eq(activityLogs.action, "approved_from_inbox")),
      );
    expect(activity).toMatchObject({
      actorId: JEV_AUDIT_ACTOR_ID,
      changes: {
        jevApproval: {
          actor: "jev",
          laneId: proposal!.laneId,
          confidence: 0.97,
          ruleSnapshotId: null,
        },
      },
    });
    // Jev's own approval is not a label for its lane.
    expect(
      await db.select().from(aiRunFeedback).where(eq(aiRunFeedback.organizationId, fixture.orgId)),
    ).toEqual([]);
  });

  it("creates the vendor bill through the bill core, approved by Jev", async () => {
    const fixture = await readyOrganization("jev-auto-bill");
    const { item, candidate, proposal } = await submitJevBill(fixture, { amount: "64.20", day: 5 });
    expect(proposal).toMatchObject({ kind: "vendor_bill", source: "jev" });
    const grant = mintJevApprovalGrant({
      laneId: proposal!.laneId,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      confidence: 0.97,
    });
    const result = await asOrg(fixture, (tx) =>
      approveInboxItem(
        { db: tx, orgId: fixture.orgId, userId: JEV_AUDIT_ACTOR_ID, role: "system" },
        {
          inboxItemId: item.id,
          expectedRevision: candidate.revision,
          expectedLockVersion: item.lockVersion,
        },
        {
          systemApproval: {
            grant,
            laneId: proposal!.laneId,
            confidence: 0.97,
            ruleSnapshotId: null,
            makerCheckerOptIn: false,
          },
        },
      ),
    );
    if (result.approvalOutcome !== "approved") throw new Error("expected an approval");
    const [bill] = await db.select().from(bills).where(eq(bills.id, result.billId!));
    expect(bill).toMatchObject({
      status: "awaiting_payment",
      amount: "64.20",
      approverId: JEV_AUDIT_ACTOR_ID,
      journalHeaderId: result.journalHeaderId,
      vendorId: fixture.vendor.id,
    });
  });

  it("refuses a grant for another paper, and maker-checker without the opt-in", async () => {
    const fixture = await readyOrganization("jev-auto-refuse");
    const one = await submitJevExpense(fixture, { amount: "11.00", day: 6 });
    const two = await submitJevExpense(fixture, { amount: "12.00", day: 7 });
    const grantForOne = mintJevApprovalGrant({
      laneId: one.proposal!.laneId,
      candidateId: one.candidate.id,
      candidateRevision: one.candidate.revision,
      confidence: 0.97,
    });
    const approveTwoWith = (makerCheckerOptIn: boolean, grant = grantForOne) =>
      asOrg(fixture, (tx) =>
        approveInboxItem(
          { db: tx, orgId: fixture.orgId, userId: JEV_AUDIT_ACTOR_ID, role: "system" },
          {
            inboxItemId: two.item.id,
            expectedRevision: two.candidate.revision,
            expectedLockVersion: two.item.lockVersion,
          },
          {
            systemApproval: {
              grant,
              laneId: two.proposal!.laneId,
              confidence: 0.97,
              ruleSnapshotId: null,
              makerCheckerOptIn,
            },
          },
        ),
      );
    await expect(approveTwoWith(false)).rejects.toThrow(/granted for a different paper/);

    const { organizationAccountingSettings } = await import("@/db/schema/inbox");
    await db
      .update(organizationAccountingSettings)
      .set({ requireDifferentApprover: true })
      .where(eq(organizationAccountingSettings.organizationId, fixture.orgId));
    const grantForTwo = mintJevApprovalGrant({
      laneId: two.proposal!.laneId,
      candidateId: two.candidate.id,
      candidateRevision: two.candidate.revision,
      confidence: 0.97,
    });
    await expect(approveTwoWith(false, grantForTwo)).rejects.toThrow(
      /requires a different approver, and Jev has not been opted in/,
    );
    // With the admin's opt-in, Jev may approve under maker-checker.
    await expect(approveTwoWith(true, grantForTwo)).resolves.toMatchObject({
      approvalOutcome: "approved",
    });
  });
});

describeDb("the Inbox reads Jev's decisions", () => {
  it("says when a suggest lane's Jev would approve a paper", async () => {
    const fixture = await setupJevOrganization("jev-list-suggest");
    const earlier = await submitJevExpense(fixture, { amount: "10.10", day: 2 });
    const { aiAutonomyLanes } = await import("@/db/schema/ai");
    await db
      .update(aiAutonomyLanes)
      .set({ level: "suggest" })
      .where(eq(aiAutonomyLanes.id, earlier.proposal!.laneId));
    const suggested = await submitJevExpense(fixture, { amount: "10.20", day: 3 });

    const list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get(suggested.item.id)).toMatchObject({
      reason: "ready",
      reasonDetail: "jev_would_approve",
      reasonText: "Jev would approve this. Review the entry and approve it.",
    });
    // Recorded while the lane was still watching: no suggestion.
    expect(byId.get(earlier.item.id)).toMatchObject({ reason: "ready", reasonDetail: "ready" });
  });

  it("keeps a paper held back as a spot check in the Inbox, until a person changes it", async () => {
    const fixture = await setupJevOrganization("jev-list-spot");
    const paper = await submitJevExpense(fixture, { amount: "12.30", day: 4 });
    // What the approval job records when the sample holds a paper back.
    await db.insert(workflowEvents).values({
      organizationId: fixture.orgId,
      inboxItemId: paper.item.id,
      entityType: "transaction_candidate",
      entityId: paper.candidate.id,
      action: JEV_AUTO_APPROVAL_HELD_ACTION,
      actorType: "system",
      actorId: JEV_AUDIT_ACTOR_ID,
      data: {
        candidateRevision: paper.candidate.revision,
        evaluation: { heldForSpotCheck: true, holds: [{ reason: "spot_check", scope: "sample" }] },
      },
    });
    let list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.find((item) => item.id === paper.item.id)).toMatchObject({
      reason: "spot_check",
      reasonText: "Jev would approve this — spot check.",
    });

    // A person's edit moves the paper past the held revision.
    await asOrg(
      fixture,
      (tx) =>
        correctInboxCandidate(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          {
            inboxItemId: paper.item.id,
            expectedRevision: paper.candidate.revision,
            expectedLockVersion: paper.item.lockVersion,
            transactionDate: "2026-08-04",
            transactionType: "pay_out",
            partyId: fixture.vendor.id,
            originalCurrency: "USD",
            lines: [
              {
                accountId: fixture.hardware.id,
                debit: "12.30",
                departmentId: fixture.department.id,
                locationId: fixture.location.id,
              },
              {
                accountId: fixture.bank.id,
                credit: "12.30",
                departmentId: fixture.department.id,
                locationId: fixture.location.id,
              },
            ],
          },
        ),
      fixture.reviewerId,
    );
    list = await asOrg(fixture, (tx) => listInboxV2Items(tx, fixture.orgId));
    expect(list.items.find((item) => item.id === paper.item.id)?.reason).toBe("ready");
  });
});
