import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { activityLogs } from "@/db/schema/activity-logs";
import { bills } from "@/db/schema/bills";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import { centsToMoney, moneyToCents } from "@/lib/money";
import { postBillAccrualJournal } from "@/lib/bill-journal";
import { requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";

import { requirePhAccount } from "@/lib/tax/ph-account-resolver";
import { splitBillPaymentWithEwt } from "@/lib/tax/bill-payment-ewt";
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
  /** ISO date the payment took effect. Omit only when it is genuinely today. */
  paymentDate?: string;
  /** Tax withheld from this payment, if we are the agent. */
  ewtWithheld?: string;
};

async function resolveApAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "bill", "accounts_payable");
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
    /**
     * The date the payment actually took effect. Defaults to today only when
     * the caller genuinely has no better information — stamping `new Date()`
     * unconditionally back-dates nothing and posts a payment into the wrong
     * period whenever it is recorded late, which is the normal case.
     */
    effectiveDate?: string;
    ewtWithheld?: string;
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
  const functionalCurrency = await resolveFunctionalCurrency(db, input.organizationId);
  const transactionDate = input.effectiveDate ?? new Date().toISOString().slice(0, 10);

  // A payment dated into a closed period is the same violation as a bill dated
  // into one; the accrual path above already guards it, this one did not.
  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    transactionDate,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot post payment for bill ${input.bill.billNumber || input.bill.id}: its payment date ${transactionDate} falls in a period locked through ${closedThrough}.`,
    );
  }

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate,
      transactionType: "pay_out",
      source: "payment",
      functionalCurrency,
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

  const split = splitBillPaymentWithEwt(input.paymentAmount, input.ewtWithheld);
  const values = [
    {
      journalHeaderId: header.id,
      accountId: apAccountId,
      debit: split.accountsPayable,
      credit: null,
      lineDescription: `A/P Settlement: ${input.bill.billNumber || "Bill"}`,
      partyId: input.bill.vendorId,
      sortOrder: 0,
    },
    {
      journalHeaderId: header.id,
      accountId: input.bankAccountId,
      debit: null,
      credit: split.cash,
      lineDescription: `Payment for bill ${input.bill.billNumber || ""}`.trim(),
      partyId: input.bill.vendorId,
      sortOrder: 1,
    },
  ];
  if (split.withheld) {
    const ewtAccountId = await requirePhAccount(db, input.organizationId, "ph_ewt_payable");
    values.push({
      journalHeaderId: header.id,
      accountId: ewtAccountId,
      debit: null,
      credit: split.ewtPayable,
      lineDescription: "EWT withheld from supplier",
      partyId: input.bill.vendorId,
      sortOrder: 2,
    });
  }
  await db.insert(journalLines).values(values);
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
  const accrualJournalHeaderId = await postBillAccrualJournal(db, {
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
    effectiveDate: input.paymentDate,
    ewtWithheld: input.ewtWithheld,
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
