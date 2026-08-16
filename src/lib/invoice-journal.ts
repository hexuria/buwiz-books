import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { activityLogs } from "@/db/schema/activity-logs";
import { invoiceLineItems } from "@/db/schema/invoices";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { and, asc, eq, ilike } from "drizzle-orm";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { validateBalance, type JournalLineInput } from "@/db/validation/journals";
import { categoryMappings } from "@/db/schema/category-mappings";
import { requireMappedAccountId, UnmappedAccountError } from "@/lib/coa/resolve-mapped-account";

async function resolveArAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "invoice", "accounts_receivable");
}

/**
 * Sales tax payable.
 *
 * This previously matched on `ilike(accounts.name, "%sales tax%")` with no
 * ORDER BY: renaming the account broke invoicing, "Sales Tax Recoverable" also
 * matched, and which account got credited was not deterministic. The mapping is
 * now authoritative.
 *
 * The name match is kept as a LAST resort for one release. There is no
 * `sales_tax_payable` subtype, so the resolver's tier-2 fallback keys on
 * `other_current_liabilities` — which would match any other-current-liability
 * account. Orgs that already have a differently-numbered "Sales Tax Payable"
 * must keep posting to the same account until the backfill has written them an
 * explicit mapping row; only then should this branch be removed.
 */
async function resolveTaxPayableAccount(db: DbExecutor, orgId: string): Promise<string> {
  const mapped = await db
    .select({ id: accounts.id })
    .from(categoryMappings)
    .innerJoin(accounts, eq(accounts.id, categoryMappings.targetCategoryId))
    .where(
      and(
        eq(categoryMappings.organizationId, orgId),
        eq(categoryMappings.mappingType, "invoice"),
        eq(categoryMappings.sourceKey, "sales_tax_payable"),
        eq(accounts.organizationId, orgId),
        eq(accounts.accountType, "liability"),
        eq(accounts.isActive, true),
      ),
    )
    .limit(1);
  if (mapped[0]) return mapped[0].id;

  const [acct] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, orgId),
        eq(accounts.accountType, "liability"),
        ilike(accounts.name, "%sales tax%"),
        eq(accounts.isActive, true),
      ),
    )
    // Deterministic even on the legacy path.
    .orderBy(asc(accounts.accountNumber), asc(accounts.id))
    .limit(1);
  if (!acct) {
    throw new UnmappedAccountError("invoice", "sales_tax_payable", "Sales Tax Payable");
  }
  return acct.id;
}

async function resolveDiscountAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "invoice", "discounts");
}

async function generateTxnNumber(orgId: string, db: DbExecutor): Promise<string> {
  return allocateJournalTransactionNumber(orgId, db);
}

