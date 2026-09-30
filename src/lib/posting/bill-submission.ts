/**
 * submitBillForReviewCore — the Bills editor's save, with no session.
 *
 * The editor does not post. It writes the bill (createBillCore, review mode)
 * and submits the matching accrual to Inbox review as a "bill" candidate; the
 * journal is posted when that Inbox item is approved, and approval links it
 * back to this bill. Both writes share one transaction, and one request
 * idempotency key binds the bill and its candidate to the same payload.
 *
 * This lives apart from createBillCore because it submits through the Inbox
 * service, which itself calls createBillCore on approval. Keeping the two
 * modules separate keeps that dependency one-way.
 */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { sourceRecords, transactionCandidates, workflowEvents } from "@/db/schema/inbox";
import type { bills } from "@/db/schema/bills";
import { requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import {
  assertIdempotencyPayloadMatches,
  idempotencyPayloadHash,
  scopedIdempotencyUuid,
} from "@/lib/idempotency";
import { sumMoney } from "@/lib/inbox/money";
import { createTransactionCandidate } from "@/lib/inbox/service";
import { requireUserActor, type PostingActor } from "./actor";
import { createBillCore } from "./bill-core";

/** The Bills editor's payload, as its server function validates it. */
export interface BillSubmissionDraft {
  idempotencyKey: string;
  vendorId: string;
  billNumber?: string;
  billDate: string;
  dueDate: string;
  memo?: string;
  documentUrl?: string;
  documentType?: string;
  status?: "draft" | "in_review";
  isRecurring?: boolean;
  recurringFrequency?: string;
  categoryConfidence?: string;
  classificationStatus?: "auto" | "needs_review" | "manual";
  ocrBoundingBoxes?: Array<{
    fieldId: string;
    label: string;
    text?: string;
    bbox: [number, number, number, number];
    page: number;
  }>;
  lineItems: Array<{
    description?: string;
    amount: string;
    accountId: string;
    departmentId?: string;
    locationId?: string;
  }>;
}

export type BillSubmissionResult = typeof bills.$inferSelect &
  ({ deduplicated: true } | { deduplicated: false; inboxItemId: string });

export async function submitBillForReviewCore(
  db: DbExecutor,
  orgId: string,
  actor: PostingActor,
  draft: BillSubmissionDraft,
): Promise<BillSubmissionResult> {
  const userId = requireUserActor(actor, "submitBillForReviewCore");
  // The candidate's A/P credit is the exact sum of the raw line amounts; it
  // must offset the debit lines to the last decimal or the journal would not
  // balance when the item is approved.
  const totalAmount = sumMoney(draft.lineItems.map((line) => line.amount));
  const requestPayloadHash = idempotencyPayloadHash("bill-submission", {
    vendorId: draft.vendorId,
    billNumber: draft.billNumber,
    billDate: draft.billDate,
    dueDate: draft.dueDate,
    memo: draft.memo,
    documentUrl: draft.documentUrl,
    documentType: draft.documentType,
    status: draft.status,
    isRecurring: draft.isRecurring,
    recurringFrequency: draft.recurringFrequency,
    categoryConfidence: draft.categoryConfidence,
    classificationStatus: draft.classificationStatus,
    ocrBoundingBoxes: draft.ocrBoundingBoxes,
    lineItems: draft.lineItems,
  });
  const billId = scopedIdempotencyUuid(`bill:${orgId}`, draft.idempotencyKey);

  return db.transaction(async (tx) => {
    const created = await createBillCore(tx, orgId, actor, {
      vendorId: draft.vendorId,
      billNumber: draft.billNumber,
      billDate: draft.billDate,
      dueDate: draft.dueDate,
      memo: draft.memo,
      documentUrl: draft.documentUrl,
      documentType: draft.documentType,
      isRecurring: draft.isRecurring,
      recurringFrequency: draft.recurringFrequency,
      categoryConfidence: draft.categoryConfidence,
      classificationStatus: draft.classificationStatus,
      ocrBoundingBoxes: draft.ocrBoundingBoxes,
      accrual: {
        kind: "review",
        billId,
        status: draft.status ?? "in_review",
        lineItems: draft.lineItems,
      },
    });

    if (created.deduplicated) {
      const existing = created.bill;
      const [existingRequest] = await tx
        .select({ sourceRawData: sourceRecords.rawData })
        .from(transactionCandidates)
        .leftJoin(sourceRecords, eq(transactionCandidates.sourceRecordId, sourceRecords.id))
        .where(
          and(
            eq(transactionCandidates.organizationId, orgId),
            eq(transactionCandidates.requestIdempotencyKey, draft.idempotencyKey),
          ),
        )
        .limit(1);
      assertIdempotencyPayloadMatches(
        existingRequest?.sourceRawData?.requestPayloadHash,
        requestPayloadHash,
        "bill",
      );
      await tx
        .insert(workflowEvents)
        .values({
          organizationId: orgId,
          entityType: "bill",
          entityId: existing.id,
          action: "exact_replay_suppressed",
          actorType: "user",
          actorId: userId,
          idempotencyKey: `exact-replay:bill:${existing.id}`,
          data: {
            replayType: "request_idempotency",
            sourceChannel: "bills_expenses",
          },
        })
        .onConflictDoNothing();
      return { ...existing, deduplicated: true as const };
    }

    const bill = created.bill;
    const apAccountId = await requireMappedAccountId(tx, orgId, "bill", "accounts_payable");
    const inboxResult = await createTransactionCandidate(
      { orgId, userId, db: tx },
      {
        transactionDate: bill.billDate,
        transactionType: "journal",
        memo: draft.memo || `Bill ${bill.billNumber || bill.id}`,
        referenceNumber: bill.billNumber,
        partyId: bill.vendorId,
        sourceChannel: "bills_expenses",
        sourceProvider: "internal_bills",
        requestIdempotencyKey: draft.idempotencyKey,
        requestPayloadHash,
        externalId: bill.id,
        candidateType: "bill",
        lines: [
          ...draft.lineItems.map((line, index) => ({
            accountId: line.accountId,
            debit: line.amount,
            lineDescription: line.description,
            departmentId: line.departmentId,
            locationId: line.locationId,
            categoryConfidence: draft.categoryConfidence,
            sortOrder: index,
          })),
          {
            accountId: apAccountId,
            credit: totalAmount,
            lineDescription: `A/P: ${bill.billNumber || "Bill"}`,
            partyId: bill.vendorId,
            sortOrder: draft.lineItems.length,
          },
        ],
      },
    );

    return { ...bill, inboxItemId: inboxResult.inboxItem.id, deduplicated: false as const };
  });
}
