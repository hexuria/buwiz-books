/**
 * createBillCore — the one place a vendor bill row is written, with no session.
 *
 * Two callers, two accrual modes:
 *
 *   review  The Bills editor (via submitBillForReviewCore). The bill is saved
 *           as draft / in_review and its accrual waits for Inbox approval,
 *           which posts the journal and links it to this bill.
 *   post    An approved paper (Inbox approval of an emailed or uploaded vendor
 *           bill). The accrual journal is posted now, through
 *           postTransactionCore, and the bill is written already linked to it
 *           in the state approval leaves a bill in: awaiting_payment.
 *
 * Both modes run the Bills editor's validation (org-owned vendor, active
 * expense-type line accounts), so the Inbox cannot save a bill a person could
 * not have saved in the editor. The post mode also enforces the bill shape
 * (one A/P credit, debit lines only) and the cent policy: bills store two
 * decimals, so a sub-cent amount is refused rather than rounded.
 *
 * A review-mode bill is accrued later, when its Inbox item is approved, by
 * accrueReviewedBillCore (below), under the same shape and cent rules.
 *
 * The caller owns the transaction: review mode runs inside the editor's
 * submission transaction, post mode inside Inbox approval's.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { billLineItems, bills } from "@/db/schema/bills";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  assertBillFinanciallyEditable,
  assertBillReferences,
  deriveBillBalanceDue,
} from "@/lib/bill-mutation-guards";
import { mappedAccountFamilyIds, requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import { scopedIdempotencyUuid } from "@/lib/idempotency";
import { sumMoney } from "@/lib/inbox/money";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { moneyToCents } from "@/lib/money";
import { requireUserActor, type PostingActor } from "./actor";
import { billLinesFromAccrual, type BillLineDraft } from "./posting-lines";
import {
  postTransactionCore,
  type PostTransactionDraft,
  type PostedTransaction,
} from "./transaction-core";

type BillRow = typeof bills.$inferSelect;
type BillInsert = typeof bills.$inferInsert;

export type BillAccrual =
  | {
      kind: "review";
      /** Derived by the caller from its request idempotency key. */
      billId: string;
      status: "draft" | "in_review";
      lineItems: BillLineDraft[];
    }
  | {
      kind: "post";
      /**
       * The accrual journal. Its date, party and source document come from the
       * bill itself, so the two can never disagree; the bill's line items are
       * derived from its debit lines.
       */
      journal: Omit<PostTransactionDraft, "transactionDate" | "partyId" | "sourceDocument">;
    };

export interface BillDraft {
  vendorId: string;
  billNumber?: string | null;
  billDate: string;
  dueDate: string;
  memo?: string | null;
  documentUrl?: string | null;
  documentType?: string | null;
  isRecurring?: boolean;
  recurringFrequency?: string | null;
  categoryConfidence?: string | null;
  classificationStatus?: "auto" | "needs_review" | "manual";
  ocrBoundingBoxes?: BillInsert["ocrBoundingBoxes"];
  /**
   * Organization documents to attach to the bill. When no documentUrl is given
   * the first one becomes the bill's viewer document, as linkDocumentToBill does.
   */
  documentIds?: string[];
  /** Extra context for the bill's "created" activity row. */
  activityContext?: Record<string, unknown>;
  accrual: BillAccrual;
}

export interface CreateBillCoreResult {
  bill: BillRow;
  /** True when the review-mode bill id already existed (an exact replay). */
  deduplicated: boolean;
  /** The accrual journal posted by post mode; null in review mode. */
  posted: PostedTransaction | null;
}

export async function createBillCore(
  db: DbExecutor,
  orgId: string,
  actor: PostingActor,
  draft: BillDraft,
): Promise<CreateBillCoreResult> {
  const userId = requireUserActor(actor, "createBillCore");
  return draft.accrual.kind === "review"
    ? createBillForReview(db, orgId, userId, draft, draft.accrual)
    : createPostedBill(db, orgId, actor, userId, draft, draft.accrual);
}

