// ============================================================================
// "By Jev" on an entry: what Jev approved, on which lane, and whether a person
// can still undo it (Bills and Transactions detail screens).
// ============================================================================

import { and, desc, eq, ne } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { aiAutonomyLanes } from "@/db/schema/ai";
import { user } from "@/db/schema/auth";
import { bills } from "@/db/schema/bills";
import { inboxItems, reviewDecisions, transactionCandidates } from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { moneyToCents } from "@/lib/money";
import { INBOX_V2_KIND_LABELS, type InboxV2Kind } from "../v2/triage";
import { findJevApprovalDecision, JEV_APPROVAL_UNDONE } from "./undo";

export interface JevEntryApproval {
  journalHeaderId: string;
  inboxItemId: string;
  approvedAt: Date;
  laneId: string | null;
  /** "Paper Street Supply · Vendor bill". */
  laneLabel: string | null;
  confidence: number | null;
  billId: string | null;
  undone: {
    undoneAt: Date;
    undoneByName: string | null;
    reason: string | null;
    reversalHeaderId: string | null;
  } | null;
  canUndo: boolean;
  /** Why the Undo button is unavailable, when it is. */
  cannotUndoReason: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Jev's approval of this journal, or null when a person (or nothing) approved it. */
export async function loadJevEntryApproval(
  db: DbExecutor,
  orgId: string,
  journalHeaderId: string,
): Promise<JevEntryApproval | null> {
  const decision = await findJevApprovalDecision(db, orgId, journalHeaderId);
  if (!decision) return null;

  const [activity] = await db
    .select({ changes: activityLogs.changes })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.organizationId, orgId),
        eq(activityLogs.entityType, "transaction"),
        eq(activityLogs.entityId, journalHeaderId),
        eq(activityLogs.action, "approved_from_inbox"),
      ),
    )
    .orderBy(desc(activityLogs.createdAt))
    .limit(1);
  const approval = record(record(activity?.changes)?.jevApproval);
  const laneId = typeof approval?.laneId === "string" ? approval.laneId : null;
  const confidence = typeof approval?.confidence === "number" ? approval.confidence : null;

  const [lane] = laneId
    ? await db
        .select({ docKind: aiAutonomyLanes.docKind, partyName: parties.name })
        .from(aiAutonomyLanes)
        .leftJoin(parties, eq(parties.id, aiAutonomyLanes.partyId))
        .where(and(eq(aiAutonomyLanes.organizationId, orgId), eq(aiAutonomyLanes.id, laneId)))
        .limit(1)
    : [];
  const kindLabel = lane?.docKind
    ? (INBOX_V2_KIND_LABELS[lane.docKind as InboxV2Kind] ?? lane.docKind)
    : null;
  const laneLabel = lane ? [lane.partyName, kindLabel].filter(Boolean).join(" · ") || null : null;

  const [undoneDecision] = await db
    .select({
      createdAt: reviewDecisions.createdAt,
      reason: reviewDecisions.reason,
      name: user.name,
    })
    .from(reviewDecisions)
    .leftJoin(user, eq(user.id, reviewDecisions.actorId))
    .where(
      and(
        eq(reviewDecisions.organizationId, orgId),
        eq(reviewDecisions.journalHeaderId, journalHeaderId),
        eq(reviewDecisions.decision, JEV_APPROVAL_UNDONE),
      ),
    )
    .orderBy(desc(reviewDecisions.createdAt))
    .limit(1);
  const [reversal] = await db
    .select({ id: journalHeaders.id })
    .from(journalHeaders)
    .where(
      and(
        eq(journalHeaders.organizationId, orgId),
        eq(journalHeaders.reversesHeaderId, journalHeaderId),
        ne(journalHeaders.status, "voided"),
      ),
    )
    .limit(1);

  const [state] = await db
    .select({ itemState: inboxItems.state, candidateStatus: transactionCandidates.status })
    .from(inboxItems)
    .leftJoin(transactionCandidates, eq(transactionCandidates.id, inboxItems.candidateId))
    .where(and(eq(inboxItems.organizationId, orgId), eq(inboxItems.id, decision.inboxItemId)))
    .limit(1);
  const [journal] = await db
    .select({ status: journalHeaders.status })
    .from(journalHeaders)
    .where(and(eq(journalHeaders.organizationId, orgId), eq(journalHeaders.id, journalHeaderId)))
    .limit(1);
  const [bill] = await db
    .select({ id: bills.id, status: bills.status, amountPaid: bills.amountPaid })
    .from(bills)
    .where(and(eq(bills.organizationId, orgId), eq(bills.journalHeaderId, journalHeaderId)))
    .limit(1);

  let cannotUndoReason: string | null = null;
  if (undoneDecision || reversal) cannotUndoReason = "Jev's approval was already undone.";
  else if (journal?.status !== "posted") cannotUndoReason = "Only a posted entry can be undone.";
  else if (state?.itemState !== "approved" || state?.candidateStatus !== "posted") {
    cannotUndoReason = "The Inbox item has moved on since Jev approved it.";
  } else if (bill && moneyToCents(bill.amountPaid ?? "0", "amountPaid") !== 0) {
    cannotUndoReason = "Payments are recorded against this bill. Void them first.";
  } else if (bill && !["awaiting_payment", "scheduled"].includes(bill.status)) {
    cannotUndoReason = `This bill is ${bill.status}.`;
  }

  return {
    journalHeaderId,
    inboxItemId: decision.inboxItemId,
    approvedAt: decision.createdAt,
    laneId,
    laneLabel,
    confidence,
    billId: bill?.id ?? null,
    undone: undoneDecision
      ? {
          undoneAt: undoneDecision.createdAt,
          undoneByName: undoneDecision.name ?? null,
          reason: undoneDecision.reason,
          reversalHeaderId: reversal?.id ?? null,
        }
      : null,
    canUndo: cannotUndoReason === null,
    cannotUndoReason,
  };
}
