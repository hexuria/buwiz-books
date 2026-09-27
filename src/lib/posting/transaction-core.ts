/**
 * postTransactionCore — write one posted journal (journal / pay_in / pay_out /
 * transfer) from a balanced draft, with no session.
 *
 * WHERE THIS CAME FROM. The New-transaction editor never posts: its server
 * function submits a candidate to Inbox review (maker-checker), and the
 * journal is written only when that item is approved. The posting itself
 * lived inline in approveInboxItem. It is extracted here unchanged so every
 * poster (Inbox approval today, the bill core for accruals, Jev once its
 * autonomy lane exists) runs the same invariants:
 *
 *   - at least two lines, each on an account, debits = credits exactly
 *   - the transaction date is not in a locked period
 *   - a caller-supplied idempotency key, backed by the unique index on
 *     (organization_id, idempotency_key), so a retry cannot post twice
 *
 * Callers keep their own guards (permissions, maker-checker, duplicate cases,
 * lifecycle locks) and their own audit rows; this function writes only the
 * header and its lines. It needs a transaction-scoped executor: the balance
 * trigger from 0041 is deferred to COMMIT.
 */
import type { DbExecutor } from "@/db";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { requireUserActor, type PostingActor } from "./actor";
import { assertPostableLines, type PostingLineDraft } from "./posting-lines";

type JournalInsert = typeof journalHeaders.$inferInsert;

export interface PostTransactionDraft {
  idempotencyKey: string;
  transactionDate: string;
  transactionType: JournalInsert["transactionType"];
  source: NonNullable<JournalInsert["source"]>;
  memo?: string | null;
  partyId?: string | null;
  referenceNumber?: string | null;
  functionalCurrency: string;
  transactionCurrency?: string | null;
  /** Stamped on the header and on every line. */
  exchangeRateId?: string | null;
  /**
   * The document this journal accounts for. Bill/invoice void and the aging
   * reports find their journals exclusively through this pair.
   */
  sourceDocument?: { id: string; type: string } | null;
  lines: PostingLineDraft[];
}

export interface PostedTransaction {
  journalHeaderId: string;
  transactionNumber: string;
  totalAmount: string;
}

export async function postTransactionCore(
  db: DbExecutor,
  orgId: string,
  actor: PostingActor,
  draft: PostTransactionDraft,
): Promise<PostedTransaction> {
  const createdBy = requireUserActor(actor, "postTransactionCore");
  if (!draft.idempotencyKey.trim()) {
    throw new Error("A posting idempotency key is required.");
  }
  const { totalAmount } = assertPostableLines(draft.lines);
  const period = await isDateInLockedPeriod(orgId, draft.transactionDate, db);
  if (period.locked) {
    throw new Error(`The accounting period is locked through ${period.closedThrough}.`);
  }

  const transactionNumber = await allocateJournalTransactionNumber(orgId, db);
  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber,
      idempotencyKey: draft.idempotencyKey,
      transactionDate: draft.transactionDate,
      transactionType: draft.transactionType,
      source: draft.source,
      memo: draft.memo,
      partyId: draft.partyId,
      referenceNumber: draft.referenceNumber,
      totalAmount,
      functionalCurrency: draft.functionalCurrency,
      transactionCurrency: draft.transactionCurrency,
      exchangeRateId: draft.exchangeRateId,
      status: "posted",
      postedAt: new Date(),
      sourceDocumentId: draft.sourceDocument?.id ?? null,
      sourceDocumentType: draft.sourceDocument?.type ?? null,
      createdBy,
    })
    .returning();
  await db.insert(journalLines).values(
    draft.lines.map((line) => ({
      journalHeaderId: header.id,
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      originalDebit: line.originalDebit,
      originalCredit: line.originalCredit,
      originalCurrency: line.originalCurrency,
      exchangeRate: line.exchangeRate,
      exchangeRateId: draft.exchangeRateId,
      lineDescription: line.lineDescription,
      partyId: line.partyId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: line.sortOrder,
    })),
  );

  return { journalHeaderId: header.id, transactionNumber, totalAmount };
}
