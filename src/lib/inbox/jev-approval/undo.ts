// ============================================================================
// Undo a Jev approval (Inbox v2 spec §8).
//
// A person who disagrees with what Jev posted reverses it — never deletes it:
//
//   1. the journal Jev posted gets an amend-by-reversal (src/lib/journal-
//      amendment.ts), reversal only, no replacement. It is dated like the
//      original when that period is open; when it is closed, on today's date
//      in the org's calendar (or the first open day, if later), because a
//      correction belongs in the period it was found in;
//   2. a bill that approval created is voided — its row, lines and documents
//      stay — once nothing has been paid against it;
//   3. the paper returns to Needs you on a new candidate revision (so its
//      next approval has a fresh idempotency key), and the reversed journal
//      keeps its link to the paper as `reversed_origin`, so the paper can
//      originate its corrected entry;
//   4. the lane gets a `rejected` label for the proposal: an undo is a
//      disagreement, and counts toward demotion like any other;
//   5. a remembered answer Jev approved counts an undo against its memory
//      (build step 10): two in a row turn the memory off.
//
// Everything happens in the caller's transaction, under the candidate's
// lifecycle lock, and is refused whole — with nothing written — when the entry
// cannot be reversed safely (already reversed, matched to a bank statement,
// part of a finalized reconciliation, a bill with payments).
// ============================================================================

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { bills } from "@/db/schema/bills";
import {
  inboxItems,
  ledgerSourceLinks,
  reviewDecisions,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { statementLineMatches, statementLines } from "@/db/schema/reconciliations";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { amendPostedJournal } from "@/lib/journal-amendment";
import { noteReversedMemoryEntries } from "@/lib/inbox/memory/tracking";
import { moneyToCents } from "@/lib/money";
import { currentOrgDate, firstOpenDateAfter } from "@/lib/org-calendar";
import { getClosedThrough, isDateLocked } from "@/lib/period-close";
import { lockInboxCandidateLifecycle } from "../lifecycle-lock";
import type { InboxServiceContext } from "../types";
import { recordJevLaneFeedback } from "./feedback";

export const JEV_APPROVAL_UNDONE = "jev_approval_undone";
/** The relationship a reversed journal keeps to the paper it came from. */
export const REVERSED_ORIGIN_RELATIONSHIP = "reversed_origin";

/** Bill states a Jev approval can leave a bill in, before anything is paid. */
const UNDOABLE_BILL_STATES = new Set(["awaiting_payment", "scheduled"]);

export interface UndoJevApprovalResult {
  inboxItemId: string;
  journalHeaderId: string;
  reversalHeaderId: string;
  amendmentDate: string;
  billId: string | null;
  laneId: string | null;
}

/** The review decision recording that Jev approved this journal, if it did. */
export async function findJevApprovalDecision(
  db: DbExecutor,
  orgId: string,
  journalHeaderId: string,
) {
  const [decision] = await db
    .select()
    .from(reviewDecisions)
    .where(
      and(
        eq(reviewDecisions.organizationId, orgId),
        eq(reviewDecisions.journalHeaderId, journalHeaderId),
        eq(reviewDecisions.decision, "approved"),
        eq(reviewDecisions.actorType, "system"),
        eq(reviewDecisions.actorKey, "jev"),
      ),
    )
    .orderBy(desc(reviewDecisions.createdAt))
    .limit(1);
  return decision ?? null;
}

async function matchedToStatement(db: DbExecutor, orgId: string, journalHeaderId: string) {
  const lines = await db
    .select({ id: journalLines.id })
    .from(journalLines)
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .where(and(eq(journalHeaders.organizationId, orgId), eq(journalHeaders.id, journalHeaderId)));
  const lineIds = lines.map((line) => line.id);
  if (lineIds.length === 0) return false;
  const [direct] = await db
    .select({ id: statementLines.id })
    .from(statementLines)
    .where(inArray(statementLines.matchedJournalLineId, lineIds))
    .limit(1);
  if (direct) return true;
  const [split] = await db
    .select({ id: statementLineMatches.id })
    .from(statementLineMatches)
    .where(
      and(
        eq(statementLineMatches.organizationId, orgId),
        inArray(statementLineMatches.journalLineId, lineIds),
      ),
    )
    .limit(1);
  return Boolean(split);
}

export async function undoJevApproval(
  ctx: InboxServiceContext,
  input: { journalHeaderId: string; reason?: string | null },
): Promise<UndoJevApprovalResult> {
  const { db, orgId, userId } = ctx;
  const note = input.reason?.trim() || null;
  const decision = await findJevApprovalDecision(db, orgId, input.journalHeaderId);
  if (!decision)
    throw new Error("Jev did not approve this entry, so there is no Jev approval to undo.");

  const lifecycle = await lockInboxCandidateLifecycle(db, orgId, decision.inboxItemId);
  if (!lifecycle) throw new Error("The Inbox item for this entry no longer exists.");
  const { item, candidate } = lifecycle;
  if (
    item.state !== "approved" ||
    candidate.status !== "posted" ||
    candidate.postedJournalHeaderId !== input.journalHeaderId
  ) {
    throw new Error("This Jev approval was already undone.");
  }

  const [journal] = await db
    .select()
    .from(journalHeaders)
    .where(
      and(eq(journalHeaders.organizationId, orgId), eq(journalHeaders.id, input.journalHeaderId)),
    )
    .limit(1)
    .for("update");
  if (!journal) throw new Error("Journal not found.");
  if (journal.status !== "posted") {
    throw new Error(`This entry is ${journal.status}; only a posted entry can be undone.`);
  }
  if (await matchedToStatement(db, orgId, journal.id)) {
    throw new Error("Unmatch this entry from its bank statement line before undoing it.");
  }

  const [bill] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.organizationId, orgId), eq(bills.journalHeaderId, journal.id)))
    .limit(1)
    .for("update");
  if (bill) {
    if (moneyToCents(bill.amountPaid ?? "0", "amountPaid") !== 0) {
      throw new Error(
        "Payments are recorded against this bill. Void them before undoing Jev's approval.",
      );
    }
    if (!UNDOABLE_BILL_STATES.has(bill.status)) {
      throw new Error(`This bill is ${bill.status}; it can no longer be undone from here.`);
    }
  }

  // Same date when that period is open; otherwise today, or the first open day.
  const closedThrough = await getClosedThrough(orgId, db);
  let amendmentDate = journal.transactionDate;
  if (isDateLocked(amendmentDate, closedThrough)) {
    const today = await currentOrgDate(db, orgId);
    const firstOpen = firstOpenDateAfter(closedThrough!);
    amendmentDate = today > firstOpen ? today : firstOpen;
  }
  // The memory whose answer Jev approved, if one did, was disagreed with. Named
  // here, while the candidate still points at this journal, so the memory's
  // history says why; the reversal below would count it too, and once is all
  // it counts (src/lib/inbox/memory/tracking.ts).
  await noteReversedMemoryEntries(db, {
    orgId,
    journalHeaderIds: [journal.id],
    reason: JEV_APPROVAL_UNDONE,
    actorId: userId,
  });
  const amended = await amendPostedJournal(db, {
    organizationId: orgId,
    userId,
    headerId: journal.id,
    reason: note ? `Undo Jev approval: ${note}` : "Undo Jev approval",
    amendmentDate,
  });

  const now = new Date();
  if (bill) {
    await db
      .update(bills)
      .set({ status: "voided", updatedAt: now })
      .where(and(eq(bills.organizationId, orgId), eq(bills.id, bill.id)));
    await insertActivityLog(
      {
        orgId,
        entityType: "bill",
        entityId: bill.id,
        action: "voided",
        actorId: userId,
        changes: {
          reason: JEV_APPROVAL_UNDONE,
          previousStatus: bill.status,
          journalHeaderId: journal.id,
          reversalHeaderId: amended.reversalHeaderId,
        },
      },
      db,
    );
  }

  // The paper originates its next entry; the reversed one keeps its evidence.
  await db
    .update(ledgerSourceLinks)
    .set({ relationship: REVERSED_ORIGIN_RELATIONSHIP })
    .where(
      and(
        eq(ledgerSourceLinks.organizationId, orgId),
        eq(ledgerSourceLinks.journalHeaderId, journal.id),
        eq(ledgerSourceLinks.relationship, "origin"),
      ),
    );

  const nextRevision = candidate.revision + 1;
  await db
    .update(transactionCandidates)
    .set({ status: "current", postedJournalHeaderId: null, revision: nextRevision, updatedAt: now })
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, candidate.id),
      ),
    );
  await db
    .update(inboxItems)
    .set({
      state: "ready_for_review",
      candidateRevision: nextRevision,
      lockVersion: item.lockVersion + 1,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: note ? `Jev's approval was undone: ${note}` : "Jev's approval was undone.",
      updatedAt: now,
    })
    .where(and(eq(inboxItems.organizationId, orgId), eq(inboxItems.id, item.id)));

  const laneId =
    (
      await recordJevLaneFeedback(db, {
        orgId,
        candidateId: candidate.id,
        inboxItemId: item.id,
        action: "undo",
        userId,
        note,
      })
    )?.laneId ?? null;

  await db.insert(reviewDecisions).values({
    organizationId: orgId,
    inboxItemId: item.id,
    decision: JEV_APPROVAL_UNDONE,
    actorType: "user",
    actorId: userId,
    candidateRevision: candidate.revision,
    reason: note,
    beforeState: item.state,
    afterState: "ready_for_review",
    journalHeaderId: journal.id,
  });
  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: item.id,
    entityType: "inbox_item",
    entityId: item.id,
    action: JEV_APPROVAL_UNDONE,
    actorType: "user",
    actorId: userId,
    idempotencyKey: `inbox:${item.id}:jev-undone:${candidate.revision}`,
    data: {
      journalHeaderId: journal.id,
      reversalHeaderId: amended.reversalHeaderId,
      amendmentDate,
      billId: bill?.id ?? null,
      laneId,
      reason: note,
    },
  });
  await insertActivityLog(
    {
      orgId,
      entityType: "transaction",
      entityId: journal.id,
      action: JEV_APPROVAL_UNDONE,
      actorId: userId,
      changes: {
        inboxItemId: item.id,
        reversalHeaderId: amended.reversalHeaderId,
        amendmentDate,
        billId: bill?.id ?? null,
        laneId,
        reason: note,
      },
    },
    db,
  );

  return {
    inboxItemId: item.id,
    journalHeaderId: journal.id,
    reversalHeaderId: amended.reversalHeaderId,
    amendmentDate,
    billId: bill?.id ?? null,
    laneId,
  };
}
