/**
 * The Bills list query, session-free so tests can prove what the list shows.
 * The listBills server function is a thin wrapper over it.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { bills } from "@/db/schema/bills";
import { parties } from "@/db/schema/parties";

export interface BillListFilters {
  status?: (typeof bills.$inferSelect)["status"];
  vendorId?: string;
  limit: number;
}

/** One organization's bills with the vendor's name, latest due date first. */
export async function listOrganizationBills(
  db: DbExecutor,
  orgId: string,
  filters: BillListFilters,
) {
  const conditions = [eq(bills.organizationId, orgId)];
  if (filters.status) {
    conditions.push(eq(bills.status, filters.status));
  }
  if (filters.vendorId) {
    conditions.push(eq(bills.vendorId, filters.vendorId));
  }

  return db
    .select({
      id: bills.id,
      organizationId: bills.organizationId,
      vendorId: bills.vendorId,
      billNumber: bills.billNumber,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      status: bills.status,
      amount: bills.amount,
      amountPaid: bills.amountPaid,
      balanceDue: bills.balanceDue,
      memo: bills.memo,
      approverId: bills.approverId,
      approvedAt: bills.approvedAt,
      scheduledPaymentDate: bills.scheduledPaymentDate,
      paidAt: bills.paidAt,
      paymentMethod: bills.paymentMethod,
      paymentReference: bills.paymentReference,
      isRecurring: bills.isRecurring,
      recurringFrequency: bills.recurringFrequency,
      categoryConfidence: bills.categoryConfidence,
      classificationStatus: bills.classificationStatus,
      ocrBoundingBoxes: bills.ocrBoundingBoxes,
      journalHeaderId: bills.journalHeaderId,
      documentUrl: bills.documentUrl,
      documentType: bills.documentType,
      createdAt: bills.createdAt,
      updatedAt: bills.updatedAt,
      vendorName: parties.name,
    })
    .from(bills)
    .leftJoin(parties, eq(bills.vendorId, parties.id))
    .where(and(...conditions))
    .orderBy(desc(bills.dueDate))
    .limit(filters.limit);
}
