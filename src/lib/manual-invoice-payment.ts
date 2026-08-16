import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { invoices } from "@/db/schema/invoices";
import { createPaymentJournalEntry } from "@/lib/invoice-journal";
import { centsToMoney, moneyToCents } from "@/lib/money";
import {
  beginAccountingOperation,
  completeAccountingOperation,
  ensureOperationalPaymentLineage,
} from "@/lib/operational-idempotency";

export type ManualInvoicePaymentInput = {
  organizationId: string;
  userId: string;
  invoiceId: string;
  requestedStatus: "paid" | "partial";
  bankAccountId: string;
  paymentAmount?: string | number;
  idempotencyKey: string;
};

/**
 * Record a manual invoice payment under a row lock and a payload-bound
 * operation key. This function must run inside the caller's database
 * transaction so the invoice, journal, lineage, and operation result commit or
 * roll back together.
 */
export async function recordManualInvoicePayment(db: DbExecutor, input: ManualInvoicePaymentInput) {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.organizationId, input.organizationId)))
    .limit(1)
    .for("update");
  if (!invoice) throw new Error("Invoice not found");

  const canonicalPaymentAmount =
    input.paymentAmount == null
      ? null
      : centsToMoney(moneyToCents(input.paymentAmount, "Payment amount"));
  if (
    canonicalPaymentAmount != null &&
    moneyToCents(canonicalPaymentAmount, "Payment amount") <= 0
  ) {
    throw new Error("Payment amount must be greater than zero");
  }

  const operation = await beginAccountingOperation(db, {
    organizationId: input.organizationId,
    operationType: "invoice-status-transition",
    entityType: "invoice",
    entityId: input.invoiceId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      invoiceId: input.invoiceId,
      newStatus: input.requestedStatus,
      bankAccountId: input.bankAccountId,
      paymentAmount: canonicalPaymentAmount,
    },
    actorId: input.userId,
  });
  if (operation.replayed) {
    return {
      ...invoice,
      deduplicated: true as const,
      operationId: operation.operation.id,
      operationJournalHeaderId: operation.operation.journalHeaderId,
    };
  }

  if (!["sent", "viewed", "overdue", "partial"].includes(invoice.status)) {
    throw new Error(`Cannot transition from "${invoice.status}" to "${input.requestedStatus}"`);
  }

  const totalCents = moneyToCents(invoice.total);
  const previousPaidCents = moneyToCents(invoice.amountPaid ?? "0");
  const remainingCents = totalCents - previousPaidCents;
  const paymentCents =
    canonicalPaymentAmount === null
      ? remainingCents
      : moneyToCents(canonicalPaymentAmount, "Payment amount");
  if (paymentCents <= 0) throw new Error("Payment amount must be greater than zero");
  if (paymentCents > remainingCents) {
    throw new Error(
      `Payment amount ${centsToMoney(paymentCents)} exceeds the remaining balance ${centsToMoney(remainingCents)}.`,
    );
  }

  const newPaidCents = previousPaidCents + paymentCents;
  const newBalanceCents = totalCents - newPaidCents;
  const finalStatus = newBalanceCents === 0 ? "paid" : "partial";
  const journalHeaderId = await createPaymentJournalEntry(
    db,
    input.organizationId,
    input.userId,
    {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
    },
    input.bankAccountId,
    paymentCents / 100,
    input.idempotencyKey,
  );
  const effectiveDate = new Date().toISOString().slice(0, 10);
  const paymentSource = await ensureOperationalPaymentLineage(db, {
    organizationId: input.organizationId,
    actorId: input.userId,
    entityType: "invoice",
    entityId: invoice.id,
    documentNumber: invoice.invoiceNumber,
    partyId: invoice.customerId,
    bankAccountId: input.bankAccountId,
    idempotencyKey: input.idempotencyKey,
    requestPayloadHash: operation.payloadHash,
    amount: centsToMoney(paymentCents),
    effectiveDate,
    journalHeaderId,
  });

  const [updated] = await db
    .update(invoices)
    .set({
      status: finalStatus,
      amountPaid: centsToMoney(newPaidCents),
      balanceDue: centsToMoney(newBalanceCents),
      paidAt: finalStatus === "paid" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.organizationId, input.organizationId)))
    .returning();
  if (!updated) throw new Error("Invoice payment could not update the invoice.");

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "invoice",
    entityId: invoice.id,
    action: "updated",
    actorId: input.userId,
    changes: {
      previousStatus: invoice.status,
      newStatus: finalStatus,
      bankAccountId: input.bankAccountId,
      paymentAmount: centsToMoney(paymentCents),
      idempotencyKey: input.idempotencyKey,
    },
  });
  await completeAccountingOperation(db, {
    operationId: operation.operation.id,
    journalHeaderId,
    sourceRecordId: paymentSource.id,
    result: {
      invoiceId: invoice.id,
      previousStatus: invoice.status,
      status: updated.status,
      amountPaid: updated.amountPaid,
      balanceDue: updated.balanceDue,
      invoiceJournalHeaderId: updated.journalHeaderId,
      operationJournalHeaderId: journalHeaderId,
    },
  });

  return {
    ...updated,
    deduplicated: false as const,
    operationId: operation.operation.id,
    operationJournalHeaderId: journalHeaderId,
  };
}
