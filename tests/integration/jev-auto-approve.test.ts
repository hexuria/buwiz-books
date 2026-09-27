/**
 * Jev approving papers through its lane (Inbox v2 spec §8, build step 11).
 *
 * The system approval path is the SAME approveInboxItem a person's approval
 * runs, through the same posting cores, as the system actor carrying a grant
 * the job mints only after every check passed under the lifecycle lock. What
 * it writes names Jev everywhere and borrows no user.
 *
 * While `categorize` stays structurally manual for the inbox_approve lane, a
 * lane at auto with every other check passing still posts nothing.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { aiRunFeedback } from "@/db/schema/ai";
import { activityLogs } from "@/db/schema/activity-logs";
import { bills } from "@/db/schema/bills";
import {
  inboxItems,
  processingJobs,
  reviewDecisions,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { approveInboxItem } from "@/lib/inbox/service";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import {
  JEV_AUTO_APPROVE_JOB_TYPE,
  enqueueJevAutoApproval,
} from "@/lib/inbox/jev-approval/auto-approve";
import { JEV_AUTO_APPROVAL_HELD_ACTION } from "@/lib/inbox/jev-approval/feedback";
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import { updateJevApprovalSettings } from "@/lib/inbox/jev-approval/settings";
import { processJevAutoApproveJob } from "@/lib/jobs/handlers/jev-auto-approve";
import { mintJevApprovalGrant } from "@/lib/posting/system-approval-grant";
import {
  asOrg,
  setJevApprovalSettings,
  setLaneAuto,
  setupJevOrganization,
  submitJevBill,
  submitJevExpense,
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

/** An org whose lane for the fixture vendor is at auto and whose Jev switch is on. */
async function readyOrganization(prefix: string) {
  const fixture = await setupJevOrganization(prefix);
  await setJevApprovalSettings(fixture.orgId, { inboxAutoapproveEnabled: true });
  return fixture;
}

describeDb("Jev auto-approval while categorize is walled", () => {
  it("holds a paper that passes every other check, and posts nothing", async () => {
    const fixture = await readyOrganization("jev-auto-walled");
    // The first paper creates the vendor's lane; an admin then promotes it.
    const earlier = await submitJevExpense(fixture, { amount: "43.10", day: 2 });
    await setLaneAuto(earlier.proposal!.laneId, { amountCap: "500", confidenceThreshold: "0.95" });

    const { item, candidate, proposal } = await submitJevExpense(fixture, {
      amount: "42.10",
      day: 3,
    });
    expect(proposal!.laneId).toBe(earlier.proposal!.laneId);
    expect(proposal!.evaluation).toMatchObject({ approve: false, wouldApprove: true });
    expect(proposal!.evaluation.holds.map((hold) => hold.reason)).toEqual(["walled_kind"]);

    // Even run directly, the job decides again and holds it for the same reason.
    await asOrg(fixture, (tx) =>
      enqueueJevAutoApproval(tx, {
        orgId: fixture.orgId,
        candidateId: candidate.id,
        candidateRevision: candidate.revision,
      }),
    );
    const { result, job } = await runQueuedJevJob(fixture, candidate.id, candidate.revision);
    expect(result).toMatchObject({ processed: true, status: "held", heldForSpotCheck: false });
    expect((result.holds as Array<{ reason: string }>).map((hold) => hold.reason)).toEqual([
      "walled_kind",
    ]);
    expect(job.status).toBe("completed");

    const [unchanged] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, candidate.id));
    expect(unchanged).toMatchObject({ status: "current", postedJournalHeaderId: null });
    const [stillOpen] = await db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(stillOpen.state).toBe("ready_for_review");
    expect(
      await db
        .select()
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, fixture.orgId)),
    ).toEqual([]);
    const [held] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.entityId, candidate.id),
          eq(workflowEvents.action, JEV_AUTO_APPROVAL_HELD_ACTION),
        ),
      );
    expect(held).toMatchObject({
      actorType: "system",
      actorId: JEV_AUDIT_ACTOR_ID,
      data: { evaluation: { approve: false, heldForSpotCheck: false } },
    });
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