export async function createArJournalEntry(
  db: DbExecutor,
  orgId: string,
  userId: string,
  invoice: {
    id: string;
    invoiceNumber: string;
    customerId: string;
    issueDate: string;
    total: string;
    subtotal: string;
    discountAmount: string | null;
    taxAmount: string | null;
  },
): Promise<string> {
  const { locked, closedThrough } = await isDateInLockedPeriod(orgId, invoice.issueDate, db);
  if (locked) {
    throw new Error(
      `Cannot post invoice ${invoice.invoiceNumber}: its issue date ${invoice.issueDate} falls in a period locked through ${closedThrough}.`,
    );
  }

  const arAccountId = await resolveArAccount(db, orgId);
  const totalAmount = Number.parseFloat(invoice.total);
  const discountAmount = Number.parseFloat(invoice.discountAmount ?? "0");
  const taxAmount = Number.parseFloat(invoice.taxAmount ?? "0");
  const lineItems = await db
    .select({
      description: invoiceLineItems.description,
      amount: invoiceLineItems.amount,
      revenueAccountId: invoiceLineItems.revenueAccountId,
      sortOrder: invoiceLineItems.sortOrder,
    })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoice.id))
    .orderBy(invoiceLineItems.sortOrder);

  if (lineItems.length === 0)
    throw new Error("Invoice has no line items — cannot create journal entry");
  const withAccounts = lineItems.filter((line) => line.revenueAccountId);
  if (withAccounts.length === 0) {
    throw new Error(
      `Cannot post invoice ${invoice.invoiceNumber}: every line item needs a revenue account.`,
    );
  }
  if (withAccounts.length < lineItems.length) {
    throw new Error(
      `Cannot post invoice ${invoice.invoiceNumber}: ${lineItems.length - withAccounts.length} line item(s) have no revenue account assigned. Assign a revenue account to every line, or none, before sending.`,
    );
  }

  const lineInputs: (JournalLineInput & { lineDescription: string })[] = [
    {
      accountId: arAccountId,
      debit: totalAmount.toFixed(2),
      lineDescription: `A/R for invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
    },
  ];
  for (const line of withAccounts) {
    lineInputs.push({
      accountId: line.revenueAccountId!,
      credit: line.amount,
      lineDescription: line.description || "Invoice line item",
      partyId: invoice.customerId,
    });
  }
  if (discountAmount > 0) {
    lineInputs.push({
      accountId: await resolveDiscountAccount(db, orgId),
      debit: discountAmount.toFixed(2),
      lineDescription: `Discount on invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
    });
  }
  if (taxAmount > 0) {
    lineInputs.push({
      accountId: await resolveTaxPayableAccount(db, orgId),
      credit: taxAmount.toFixed(2),
      lineDescription: `Sales tax on invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
    });
  }

  const balance = validateBalance(lineInputs);
  if (!balance.valid) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} journal does not balance (debits ${balance.totalDebits.toFixed(2)} != credits ${balance.totalCredits.toFixed(2)}). Check that total = subtotal - discount + tax. Refusing to post.`,
    );
  }

  const txnNumber = await generateTxnNumber(orgId, db);
  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber: txnNumber,
      transactionDate: invoice.issueDate,
      transactionType: "pay_in",
      source: "invoice",
      memo: `Invoice Issued: ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
      totalAmount: balance.totalDebits.toFixed(2),
      status: "posted",
      sourceDocumentId: invoice.id,
      sourceDocumentType: "invoice",
      createdBy: userId,
      referenceNumber: invoice.invoiceNumber,
      idempotencyKey: `invoice-accrual:${invoice.id}`,
    })
    .returning();
  await db.insert(journalLines).values(
    lineInputs.map((line, index) => ({
      journalHeaderId: header.id,
      accountId: line.accountId,
      debit: line.debit ?? null,
      credit: line.credit ?? null,
      lineDescription: line.lineDescription,
      partyId: invoice.customerId,
      departmentId: null as string | null,
      locationId: null as string | null,
      sortOrder: index,
    })),
  );
  await db.insert(activityLogs).values({
    organizationId: orgId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: userId,
    changes: {
      source: "invoice_issued",
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: balance.totalDebits.toFixed(2),
      transactionNumber: txnNumber,
    },
  });
  return header.id;
}

export async function createPaymentJournalEntry(
  db: DbExecutor,
  orgId: string,
  userId: string,
  invoice: { id: string; invoiceNumber: string; customerId: string },
  bankAccountId: string,
  paymentAmount: number,
  idempotencyKey?: string,
): Promise<string> {
  const [depositAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, bankAccountId),
        eq(accounts.organizationId, orgId),
        eq(accounts.accountType, "asset"),
        eq(accounts.isActive, true),
      ),
    )
    .limit(1);
  if (!depositAccount) {
    throw new Error("The selected deposit account is unavailable for this organization");
  }

  const arAccountId = await resolveArAccount(db, orgId);
  const txnNumber = await generateTxnNumber(orgId, db);
  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber: txnNumber,
      transactionDate: new Date().toISOString().split("T")[0],
      transactionType: "pay_in",
      source: "payment",
      memo: `Payment Received: ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
      totalAmount: paymentAmount.toFixed(2),
      status: "posted",
      sourceDocumentId: invoice.id,
      sourceDocumentType: "invoice",
      createdBy: userId,
      referenceNumber: invoice.invoiceNumber,
      idempotencyKey: idempotencyKey ? `invoice-payment:manual:${idempotencyKey}` : undefined,
    })
    .returning();
  await db.insert(journalLines).values([
    {
      journalHeaderId: header.id,
      accountId: bankAccountId,
      debit: paymentAmount.toFixed(2),
      credit: null,
      lineDescription: `Payment for invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
      departmentId: null,
      locationId: null,
      sortOrder: 0,
    },
    {
      journalHeaderId: header.id,
      accountId: arAccountId,
      debit: null,
      credit: paymentAmount.toFixed(2),
      lineDescription: `A/R reduction for invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
      departmentId: null,
      locationId: null,
      sortOrder: 1,
    },
  ]);
  await db.insert(activityLogs).values({
    organizationId: orgId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: userId,
    changes: {
      source: "invoice_payment",
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentAmount: paymentAmount.toFixed(2),
      bankAccountId,
      transactionNumber: txnNumber,
    },
  });
  return header.id;
}