async function createBillForReview(
  db: DbExecutor,
  orgId: string,
  userId: string,
  draft: BillDraft,
  accrual: Extract<BillAccrual, { kind: "review" }>,
): Promise<CreateBillCoreResult> {
  const { billId, status, lineItems } = accrual;
  // Org-ownership and account-type checks BEFORE anything persists.
  await assertBillReferences(db, orgId, draft.vendorId, lineItems);
  // Exact summation: a float sum could not equal the raw line amounts the
  // A/P credit offsets, which the ledger rejects as unbalanced (0041).
  const totalAmount = sumMoney(lineItems.map((line) => line.amount));
  const billDocuments = await resolveBillDocuments(db, orgId, draft);

  const [bill] = await db
    .insert(bills)
    .values({
      ...billColumns(orgId, draft),
      ...billDocuments.viewer,
      id: billId,
      amount: totalAmount,
      balanceDue: totalAmount,
      status,
    })
    .onConflictDoNothing()
    .returning();
  if (!bill) {
    const [existing] = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
      .limit(1);
    if (!existing) {
      throw new Error("Unable to persist bill submission");
    }
    return { bill: existing, deduplicated: true, posted: null };
  }

  if (lineItems.length > 0) {
    await insertBillLines(db, bill.id, lineItems);
  }
  await insertActivityLog(
    {
      orgId,
      entityType: "bill",
      entityId: bill.id,
      action: "created",
      actorId: userId,
      changes: {
        vendorId: draft.vendorId,
        billNumber: draft.billNumber ?? null,
        billDate: draft.billDate,
        dueDate: draft.dueDate,
        totalAmount,
        status,
        lineItemCount: lineItems.length,
        ...draft.activityContext,
      },
    },
    db,
  );
  await attachBillDocuments(db, orgId, bill.id, billDocuments.attached);
  return { bill, deduplicated: false, posted: null };
}

async function createPostedBill(
  db: DbExecutor,
  orgId: string,
  actor: PostingActor,
  userId: string,
  draft: BillDraft,
  accrual: Extract<BillAccrual, { kind: "post" }>,
): Promise<CreateBillCoreResult> {
  const { journal } = accrual;
  // Deterministic from the posting key: the same approval can only ever name
  // one bill, and the journal's unique idempotency key already stops a second
  // accrual before this id could be reused.
  const billId = scopedIdempotencyUuid(`bill:${orgId}`, `accrual:${journal.idempotencyKey}`);
  const apAccountId = await requireMappedAccountId(db, orgId, "bill", "accounts_payable");
  const { lineItems, total } = billLinesFromAccrual(journal.lines, apAccountId);
  await assertBillReferences(db, orgId, draft.vendorId, lineItems);

  const posted = await postTransactionCore(db, orgId, actor, {
    ...journal,
    transactionDate: draft.billDate,
    partyId: draft.vendorId,
    sourceDocument: { id: billId, type: "bill" },
  });

  const billDocuments = await resolveBillDocuments(db, orgId, draft);
  const approvedAt = new Date();
  const [bill] = await db
    .insert(bills)
    .values({
      ...billColumns(orgId, draft),
      ...billDocuments.viewer,
      id: billId,
      amount: total,
      balanceDue: total,
      status: "awaiting_payment",
      approverId: userId,
      approvedAt,
      journalHeaderId: posted.journalHeaderId,
    })
    .returning();

  await insertBillLines(db, bill.id, lineItems);
  await attachBillDocuments(db, orgId, bill.id, billDocuments.attached);
  await insertActivityLog(
    {
      orgId,
      entityType: "bill",
      entityId: bill.id,
      action: "created",
      actorId: userId,
      changes: {
        vendorId: draft.vendorId,
        billNumber: draft.billNumber ?? null,
        billDate: draft.billDate,
        dueDate: draft.dueDate,
        totalAmount: total,
        status: bill.status,
        lineItemCount: lineItems.length,
        journalHeaderId: posted.journalHeaderId,
        transactionNumber: posted.transactionNumber,
        ...draft.activityContext,
      },
    },
    db,
  );
  return { bill, deduplicated: false, posted };
}

// ---------------------------------------------------------------------------
// Accruing a Bills-editor bill from its Inbox item
// ---------------------------------------------------------------------------

export const BILL_ALREADY_ACCRUED_MESSAGE =
  "This bill was already approved in Bills, so its accrual is posted. Reject this Inbox item instead of approving it again.";

export const BILL_VOIDED_MESSAGE =
  "This bill was voided in Bills. Reject this Inbox item instead of approving it.";

