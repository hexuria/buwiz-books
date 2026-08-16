import { and, asc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { activityLogs } from "@/db/schema/activity-logs";
import { billLineItems, bills } from "@/db/schema/bills";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { centsToMoney, moneyToCents } from "@/lib/money";
import { requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import {
  beginAccountingOperation,
  completeAccountingOperation,
  ensureOperationalPaymentLineage,
} from "@/lib/operational-idempotency";

export type ManualBillPaymentInput = {
  organizationId: string;
  userId: string;
  billId: string;
  requestedStatus: "paid" | "partial";
  bankAccountId: string;
  paymentAmount?: string | number;
  paymentMethod?: string;
  paymentReference?: string;
  idempotencyKey: string;
};

async function resolveApAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "bill", "accounts_payable");
}

async function ensureBillAccrualJournal(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    bill: typeof bills.$inferSelect;
  },
): Promise<string> {
  if (input.bill.journalHeaderId) return input.bill.journalHeaderId;

  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    input.bill.billDate,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot post bill ${input.bill.billNumber || input.bill.id}: its bill date ${input.bill.billDate} falls in a period locked through ${closedThrough}.`,
    );
  }

  const lineItems = await db
    .select()
    .from(billLineItems)
    .where(eq(billLineItems.billId, input.bill.id))
    .orderBy(asc(billLineItems.sortOrder));
  if (lineItems.length === 0) {
    throw new Error("Bill has no line items — cannot create journal entry");
  }
  const totalAmount = lineItems.reduce((sum, line) => sum + Number(line.amount), 0);
  const apAccountId = await resolveApAccount(db, input.organizationId);
  const transactionNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate: input.bill.billDate,
      transactionType: "journal",
      source: "bill",
      memo: `Bill Accrual: ${input.bill.billNumber || input.bill.id}`,
      partyId: input.bill.vendorId,
      totalAmount: totalAmount.toFixed(2),
      status: "posted",
      sourceDocumentId: input.bill.id,
      sourceDocumentType: "bill",
      createdBy: input.userId,
      referenceNumber: input.bill.billNumber,
      idempotencyKey: `bill-accrual:${input.bill.id}`,
    })
    .returning();
  if (!header) throw new Error("Bill accrual journal could not be posted.");

  await db.insert(journalLines).values([
    ...lineItems.map((line, index) => ({
      journalHeaderId: header.id,
      accountId: line.accountId,
      debit: line.amount,
      credit: null as string | null,
      lineDescription: line.description || "Bill line item",
      partyId: input.bill.vendorId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: index,
    })),
    {
      journalHeaderId: header.id,
      accountId: apAccountId,
      debit: null as string | null,
      credit: totalAmount.toFixed(2),
      lineDescription: `A/P: ${input.bill.billNumber || "Bill"}`,
      partyId: input.bill.vendorId,
      departmentId: null as string | null,
      locationId: null as string | null,
      sortOrder: lineItems.length,
    },
  ]);
  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: input.userId,
    changes: {
      source: "bill_accrual",
      billId: input.bill.id,
      billNumber: input.bill.billNumber,
      totalAmount: totalAmount.toFixed(2),
      transactionNumber,
    },
  });
  return header.id;
}

async function createBillPaymentJournal(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    bill: typeof bills.$inferSelect;
    bankAccountId: string;
    paymentAmount: string;
    paymentReference: string | null;
    idempotencyKey: string;
  },
): Promise<string> {
  const [bankAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, input.bankAccountId),
        eq(accounts.organizationId, input.organizationId),
        eq(accounts.accountType, "asset"),
        eq(accounts.isActive, true),
      ),
    )
    .limit(1);
  if (!bankAccount) {
    throw new Error("The selected payment account is unavailable for this organization");
  }

  const apAccountId = await resolveApAccount(db, input.organizationId);
  const transactionNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate: new Date().toISOString().slice(0, 10),
      transactionType: "pay_out",
      source: "payment",
      memo: `Bill Payment: ${input.bill.billNumber || input.bill.id}`,
      partyId: input.bill.vendorId,
      totalAmount: input.paymentAmount,
      status: "posted",
      sourceDocumentId: input.bill.id,
      sourceDocumentType: "bill",
      createdBy: input.userId,
      referenceNumber: input.paymentReference || input.bill.billNumber,
      idempotencyKey: `bill-payment:${input.idempotencyKey}`,
    })
    .returning();
  if (!header) throw new Error("Bill payment journal could not be posted.");

  await db.insert(journalLines).values([
    {
      journalHeaderId: header.id,
      accountId: apAccountId,
      debit: input.paymentAmount,
      credit: null,
      lineDescription: `A/P Settlement: ${input.bill.billNumber || "Bill"}`,
      partyId: input.bill.vendorId,
      sortOrder: 0,
    },
    {
      journalHeaderId: header.id,
      accountId: input.bankAccountId,
      debit: null,
      credit: input.paymentAmount,
      lineDescription: `Payment for bill ${input.bill.billNumber || ""}`.trim(),
      partyId: input.bill.vendorId,
      sortOrder: 1,
    },
  ]);
  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: input.userId,
    changes: {
      source: "bill_payment",
      billId: input.bill.id,
      billNumber: input.bill.billNumber,
      paymentAmount: input.paymentAmount,
      transactionNumber,
    },
  });
  return header.id;
}

/**
 * Record a manual bill payment under the bill row lock and one payload-bound
 * operation key. The caller must provide a transaction-scoped executor.
 */
export async function recordManualBillPayment(db: DbExecutor, input: ManualBillPaymentInput) {
  const [bill] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.organizationId, input.organizationId)))
    .limit(1)
    .for("update");
  if (!bill) throw new Error("Bill not found");

  const canonicalPaymentAmount =
    input.paymentAmount == null
      ? null
      : centsToMoney(moneyToCents(input.paymentAmount, "Payment amount"));
  if (
    canonicalPaymentAmount != null &&
    moneyToCents(canonicalPaymentAmount, "Payment amount") <= 0
  ) {
    throw new Error("Payment amount must be positive");
  }
  const operation = await beginAccountingOperation(db, {
    organizationId: input.organizationId,
    operationType: "bill-status-transition",
    entityType: "bill",
    entityId: input.billId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      billId: input.billId,
      newStatus: input.requestedStatus,
      paymentMethod: input.paymentMethod ?? null,
      paymentReference: input.paymentReference ?? null,
      bankAccountId: input.bankAccountId,
      paymentAmount: canonicalPaymentAmount,
    },
    actorId: input.userId,
  });
  if (operation.replayed) {
    return {
      ...bill,
      deduplicated: true as const,
      operationId: operation.operation.id,
      operationJournalHeaderId: operation.operation.journalHeaderId,
    };
  }

  if (!["in_review", "awaiting_payment", "scheduled", "partial"].includes(bill.status)) {
    throw new Error(`Cannot transition from "${bill.status}" to "${input.requestedStatus}"`);
  }

  const balanceCents = moneyToCents(bill.balanceDue ?? bill.amount);
  const paymentCents =
    canonicalPaymentAmount === null
      ? balanceCents
      : moneyToCents(canonicalPaymentAmount, "Payment amount");
  if (paymentCents <= 0) throw new Error("Payment amount must be positive");
  if (paymentCents > balanceCents) throw new Error("Payment exceeds balance due");

  const previousPaidCents = moneyToCents(bill.amountPaid ?? "0");
  const totalBillCents = moneyToCents(bill.amount);
  const newPaidCents = previousPaidCents + paymentCents;
  const newBalanceCents = totalBillCents - newPaidCents;
  const finalStatus = newBalanceCents <= 0 ? "paid" : "partial";
  const accrualJournalHeaderId = await ensureBillAccrualJournal(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    bill,
  });
  const paymentAmount = centsToMoney(paymentCents);
  const paymentJournalHeaderId = await createBillPaymentJournal(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    bill,
    bankAccountId: input.bankAccountId,
    paymentAmount,
    paymentReference: input.paymentReference ?? null,
    idempotencyKey: input.idempotencyKey,
  });
  const paymentSource = await ensureOperationalPaymentLineage(db, {
    organizationId: input.organizationId,
    actorId: input.userId,
    entityType: "bill",
    entityId: bill.id,
    documentNumber: bill.billNumber,
    paymentReference: input.paymentReference,
    partyId: bill.vendorId,
    bankAccountId: input.bankAccountId,
    idempotencyKey: input.idempotencyKey,
    requestPayloadHash: operation.payloadHash,
    amount: paymentAmount,
    effectiveDate: new Date().toISOString().slice(0, 10),
    journalHeaderId: paymentJournalHeaderId,
  });

  const [updated] = await db
    .update(bills)
    .set({
      status: finalStatus,
      journalHeaderId: accrualJournalHeaderId,
      amountPaid:
        finalStatus === "paid" ? centsToMoney(totalBillCents) : centsToMoney(newPaidCents),
      balanceDue: finalStatus === "paid" ? centsToMoney(0) : centsToMoney(newBalanceCents),
      paidAt: finalStatus === "paid" ? new Date() : null,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference,
      updatedAt: new Date(),
    })
    .where(and(eq(bills.id, bill.id), eq(bills.organizationId, input.organizationId)))
    .returning();
  if (!updated) throw new Error("Bill payment could not update the bill.");

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "bill",
    entityId: bill.id,
    action: "status_changed",
    actorId: input.userId,
    changes: {
      previousStatus: bill.status,
      newStatus: finalStatus,
      bankAccountId: input.bankAccountId,
      paymentAmount,
      idempotencyKey: input.idempotencyKey,
    },
  });
  await completeAccountingOperation(db, {
    operationId: operation.operation.id,
    journalHeaderId: paymentJournalHeaderId,
    sourceRecordId: paymentSource.id,
    result: {
      billId: bill.id,
      previousStatus: bill.status,
      status: updated.status,
      amountPaid: updated.amountPaid,
      balanceDue: updated.balanceDue,
      billJournalHeaderId: updated.journalHeaderId,
      operationJournalHeaderId: paymentJournalHeaderId,
    },
  });

  return {
    ...updated,
    deduplicated: false as const,
    operationId: operation.operation.id,
    operationJournalHeaderId: paymentJournalHeaderId,
  };
}
