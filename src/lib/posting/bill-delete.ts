/**
 * Deleting a bill — the session-free core behind the Bills page's delete.
 *
 * The bill row is locked FOR UPDATE before anything is decided. Inbox approval
 * (lockAccruableEditorBill / lockCandidateBill) and the Bills page's own status
 * transitions lock the same row before they post an accrual, so the two now
 * serialize:
 *   • approval first — delete waits, then re-reads the committed bill and its
 *     posted journals, sees the accrual, and voids it with the bill (or refuses,
 *     under the usual period and reconciliation locks);
 *   • delete first — approval's lock finds no row and refuses with the
 *     "deleted in Bills" message.
 * Before this, delete read the bill without a lock, scanned journals, and then
 * deleted: an approval committing between the scan and the DELETE left a posted
 * accrual with no bill to pay or void (journal_headers.source_document_id is not
 * a foreign key).
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { bills } from "@/db/schema/bills";
import { documentAttachments } from "@/db/schema/documents";
import { journalHeaders } from "@/db/schema/journals";
import { noteReversedMemoryEntries } from "@/lib/inbox/memory/tracking";
import { getClosedThrough, isDateLocked } from "@/lib/period-close";
import { journalsClearedByFinalizedReconciliation } from "@/lib/reconciliation-claimed-lines";

export async function deleteBillCore(
  db: DbExecutor,
  orgId: string,
  userId: string,
  billId: string,
): Promise<{ success: true; voidedJournalIds: string[] }> {
  const [existing] = await db
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
    .limit(1)
    .for("update");

  if (!existing) {
    throw new Error("Bill not found");
  }

  // Read after the lock: an accrual an approval committed while we waited is here.
  const linkedJournals = await db
    .select()
    .from(journalHeaders)
    .where(
      and(
        eq(journalHeaders.sourceDocumentId, billId),
        eq(journalHeaders.sourceDocumentType, "bill"),
        eq(journalHeaders.organizationId, orgId),
        eq(journalHeaders.status, "posted"),
      ),
    )
    .orderBy(asc(journalHeaders.id))
    .for("update");

  if (linkedJournals.length > 0) {
    if (linkedJournals.some((journal) => journal.duplicateOfHeaderId !== null)) {
      throw new Error(
        "Cannot delete bill: a linked journal is a suppressed duplicate. Unmatch it first.",
      );
    }

    // Voiding these journals changes the books — refuse when any falls in a
    // closed period or is cleared by a finalized reconciliation.
    const closedThrough = await getClosedThrough(orgId, db);
    const inLocked = linkedJournals.find((j) => isDateLocked(j.transactionDate, closedThrough));
    if (inLocked) {
      throw new Error(
        `Cannot delete bill: its journal dated ${inLocked.transactionDate} falls in a period locked through ${closedThrough}. Open the period first.`,
      );
    }

    // Shared with bill void and invoice void: it also sees journals cleared by
    // SPLIT statement matches, not only the 1:1 matched-line column.
    if (
      await journalsClearedByFinalizedReconciliation(
        db,
        orgId,
        linkedJournals.map((journal) => journal.id),
      )
    ) {
      throw new Error("Cannot delete bill: its journal is locked by a finalized reconciliation.");
    }
  }

  for (const journal of linkedJournals) {
    await db
      .update(journalHeaders)
      .set({ status: "voided", voidedAt: new Date(), updatedAt: new Date() })
      .where(eq(journalHeaders.id, journal.id));

    await db.insert(activityLogs).values({
      organizationId: orgId,
      entityType: "transaction",
      entityId: journal.id,
      action: "voided",
      actorId: userId,
      changes: { reason: "bill_deleted", billId },
    });
  }
  // A remembered answer whose posted entry this voids counts as an undo of that memory.
  await noteReversedMemoryEntries(db, {
    orgId,
    journalHeaderIds: linkedJournals.map((journal) => journal.id),
    reason: "bill_deleted",
    actorId: userId,
  });

  await db
    .delete(documentAttachments)
    .where(
      and(
        eq(documentAttachments.linkableId, billId),
        eq(documentAttachments.linkableType, "bill"),
        eq(documentAttachments.organizationId, orgId),
      ),
    );

  await db.delete(bills).where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)));

  return { success: true, voidedJournalIds: linkedJournals.map((j) => j.id) };
}