export const BILL_DELETED_MESSAGE =
  "This bill was deleted in Bills. Reject this Inbox item instead of approving it.";

export const BILL_PAID_MESSAGE =
  "This bill has payments recorded in Bills, so its amounts cannot change here. Reject this Inbox item instead of approving it.";

const BILL_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lock the Bills-editor bill an Inbox item was submitted for, and refuse one that can no longer
 * be accrued from the Inbox. The one set of refusals for that path, used by approval (to fail
 * before anything else runs) and by accrueReviewedBillCore.
 *
 * A Bills-editor bill can be approved, scheduled, paid, voided or deleted on the Bills page while
 * its Inbox item is still pending. Accruing it here afterwards would double the payable and
 * repoint the bill's journal_header_id, revive a voided bill, recreate a deleted one, or change
 * the amounts of a bill with payments against it. All are refused with nothing written; the item
 * stays open for a person to reject. The Bills page takes the same row lock before it posts an
 * accrual, so the two paths serialize instead of both accruing.
 */
export async function lockAccruableEditorBill(
  db: DbExecutor,
  orgId: string,
  billId: string,
): Promise<BillRow> {
  const [bill] = BILL_ID_SHAPE.test(billId)
    ? await db
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
        .limit(1)
        .for("update")
    : [];
  if (!bill) throw new Error(BILL_DELETED_MESSAGE);
  if (bill.journalHeaderId !== null) throw new Error(BILL_ALREADY_ACCRUED_MESSAGE);
  if (bill.status === "voided") throw new Error(BILL_VOIDED_MESSAGE);
  if (moneyToCents(bill.amountPaid ?? "0", "amountPaid") !== 0) throw new Error(BILL_PAID_MESSAGE);
  // The Bills editor's own financial-edit guard, so the two paths can never disagree.
  assertBillFinanciallyEditable(bill);
  return bill;
}

/**
 * Accrue a bill the Bills editor saved for review, now that its Inbox item is approved.
 *
 * The editor saved the bill (review mode) and submitted its accrual to the Inbox. A reviewer may
 * then have corrected that entry — amounts, lines, vendor, date — before approving, so the bill is
 * brought in line with what actually posts, in the approval's transaction: amount, balance due,
 * line items, vendor, bill date and number. Without that the ledger carried the corrected accrual
 * while Bills kept the original figures.
 *
 * Refused, with nothing written, by lockAccruableEditorBill (deleted, already accrued, voided,
 * paid) and, like post mode, when the entry is not a bill (one A/P credit, expense debits) or
 * carries a sub-cent amount the two-decimal bills table would round.
 */
export async function accrueReviewedBillCore(
  db: DbExecutor,
  orgId: string,
  actor: PostingActor,
  input: {
    billId: string;
    /** The approved entry's party: the bill's vendor from here on. */
    vendorId: string;
    /** The approved entry. Its party and source document come from the bill. */
    journal: Omit<PostTransactionDraft, "partyId" | "sourceDocument">;
    /** Extra context for the bill's "accrued" activity row. */
    activityContext?: Record<string, unknown>;
  },
): Promise<{ bill: BillRow; posted: PostedTransaction }> {
  const userId = requireUserActor(actor, "accrueReviewedBillCore");
  const bill = await lockAccruableEditorBill(db, orgId, input.billId);

  const apAccountId = await requireMappedAccountId(db, orgId, "bill", "accounts_payable");
  const { lineItems, total } = billLinesFromAccrual(input.journal.lines, apAccountId);
  await assertBillReferences(db, orgId, input.vendorId, lineItems);

  const posted = await postTransactionCore(db, orgId, actor, {
    ...input.journal,
    partyId: input.vendorId,
    sourceDocument: { id: bill.id, type: "bill" },
  });

  const approvedAt = new Date();
  const [accrued] = await db
    .update(bills)
    .set({
      vendorId: input.vendorId,
      billNumber: input.journal.referenceNumber ?? null,
      billDate: input.journal.transactionDate,
      amount: total,
      balanceDue: deriveBillBalanceDue(total, bill.amountPaid),
      status: "awaiting_payment",
      journalHeaderId: posted.journalHeaderId,
      approverId: userId,
      approvedAt,
      updatedAt: approvedAt,
    })
    .where(and(eq(bills.id, bill.id), eq(bills.organizationId, orgId)))
    .returning();
  await db.delete(billLineItems).where(eq(billLineItems.billId, bill.id));
  await insertBillLines(db, bill.id, lineItems);

  await insertActivityLog(
    {
      orgId,
      entityType: "bill",
      entityId: bill.id,
      action: "accrued",
      actorId: userId,
      changes: {
        journalHeaderId: posted.journalHeaderId,
        transactionNumber: posted.transactionNumber,
        status: accrued.status,
        before: {
          vendorId: bill.vendorId,
          billNumber: bill.billNumber,
          billDate: bill.billDate,
          amount: bill.amount,
        },
        after: {
          vendorId: accrued.vendorId,
          billNumber: accrued.billNumber,
          billDate: accrued.billDate,
          amount: accrued.amount,
        },
        lineItemCount: lineItems.length,
        ...input.activityContext,
      },
    },
    db,
  );
  return { bill: accrued, posted };
}

