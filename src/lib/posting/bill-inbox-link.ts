/**
 * A bill saved in the Bills editor and the Inbox item that reviews it.
 *
 * The editor does not post: it writes the bill and submits its accrual to the
 * Inbox (./bill-submission.ts), and approving that item is what books it. The
 * Bills page used to have a second, independent way to book the same bill
 * (its own Approve), which left the Inbox item open and asking for review of
 * an entry that was already posted. One bill now has one booking path:
 *
 *   • while its Inbox item is pending, the Bills page refuses to book or pay
 *     it and points at the Inbox (BILL_IN_INBOX_MESSAGE);
 *   • voiding or deleting the bill in Bills closes that item;
 *   • rejecting the item in the Inbox voids the bill it reviewed.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import {
  inboxItems,
  integrationSources,
  sourceRecords,
  transactionCandidates,
} from "@/db/schema/inbox";

/** States in which an Inbox item still stands between the bill and the ledger. */
const PENDING_REVIEW_STATES = [
  "received",
  "processing",
  "needs_information",
  "ready_for_review",
  "failed",
] as const;

export const BILL_IN_INBOX_MESSAGE =
  "This bill is waiting for review in the Inbox. Approve it there: approving books it.";

export class BillInInboxError extends Error {
  readonly inboxItemId: string;
  constructor(inboxItemId: string) {
    super(BILL_IN_INBOX_MESSAGE);
    this.name = "BillInInboxError";
    this.inboxItemId = inboxItemId;
  }
}

export interface PendingBillReview {
  inboxItemId: string;
  lockVersion: number;
  state: string;
}

/** The Inbox item still reviewing this editor bill, or null when there is none. */
export async function findPendingInboxReviewForBill(
  db: DbExecutor,
  orgId: string,
  billId: string,
): Promise<PendingBillReview | null> {
  const [row] = await db
    .select({
      inboxItemId: inboxItems.id,
      lockVersion: inboxItems.lockVersion,
      state: inboxItems.state,
    })
    .from(inboxItems)
    .innerJoin(transactionCandidates, eq(transactionCandidates.id, inboxItems.candidateId))
    .innerJoin(sourceRecords, eq(sourceRecords.id, inboxItems.sourceRecordId))
    .innerJoin(integrationSources, eq(integrationSources.id, sourceRecords.sourceId))
    .where(
      and(
        eq(inboxItems.organizationId, orgId),
        eq(sourceRecords.externalId, billId),
        eq(integrationSources.provider, "internal_bills"),
        eq(transactionCandidates.candidateType, "bill"),
        eq(transactionCandidates.status, "current"),
        inArray(inboxItems.state, [...PENDING_REVIEW_STATES]),
      ),
    )
    .limit(1);
  return row ?? null;
}
