/**
 * The bill accrual journal — one implementation.
 *
 *   DR  Expense accounts (one line per bill line item)
 *   CR  Accounts Payable (the total)
 *
 * WHY THIS MODULE EXISTS. There were two implementations of this posting:
 * `createApAccrualJournal` in routes/api/-bills.ts and
 * `ensureBillAccrualJournal` in lib/manual-bill-payment.ts. They produced the
 * same journal, and both had to be repaired in parallel for the same three
 * defects — a missing functional currency, a float-summed A/P credit that
 * could not equal the raw debit lines it offsets, and the period-lock guard.
 * Fixing a defect twice is the cost of the duplication; missing one of the two
 * is the risk. The invoice A/R posting had already been through this: its
 * third copy sat dead in lib/invoice-journal.ts until it was deleted.
 *
 * IDEMPOTENCY. A bill that already carries a `journalHeaderId` returns it
 * untouched. The header also carries `idempotencyKey = bill-accrual:<id>`, so
 * a concurrent second attempt is rejected by the unique index rather than
 * producing a second accrual.
 */
import { asc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { billLineItems, type bills } from "@/db/schema/bills";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import { requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import { sumMoney } from "@/lib/inbox/money";

/**
 * Post (or return the existing) accrual journal for a bill.
 *
 * The caller must supply a transaction-scoped executor: the header, its lines
 * and the activity log have to land together, and the balance constraint from
 * 0041 is deferred to COMMIT.
 */
export async function postBillAccrualJournal(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    bill: typeof bills.$inferSelect;
  },
): Promise<string> {
  const { bill, organizationId: orgId, userId } = input;

  // Already posted — return it rather than posting a second accrual.
  if (bill.journalHeaderId) return bill.journalHeaderId;

  // Dated on the bill date, so it must not fall in a closed period.
  const { locked, closedThrough } = await isDateInLockedPeriod(orgId, bill.billDate, db);
  if (locked) {
    throw new Error(
      `Cannot post bill ${bill.billNumber || bill.id}: its bill date ${bill.billDate} falls in a period locked through ${closedThrough}.`,
    );
  }

  const lineItems = await db
    .select({
      description: billLineItems.description,
      amount: billLineItems.amount,
      accountId: billLineItems.accountId,
      departmentId: billLineItems.departmentId,
      locationId: billLineItems.locationId,
      sortOrder: billLineItems.sortOrder,
    })
    .from(billLineItems)
    .where(eq(billLineItems.billId, bill.id))
    .orderBy(asc(billLineItems.sortOrder));

  if (lineItems.length === 0) {
    throw new Error("Bill has no line items — cannot create journal entry");
  }

  // Exact summation at the ledger's own scale. A float sum passed through
  // `.toFixed(2)` does not equal the raw line amounts it offsets once a line
  // carries more than two decimals, which posts a journal that does not
  // balance.
  const totalAmount = sumMoney(lineItems.map((line) => line.amount));
  const apAccountId = await requireMappedAccountId(db, orgId, "bill", "accounts_payable");
  const transactionNumber = await allocateJournalTransactionNumber(orgId, db);
  const functionalCurrency = await resolveFunctionalCurrency(db, orgId);

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber,
      transactionDate: bill.billDate,
      transactionType: "journal",
      source: "bill",
      functionalCurrency,
      memo: `Bill Accrual: ${bill.billNumber || bill.id}`,
      partyId: bill.vendorId,
      totalAmount,
      status: "posted",
      postedAt: new Date(),
      sourceDocumentId: bill.id,
      sourceDocumentType: "bill",
      createdBy: userId,
      referenceNumber: bill.billNumber || null,
      idempotencyKey: `bill-accrual:${bill.id}`,
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
      partyId: bill.vendorId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: index,
    })),
    {
      journalHeaderId: header.id,
      accountId: apAccountId,
      debit: null as string | null,
      credit: totalAmount,
      lineDescription: `A/P: ${bill.billNumber || "Bill"}`,
      partyId: bill.vendorId,
      departmentId: null as string | null,
      locationId: null as string | null,
      sortOrder: lineItems.length,
    },
  ]);

  await db.insert(activityLogs).values({
    organizationId: orgId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: userId,
    changes: {
      source: "bill_accrual",
      billId: bill.id,
      billNumber: bill.billNumber,
      totalAmount,
      transactionNumber,
    },
  });

  return header.id;
}
