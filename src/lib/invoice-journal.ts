import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { invoiceLineItems } from "@/db/schema/invoices";
import { validateBalance, type JournalLineInput } from "@/db/validation/journals";
import { activityLogs } from "@/db/schema/activity-logs";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { and, asc, eq, ilike } from "drizzle-orm";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { currentOrgDate } from "./org-calendar";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import {
  requireMappedAccountId,
  resolveMappedAccountId,
  UnmappedAccountError,
} from "@/lib/coa/resolve-mapped-account";

async function resolveArAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "invoice", "accounts_receivable");
}

async function generateTxnNumber(orgId: string, db: DbExecutor): Promise<string> {
  return allocateJournalTransactionNumber(orgId, db);
}

/**
 * Posts a received invoice payment.
 *
 *   DR  Deposit account (bank)          amount
 *   CR  Accounts Receivable             amount
 *
 * This module previously also carried `createArJournalEntry`, a third copy of
 * the invoice-accrual posting that nothing in production called — the live path
 * is the copy in routes/api/-invoices.ts. It has been removed rather than kept
 * in sync: a dead fork that still passes its own tests is how the two
 * implementations drifted apart to begin with.
 */
export async function createPaymentJournalEntry(
  db: DbExecutor,
  orgId: string,
  userId: string,
  invoice: { id: string; invoiceNumber: string; customerId: string },
  bankAccountId: string,
  paymentAmount: number,
  idempotencyKey?: string,
  /** ISO date the payment took effect. Defaults to today. */
  effectiveDate?: string,
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
  const functionalCurrency = await resolveFunctionalCurrency(db, orgId);
  const transactionDate = effectiveDate ?? (await currentOrgDate(db, orgId));

  // The accrual path guarded the period lock; this one did not, so a payment
  // could land in a closed month even though issuing the invoice could not.
  const { locked, closedThrough } = await isDateInLockedPeriod(orgId, transactionDate, db);
  if (locked) {
    throw new Error(
      `Cannot post payment for invoice ${invoice.invoiceNumber}: its payment date ${transactionDate} falls in a period locked through ${closedThrough}.`,
    );
  }

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber: txnNumber,
      transactionDate,
      transactionType: "pay_in",
      source: "payment",
      functionalCurrency,
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

async function resolveTaxPayableAccount(db: DbExecutor, orgId: string): Promise<string> {
  const mapped = await resolveMappedAccountId(db, orgId, "invoice", "sales_tax_payable");
  if (mapped) return mapped;

  // Legacy name match, kept for one release so an org that already has a
  // differently-numbered "Sales Tax Payable" keeps posting to the same account
  // until the backfill writes it an explicit mapping. Ordered, unlike before.
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

/**
 * Generate a sequential transaction number for journal entries.
 */

/**
 * Create the A/R journal entry when an invoice is sent (accrual basis).
 *   DR Accounts Receivable   (invoice total, net of discount)
 *   DR Sales Discount        (discount amount — contra-revenue)
 *   CR Revenue accounts      (per line item, gross subtotal)
 *   CR Sales Tax Payable     (tax amount — liability)
 * The entry is validated to balance (debits == credits) BEFORE anything is written;
 * it is never posted unbalanced. Returns null (posting nothing) only when the invoice
 * has no revenue accounts assigned at all — the caller still transitions status and the
 * journal can be posted once accounts are assigned.
 *
 * Exported for tests. This is the ONLY implementation — the copy that lived in
 * lib/invoice-journal.ts was dead and has been removed, so the integration
 * suite now exercises the code that actually posts.
 */
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
  // The A/R journal is dated on the invoice's issue date — refuse to post into a closed period.
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

  // Fetch line items with their revenue accounts
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

  if (lineItems.length === 0) {
    throw new Error("Invoice has no line items — cannot create journal entry");
  }

  const withAccounts = lineItems.filter((l) => l.revenueAccountId);

  if (withAccounts.length === 0) {
    throw new Error(
      `Cannot post invoice ${invoice.invoiceNumber}: every line item needs a revenue account.`,
    );
  }

  // Partial assignment would credit only some of the revenue and unbalance the entry —
  // refuse rather than post a broken journal (this was the historical silent-imbalance bug).
  if (withAccounts.length < lineItems.length) {
    throw new Error(
      `Cannot post invoice ${invoice.invoiceNumber}: ${
        lineItems.length - withAccounts.length
      } line item(s) have no revenue account assigned. Assign a revenue account to every line, or none, before sending.`,
    );
  }

  // Build the balanced set of lines as JournalLineInput (validated before insert).
  const lineInputs: (JournalLineInput & { lineDescription: string })[] = [];

  // DR Accounts Receivable (net total the customer owes)
  lineInputs.push({
    accountId: arAccountId,
    debit: totalAmount.toFixed(2),
    lineDescription: `A/R for invoice ${invoice.invoiceNumber}`,
    partyId: invoice.customerId,
  });

  // CR Revenue (gross, per line)
  for (const line of withAccounts) {
    lineInputs.push({
      accountId: line.revenueAccountId!,
      credit: line.amount,
      lineDescription: line.description || "Invoice line item",
      partyId: invoice.customerId,
    });
  }

  // DR Sales Discount (contra-revenue) — offsets the gross revenue credit
  if (discountAmount > 0) {
    const discountAccountId = await resolveDiscountAccount(db, orgId);
    lineInputs.push({
      accountId: discountAccountId,
      debit: discountAmount.toFixed(2),
      lineDescription: `Discount on invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
    });
  }

  // CR Sales Tax Payable (liability) — tax collected on behalf of the authority
  if (taxAmount > 0) {
    const taxAccountId = await resolveTaxPayableAccount(db, orgId);
    lineInputs.push({
      accountId: taxAccountId,
      credit: taxAmount.toFixed(2),
      lineDescription: `Sales tax on invoice ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
    });
  }

  // Never post an unbalanced entry.
  const balance = validateBalance(lineInputs);
  if (!balance.valid) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} journal does not balance ` +
        `(debits ${balance.totalDebits.toFixed(2)} != credits ${balance.totalCredits.toFixed(2)}). ` +
        `Check that total = subtotal - discount + tax. Refusing to post.`,
    );
  }

  const txnNumber = await generateTxnNumber(orgId, db);
  const functionalCurrency = await resolveFunctionalCurrency(db, orgId);

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber: txnNumber,
      transactionDate: invoice.issueDate,
      transactionType: "pay_in",
      source: "invoice",
      functionalCurrency,
      memo: `Invoice Issued: ${invoice.invoiceNumber}`,
      partyId: invoice.customerId,
      totalAmount: balance.totalDebitsExact, // schema: cached sum of debit lines
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

  // Activity log
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
      totalAmount: balance.totalDebitsExact,
      transactionNumber: txnNumber,
    },
  });

  return header.id;
}