/**
 * Whether an entry touches Accounts Payable, by the A/P aging report's own
 * definition: the mapped A/P account, anything under it, or any account with
 * the accounts_payable subtype. A vendor bill that never touches payables was
 * paid on the spot and has no balance for a bill to track; one that does must
 * become a bill, or its payable would be missing from Bills and from aging.
 */
export async function touchesAccountsPayable(
  db: DbExecutor,
  orgId: string,
  accountIds: string[],
): Promise<boolean> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return false;
  const payablesFamily = await mappedAccountFamilyIds(db, orgId, "bill", "accounts_payable");
  if (ids.some((id) => payablesFamily.includes(id))) return true;
  const [payable] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, orgId),
        inArray(accounts.id, ids),
        eq(accounts.subtype, "accounts_payable"),
      ),
    )
    .limit(1);
  return Boolean(payable);
}

/** The header columns both modes write the same way. */
function billColumns(orgId: string, draft: BillDraft) {
  return {
    organizationId: orgId,
    vendorId: draft.vendorId,
    billNumber: draft.billNumber,
    billDate: draft.billDate,
    dueDate: draft.dueDate,
    memo: draft.memo,
    documentUrl: draft.documentUrl,
    documentType: draft.documentType,
    isRecurring: draft.isRecurring ?? false,
    recurringFrequency: draft.recurringFrequency,
    categoryConfidence: draft.categoryConfidence,
    classificationStatus: draft.classificationStatus ?? "manual",
    ocrBoundingBoxes: draft.ocrBoundingBoxes ?? null,
  };
}

async function insertBillLines(db: DbExecutor, billId: string, lineItems: BillLineDraft[]) {
  await db.insert(billLineItems).values(
    lineItems.map((line, index) => ({
      billId,
      description: line.description,
      amount: line.amount,
      accountId: line.accountId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: index,
    })),
  );
}

/**
 * The draft's documents that belong to this organization, in the order given,
 * plus the bill's viewer document. An explicit documentUrl wins; otherwise the
 * first document is used, derived the way linkDocumentToBill derives it.
 */
async function resolveBillDocuments(db: DbExecutor, orgId: string, draft: BillDraft) {
  const ids = [...new Set(draft.documentIds ?? [])];
  const rows =
    ids.length > 0
      ? await db
          .select({
            id: documents.id,
            storagePath: documents.storagePath,
            originalFilename: documents.originalFilename,
          })
          .from(documents)
          .where(and(eq(documents.organizationId, orgId), inArray(documents.id, ids)))
      : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const attached = ids.flatMap((id) => byId.get(id) ?? []);
  const [first] = attached;
  if (draft.documentUrl || !first) return { attached, viewer: {} };
  const extension = first.originalFilename.split(".").pop()?.toLowerCase();
  return {
    attached,
    viewer: {
      documentUrl: first.storagePath,
      documentType: extension === "pdf" ? "pdf" : "image",
    },
  };
}

async function attachBillDocuments(
  db: DbExecutor,
  orgId: string,
  billId: string,
  attached: ReadonlyArray<{ id: string }>,
) {
  if (attached.length === 0) return;
  await db.insert(documentAttachments).values(
    attached.map((document) => ({
      organizationId: orgId,
      documentId: document.id,
      linkableType: "bill",
      linkableId: billId,
    })),
  );
}
