/**
 * Lane feedback (Inbox v2 spec §8, build step 11): every person's decision on a
 * paper Jev proposed labels that proposal once, for its lane, with what the lane
 * knew when the paper was proposed — so eligibility, calibration and agreement
 * are computed per lane, and demotion runs after every label.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { aiAutonomyLanes, aiRunFeedback } from "@/db/schema/ai";
import { transactionCandidates, workflowEvents } from "@/db/schema/inbox";
import { computeLaneEligibility, listAutonomyLanes } from "@/lib/ai/autonomy-lanes";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { recordJevProposalAfterClassification } from "@/lib/inbox/jev-approval/after-classification";
import { JEV_PROPOSAL_RECORDED_ACTION, latestJevProposal } from "@/lib/inbox/jev-approval/proposal";
import { approveInboxItem, rejectInboxItem } from "@/lib/inbox/service";
import {
  asOrg,
  seedLaneLabels,
  setLaneAuto,
  setupJevOrganization,
  stubbedJevClassifier,
  submitJevExpense,
  uploadPaper,
  type JevFixture,
} from "../utils/jev-fixture";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function feedbackOf(orgId: string) {
  return db
    .select()
    .from(aiRunFeedback)
    .where(eq(aiRunFeedback.organizationId, orgId))
    .orderBy(aiRunFeedback.createdAt);
}

async function candidateOf(candidateId: string) {
  const [row] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, candidateId));
  return row;
}

function approve(
  fixture: JevFixture,
  item: { id: string; lockVersion: number; candidateRevision: number },
) {
  return asOrg(
    fixture,
    (tx) =>
      approveInboxItem(
        { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
        {
          inboxItemId: item.id,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
        },
      ),
    fixture.reviewerId,
  );
}

/** Re-save the entry with the given changes, as the Inbox editor does. */
async function correct(
  fixture: JevFixture,
  candidateId: string,
  item: { id: string; lockVersion: number; candidateRevision: number },
  lines: Array<{ accountId: string; debit?: string; credit?: string }>,
) {
  const candidate = await candidateOf(candidateId);
  return asOrg(
    fixture,
    (tx) =>
      correctInboxCandidate(
        { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
        {
          inboxItemId: item.id,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
          transactionDate: candidate.transactionDate,
          transactionType: "pay_out",
          memo: candidate.memo,
          referenceNumber: candidate.referenceNumber,
          partyId: candidate.partyId,
          originalCurrency: candidate.originalCurrency,
          lines: lines.map((line) => ({
            ...line,
            departmentId: fixture.department.id,
            locationId: fixture.location.id,
          })),
        },
      ),
    fixture.reviewerId,
  );
}

describeDb("Jev lane feedback", () => {
  it("records nothing for a draft no system answered", async () => {
    const fixture = await setupJevOrganization("jev-fb-typed");
    const { item, proposal } = await submitJevExpense(fixture, {
      amount: "12.00",
      day: 2,
      typed: true,
    });
    // A person-typed draft carries no stage 2 evidence: there is no proposal.
    expect(proposal).toBeNull();
    await approve(fixture, item);
    expect(await feedbackOf(fixture.orgId)).toEqual([]);
    expect(
      await db
        .select()
        .from(aiAutonomyLanes)
        .where(eq(aiAutonomyLanes.organizationId, fixture.orgId)),
    ).toEqual([]);
  });

  it("records the proposal on a lane created at watch, and labels an unchanged approval accepted", async () => {
    const fixture = await setupJevOrganization("jev-fb-accept");
    const { item, candidate, proposal } = await submitJevExpense(fixture, {
      amount: "42.10",
      day: 3,
    });
    expect(proposal).toMatchObject({
      source: "jev",
      confidence: 0.97,
      kind: "expense",
      partyId: fixture.vendor.id,
      laneLevel: "watch",
      evaluation: { approve: false, wouldApprove: true, heldForSpotCheck: false },
    });
    // Watch: the org switch is off and the lane is not at auto. Maker-checker is off here.
    expect(proposal!.evaluation.holds.map((hold) => hold.reason)).toEqual([
      "lane_not_auto",
      "autoapprove_off",
      "walled_kind",
    ]);
    const [lane] = await db
      .select()
      .from(aiAutonomyLanes)
      .where(eq(aiAutonomyLanes.organizationId, fixture.orgId));
    expect(lane).toMatchObject({
      id: proposal!.laneId,
      laneKey: "inbox_approve",
      partyId: fixture.vendor.id,
      docKind: "expense",
      level: "watch",
    });
    const [event] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.entityId, candidate.id),
          eq(workflowEvents.action, JEV_PROPOSAL_RECORDED_ACTION),
        ),
      );
    expect(event).toMatchObject({
      actorType: "system",
      inboxItemId: item.id,
      idempotencyKey: `jev-proposal:${candidate.id}:${candidate.revision}`,
    });

    await approve(fixture, item);
    const [label] = await feedbackOf(fixture.orgId);
    expect(label).toMatchObject({
      laneId: lane.id,
      verdict: "accepted",
      userId: fixture.reviewerId,
      labelKey: `inbox_approve:${candidate.id}:${candidate.revision}`,
      laneEvidence: {
        candidateId: candidate.id,
        inboxItemId: item.id,
        action: "approve",
        source: "jev",
        confidence: 0.97,
        wouldApprove: true,
        spotCheck: false,
        autoApproved: false,
        laneLevel: "watch",
      },
    });
    expect(
      await asOrg(fixture, (tx) => computeLaneEligibility(tx, fixture.orgId, lane.id)),
    ).toMatchObject({ total: 1, accepted: 1 });
  });

  it("labels a change to Jev's category corrected, once, with the diff", async () => {
    const fixture = await setupJevOrganization("jev-fb-correct");
    const { item, candidate } = await submitJevExpense(fixture, { amount: "33.00", day: 4 });

    const corrected = await correct(fixture, candidate.id, item, [
      { accountId: fixture.hardware.id, debit: "33.00" },
      { accountId: fixture.bank.id, credit: "33.00" },
    ]);
    let labels = await feedbackOf(fixture.orgId);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      verdict: "corrected",
      laneEvidence: { action: "correct", wouldApprove: true },
    });
    expect(Object.keys(labels[0].correction ?? {})).toEqual(["lines"]);

    // Approving the corrected entry does not label the same proposal again.
    await approve(fixture, corrected.inboxItem);
    labels = await feedbackOf(fixture.orgId);
    expect(labels.map((row) => row.verdict)).toEqual(["corrected"]);
  });

  it("does not count filling what Jev left blank as a correction; the approval labels it", async () => {
    const fixture = await setupJevOrganization("jev-fb-blank");
    const { item, candidate, proposal } = await submitJevExpense(fixture, {
      amount: "21.50",
      day: 5,
      blankPaymentSide: true,
    });
    // An incomplete draft: Jev would not approve it, whatever the lane.
    expect(proposal!.evaluation.wouldApprove).toBe(false);
    expect(proposal!.evaluation.holds.map((hold) => hold.reason)).toContain("incomplete_entry");

    const saved = await correct(fixture, candidate.id, item, [
      { accountId: fixture.officeSupplies.id, debit: "21.50" },
      { accountId: fixture.bank.id, credit: "21.50" },
    ]);
    expect(await feedbackOf(fixture.orgId)).toEqual([]);

    await approve(fixture, saved.inboxItem);
    const labels = await feedbackOf(fixture.orgId);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      verdict: "accepted",
      labelKey: `inbox_approve:${candidate.id}:${candidate.revision}`,
      laneEvidence: { action: "approve", wouldApprove: false },
    });
  });

  it("labels an amount the person had to fix corrected, even with Jev's category kept", async () => {
    const fixture = await setupJevOrganization("jev-fb-amount");
    const { item, candidate } = await submitJevExpense(fixture, { amount: "18.00", day: 6 });
    await correct(fixture, candidate.id, item, [
      { accountId: fixture.officeSupplies.id, debit: "18.50" },
      { accountId: fixture.bank.id, credit: "18.50" },
    ]);
    const [label] = await feedbackOf(fixture.orgId);
    expect(label.verdict).toBe("corrected");
  });

  it("labels a rejection rejected, with the reason", async () => {
    const fixture = await setupJevOrganization("jev-fb-reject");
    const { item } = await submitJevExpense(fixture, { amount: "9.99", day: 7 });
    await asOrg(
      fixture,
      (tx) =>
        rejectInboxItem(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          {
            inboxItemId: item.id,
            expectedLockVersion: item.lockVersion,
            reason: "Personal expense",
          },
        ),
      fixture.reviewerId,
    );
    const [label] = await feedbackOf(fixture.orgId);
    expect(label).toMatchObject({
      verdict: "rejected",
      correction: { action: "reject", note: "Personal expense" },
      laneEvidence: { action: "reject" },
    });
  });

  it("logs would-approve false with its holds, and keeps agreement per lane", async () => {
    const fixture = await setupJevOrganization("jev-fb-agreement");
    const unsure = await submitJevExpense(fixture, { amount: "14.00", day: 8, confidence: 0.85 });
    expect(unsure.proposal!.evaluation).toMatchObject({ wouldApprove: false, threshold: 0.9 });
    expect(unsure.proposal!.evaluation.holds.map((hold) => hold.reason)).toContain(
      "below_threshold",
    );
    const sure = await submitJevExpense(fixture, { amount: "15.00", day: 9 });
    const undone = await submitJevExpense(fixture, { amount: "16.00", day: 10 });
    await approve(fixture, unsure.item);
    await approve(fixture, sure.item);
    await correct(fixture, undone.candidate.id, undone.item, [
      { accountId: fixture.hardware.id, debit: "16.00" },
      { accountId: fixture.bank.id, credit: "16.00" },
    ]);

    const [summary] = await asOrg(fixture, (tx) =>
      listAutonomyLanes(tx, fixture.orgId, "inbox_approve"),
    );
    expect(summary.agreement).toEqual({
      labeled: 3,
      accepted: 2,
      corrected: 1,
      rejected: 0,
      wouldApprove: 2,
      // Jev would have approved the corrected paper: an approval a person would undo.
      wouldApproveUndone: 1,
    });
    // Two of three labels in the 0.95–0.98 bucket, one in 0.85–0.9.
    const buckets = new Map(summary.reliability.buckets.map((bucket) => [bucket.lower, bucket]));
    expect(buckets.get(0.95)).toMatchObject({ reviewed: 2, accepted: 1 });
    expect(buckets.get(0.85)).toMatchObject({ reviewed: 1, accepted: 1 });
  });

  it("demotes an auto lane when the label that just landed tips its window below 95%", async () => {
    const fixture = await setupJevOrganization("jev-fb-demote");
    const first = await submitJevExpense(fixture, { amount: "11.00", day: 11 });
    const laneId = first.proposal!.laneId;
    // 47 accepted and 2 disagreements already in the window: 49 labels.
    await seedLaneLabels(fixture.orgId, laneId, { accepted: 47, other: 2 });
    await setLaneAuto(laneId);

    await asOrg(
      fixture,
      (tx) =>
        rejectInboxItem(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          {
            inboxItemId: first.item.id,
            expectedLockVersion: first.item.lockVersion,
            reason: "Not ours",
          },
        ),
      fixture.reviewerId,
    );
    const [lane] = await db.select().from(aiAutonomyLanes).where(eq(aiAutonomyLanes.id, laneId));
    expect(lane.level).toBe("suggest");
    expect(lane.demotedAt).toBeInstanceOf(Date);
    const [event] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(eq(workflowEvents.entityId, laneId), eq(workflowEvents.action, "jev_lane_demoted")),
      );
    expect(event).toMatchObject({
      inboxItemId: first.item.id,
      actorId: fixture.reviewerId,
      data: { automatic: true, fromLevel: "auto", toLevel: "suggest" },
    });
  });

  it("records stage 2's proposal as it classifies an uploaded paper", async () => {
    const fixture = await setupJevOrganization("jev-fb-stage2");
    const { candidate } = await uploadPaper(fixture, {});
    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      {
        complete: stubbedJevClassifier("67200", 0.96),
        beforeCommit: async (tx) => {
          await recordJevProposalAfterClassification(tx, {
            orgId: fixture.orgId,
            candidateId: candidate.id,
          });
          return true;
        },
      },
    );
    expect(result).toMatchObject({ status: "classified", party: { outcome: "exact" } });

    const proposal = await asOrg(fixture, (tx) =>
      latestJevProposal(tx, fixture.orgId, candidate.id),
    );
    expect(proposal).toMatchObject({
      candidateRevision: candidate.revision + 1,
      source: "jev",
      confidence: 0.96,
      kind: "expense",
      partyId: fixture.vendor.id,
      ruleSet: { source: "live" },
      snapshot: {
        partyId: fixture.vendor.id,
        lines: [
          { accountId: fixture.officeSupplies.id, debit: "48.60000000", credit: null },
          // Stage 2 never picks the payment side.
          { accountId: null, debit: null, credit: "48.60000000" },
        ],
      },
    });
    // The payment side is blank, so Jev would not approve this paper as it stands.
    expect(proposal!.evaluation.wouldApprove).toBe(false);
    expect(proposal!.evaluation.holds.map((hold) => hold.reason)).toEqual(
      expect.arrayContaining(["incomplete_entry", "blocking_finding"]),
    );
  });
});
