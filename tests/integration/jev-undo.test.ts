/**
 * Undoing a Jev approval (Inbox v2 spec §8): reversal only, never a delete.
 *
 * The journal Jev posted gets an amend-by-reversal (dated in an open period),
 * a bill it created is voided, the paper returns to Needs you on a new
 * revision so it can be approved again, and the lane gets a `rejected` label
 * that counts toward demotion.
 */
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { aiAutonomyLanes, aiRunFeedback } from "@/db/schema/ai";
import { organization } from "@/db/schema/auth";
import { bills } from "@/db/schema/bills";
import {
  inboxItems,
  ledgerSourceLinks,
  reviewDecisions,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { currentOrgDate } from "@/lib/org-calendar";
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import { loadJevEntryApproval } from "@/lib/inbox/jev-approval/entry";
import { undoJevApproval } from "@/lib/inbox/jev-approval/undo";
import { approveInboxItem } from "@/lib/inbox/service";
import { mintJevApprovalGrant } from "@/lib/posting/system-approval-grant";
import {
  asOrg,
  seedLaneLabels,
  setJevApprovalSettings,
  setLaneAuto,
  setupJevOrganization,
  submitJevBill,
  submitJevExpense,
  type JevFixture,
} from "../utils/jev-fixture";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type Submitted = Awaited<ReturnType<typeof submitJevExpense>>;

/** Approve a submitted paper as Jev, through the system approval path. */
async function jevApprove(fixture: JevFixture, paper: Submitted) {
  const grant = mintJevApprovalGrant({
    laneId: paper.proposal!.laneId,
    candidateId: paper.candidate.id,
    candidateRevision: paper.candidate.revision,
    confidence: 0.97,
  });
  const result = await asOrg(fixture, (tx) =>
    approveInboxItem(
      { db: tx, orgId: fixture.orgId, userId: JEV_AUDIT_ACTOR_ID, role: "system" },
      {
        inboxItemId: paper.item.id,
        expectedRevision: paper.candidate.revision,
        expectedLockVersion: paper.item.lockVersion,
      },
      {
        systemApproval: {
          grant,
          laneId: paper.proposal!.laneId,
          confidence: 0.97,
          ruleSnapshotId: null,
          makerCheckerOptIn: false,
        },
      },
    ),
  );
  if (result.approvalOutcome !== "approved") throw new Error("expected a Jev approval");
  return result;
}

function undo(fixture: JevFixture, journalHeaderId: string, reason = "Wrong category") {
  return asOrg(
    fixture,
    (tx) =>
      undoJevApproval(
        { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
        { journalHeaderId, reason },
      ),
    fixture.reviewerId,
  );
}

async function balanceOf(accountId: string) {
  const [row] = await db
    .select({
      net: drizzleSql<string>`coalesce(sum(coalesce(${journalLines.debit}, 0) - coalesce(${journalLines.credit}, 0)), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .where(and(eq(journalLines.accountId, accountId), eq(journalHeaders.status, "posted")));
  return Number(row.net);
}

describeDb("undo a Jev approval", () => {
  it("posts a reversal, keeps the original, and returns the paper to Needs you", async () => {
    const fixture = await setupJevOrganization("jev-undo-expense");
    await setJevApprovalSettings(fixture.orgId, { inboxAutoapproveEnabled: true });
    const paper = await submitJevExpense(fixture, { amount: "42.10", day: 3 });
    const approved = await jevApprove(fixture, paper);
    expect(await balanceOf(fixture.officeSupplies.id)).toBeCloseTo(42.1, 8);

    const result = await undo(fixture, approved.journalHeaderId);
    expect(result).toMatchObject({
      inboxItemId: paper.item.id,
      journalHeaderId: approved.journalHeaderId,
      amendmentDate: "2026-08-03",
      billId: null,
      laneId: paper.proposal!.laneId,
    });

    const [original] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, approved.journalHeaderId));
    const [reversal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.reversalHeaderId));
    expect(original.status).toBe("posted");
    expect(reversal).toMatchObject({
      status: "posted",
      reversesHeaderId: original.id,
      transactionDate: "2026-08-03",
      createdBy: fixture.reviewerId,
    });
    expect(await balanceOf(fixture.officeSupplies.id)).toBe(0);

    const [candidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, paper.candidate.id));
    expect(candidate).toMatchObject({
      status: "current",
      postedJournalHeaderId: null,
      revision: paper.candidate.revision + 1,
    });
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, paper.item.id));
    expect(item).toMatchObject({
      state: "ready_for_review",
      candidateRevision: paper.candidate.revision + 1,
      resolvedBy: null,
      resolvedAt: null,
    });
    const links = await db
      .select({ relationship: ledgerSourceLinks.relationship })
      .from(ledgerSourceLinks)
      .where(eq(ledgerSourceLinks.journalHeaderId, original.id));
    expect(links).toEqual([{ relationship: "reversed_origin" }]);

    const decisions = await db
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.inboxItemId, paper.item.id))
      .orderBy(reviewDecisions.createdAt);
    expect(decisions.map((row) => [row.decision, row.actorType])).toEqual([
      ["approved", "system"],
      ["jev_approval_undone", "user"],
    ]);
    const [label] = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.organizationId, fixture.orgId));
    expect(label).toMatchObject({
      laneId: paper.proposal!.laneId,
      verdict: "rejected",
      userId: fixture.reviewerId,
      correction: { action: "undo", note: "Wrong category" },
      laneEvidence: { action: "undo", autoApproved: true },
    });
    const [event] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.inboxItemId, paper.item.id),
          eq(workflowEvents.action, "jev_approval_undone"),
        ),
      );
    expect(event.data).toMatchObject({ reversalHeaderId: reversal.id, reason: "Wrong category" });

    // A person can now approve the paper; it originates a fresh entry.
    const again = await asOrg(
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
    if (again.approvalOutcome !== "approved") throw new Error("expected an approval");
    expect(again.journalHeaderId).not.toBe(original.id);
    expect(await balanceOf(fixture.officeSupplies.id)).toBeCloseTo(42.1, 8);
    // The undo already labeled this proposal; the person's approval adds nothing.
    expect(
      await db.select().from(aiRunFeedback).where(eq(aiRunFeedback.organizationId, fixture.orgId)),
    ).toHaveLength(1);

    await expect(undo(fixture, again.journalHeaderId)).rejects.toThrow(/Jev did not approve/);
    await expect(undo(fixture, original.id)).rejects.toThrow(/already undone/);
  });

  it("voids the bill Jev created and nets its payable out", async () => {
    const fixture = await setupJevOrganization("jev-undo-bill");
    const paper = await submitJevBill(fixture, { amount: "64.20", day: 5 });
    const approved = await jevApprove(fixture, paper);
    expect(await balanceOf(fixture.payables.id)).toBeCloseTo(-64.2, 8);

    const result = await undo(fixture, approved.journalHeaderId, "Not our invoice");
    expect(result.billId).toBe(approved.billId);
    const [bill] = await db.select().from(bills).where(eq(bills.id, approved.billId!));
    expect(bill).toMatchObject({ status: "voided", amount: "64.20" });
    expect(await balanceOf(fixture.payables.id)).toBe(0);
    expect(await balanceOf(fixture.officeSupplies.id)).toBe(0);
  });

  it("refuses a bill with payments against it, writing nothing", async () => {
    const fixture = await setupJevOrganization("jev-undo-paid");
    const paper = await submitJevBill(fixture, { amount: "30.00", day: 6 });
    const approved = await jevApprove(fixture, paper);
    await db
      .update(bills)
      .set({ amountPaid: "10.00", balanceDue: "20.00", status: "partial" })
      .where(eq(bills.id, approved.billId!));
    await expect(undo(fixture, approved.journalHeaderId)).rejects.toThrow(/Payments are recorded/);
    expect(
      await db
        .select()
        .from(journalHeaders)
        .where(eq(journalHeaders.reversesHeaderId, approved.journalHeaderId)),
    ).toEqual([]);
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, paper.item.id));
    expect(item.state).toBe("approved");
  });

  it("dates the reversal in the open period when the original's period is closed", async () => {
    const fixture = await setupJevOrganization("jev-undo-closed");
    const paper = await submitJevExpense(fixture, { amount: "25.00", day: 7 });
    const approved = await jevApprove(fixture, paper);
    await db
      .update(organization)
      .set({ closedThrough: "2026-08-31" })
      .where(eq(organization.id, fixture.orgId));

    const result = await undo(fixture, approved.journalHeaderId);
    const today = await currentOrgDate(db, fixture.orgId);
    const expected = today > "2026-09-01" ? today : "2026-09-01";
    expect(result.amendmentDate).toBe(expected);
    const [reversal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.reversalHeaderId));
    expect(reversal.transactionDate).toBe(expected);
    // The original stays where it was filed.
    const [original] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, approved.journalHeaderId));
    expect(original).toMatchObject({ status: "posted", transactionDate: "2026-08-07" });
  });

  it("counts an undo toward the lane's demotion", async () => {
    const fixture = await setupJevOrganization("jev-undo-demote");
    const paper = await submitJevExpense(fixture, { amount: "19.00", day: 8 });
    const laneId = paper.proposal!.laneId;
    await seedLaneLabels(fixture.orgId, laneId, { accepted: 47, other: 2 });
    await setLaneAuto(laneId);
    const approved = await jevApprove(fixture, paper);

    await undo(fixture, approved.journalHeaderId);
    const [lane] = await db.select().from(aiAutonomyLanes).where(eq(aiAutonomyLanes.id, laneId));
    expect(lane.level).toBe("suggest");
    expect(lane.demotedAt).toBeInstanceOf(Date);
  });

  it("describes the approval on the entry, and what the undo left", async () => {
    const fixture = await setupJevOrganization("jev-undo-entry");
    const paper = await submitJevBill(fixture, { amount: "20.00", day: 9 });
    const approved = await jevApprove(fixture, paper);
    const before = await asOrg(fixture, (tx) =>
      loadJevEntryApproval(tx, fixture.orgId, approved.journalHeaderId),
    );
    expect(before).toMatchObject({
      inboxItemId: paper.item.id,
      laneId: paper.proposal!.laneId,
      laneLabel: "Paper Street Supply · Vendor bill",
      confidence: 0.97,
      billId: approved.billId,
      undone: null,
      canUndo: true,
      cannotUndoReason: null,
    });

    await undo(fixture, approved.journalHeaderId, "Duplicate of last week's");
    const after = await asOrg(fixture, (tx) =>
      loadJevEntryApproval(tx, fixture.orgId, approved.journalHeaderId),
    );
    expect(after).toMatchObject({
      canUndo: false,
      cannotUndoReason: "Jev's approval was already undone.",
      undone: { undoneByName: "Jev Lane Reviewer", reason: "Duplicate of last week's" },
    });
    expect(after!.undone!.reversalHeaderId).toBeTruthy();

    // A person's own approval is not Jev's: nothing to show.
    const typed = await submitJevExpense(fixture, { amount: "5.00", day: 10, typed: true });
    const byPerson = await asOrg(
      fixture,
      (tx) =>
        approveInboxItem(
          { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
          {
            inboxItemId: typed.item.id,
            expectedRevision: typed.candidate.revision,
            expectedLockVersion: typed.item.lockVersion,
          },
        ),
      fixture.reviewerId,
    );
    if (byPerson.approvalOutcome !== "approved") throw new Error("expected an approval");
    expect(
      await asOrg(fixture, (tx) =>
        loadJevEntryApproval(tx, fixture.orgId, byPerson.journalHeaderId),
      ),
    ).toBeNull();
  });
});
