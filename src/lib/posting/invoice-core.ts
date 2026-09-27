/**
 * createInvoiceCore — the invoice editor's save, with no session.
 *
 * Creating an invoice writes a draft and posts nothing: the A/R journal is
 * posted when the invoice is sent (transitionInvoiceStatus). The server
 * function keeps the session, permission and rate-limit guard; this core owns
 * validation, numbering and the writes, so the Inbox can later create sales
 * invoices through the same code.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { invoiceLineItems, invoices } from "@/db/schema/invoices";
import { parties } from "@/db/schema/parties";
import { calculateInvoiceAmounts } from "@/lib/money";
import { allocateInvoiceNumber } from "@/lib/sequence";
import { requireUserActor, type PostingActor } from "./actor";

export interface InvoiceLineDraft {
  description?: string;
  quantity: string | number;
  unitPrice: string | number;
  revenueAccountId?: string | null;
  sortOrder?: number;
}

export interface InvoiceDraft {
  /** Omitted on the normal path: the next sequence number is assigned at save. */
  invoiceNumber?: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  discountAmount: string | number;
  taxAmount: string | number;
  notes?: string;
  paymentTerms?: string;
  lineItems: InvoiceLineDraft[];
}

/**
 * Every reference on an invoice payload must belong to the organization: the
 * customer, and each line's revenue account (which must also be active).
 */
export async function assertInvoiceReferences(
  db: DbExecutor,
  orgId: string,
  customerId: string | undefined,
  lineItems: Array<{ revenueAccountId?: string | null }> | undefined,
): Promise<void> {
  if (customerId) {
    const [customer] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.id, customerId), eq(parties.organizationId, orgId)))
      .limit(1);
    if (!customer) throw new Error("Customer is unavailable for this organization");
  }

  const accountIds = [
    ...new Set(
      (lineItems ?? [])
        .map((line) => line.revenueAccountId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (accountIds.length > 0) {
    const validAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, orgId),
          eq(accounts.isActive, true),
          inArray(accounts.id, accountIds),
        ),
      );
    if (validAccounts.length !== accountIds.length) {
      throw new Error("A revenue account is unavailable for this organization");
    }
  }
}

export async function createInvoiceCore(
  db: DbExecutor,
  orgId: string,
  actor: PostingActor,
  draft: InvoiceDraft,
) {
  requireUserActor(actor, "createInvoiceCore");
  await assertInvoiceReferences(db, orgId, draft.customerId, draft.lineItems);
  const amounts = calculateInvoiceAmounts(draft.lineItems, draft.discountAmount, draft.taxAmount);

  // Allocation happens HERE, not on the draft screen's GET (checkpoint
  // C6: peek on open, assign on save). Historical custom numbers can
  // occupy sequence values, so skip over collisions; the per-org unique
  // constraint stays the true guard under concurrency.
  let invoiceNumber = draft.invoiceNumber?.trim() || null;
  if (!invoiceNumber) {
    for (let attempt = 0; attempt < 5 && !invoiceNumber; attempt++) {
      const candidate = await allocateInvoiceNumber(orgId, db);
      const [clash] = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.organizationId, orgId), eq(invoices.invoiceNumber, candidate)))
        .limit(1);
      if (!clash) invoiceNumber = candidate;
    }
    if (!invoiceNumber) {
      throw new Error("Could not assign an invoice number. Please try again.");
    }
  }

  return await db.transaction(async (tx) => {
    const [invoice] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        invoiceNumber,
        customerId: draft.customerId,
        issueDate: draft.issueDate,
        dueDate: draft.dueDate,
        status: "draft",
        subtotal: amounts.subtotal,
        discountAmount: amounts.discountAmount,
        taxAmount: amounts.taxAmount,
        total: amounts.total,
        balanceDue: amounts.total,
        amountPaid: "0",
        notes: draft.notes,
        paymentTerms: draft.paymentTerms,
      })
      .returning();

    if (draft.lineItems.length > 0) {
      await tx.insert(invoiceLineItems).values(
        draft.lineItems.map((item, idx) => ({
          invoiceId: invoice.id,
          description: item.description ?? "",
          quantity: String(item.quantity),
          unitPrice: String(item.unitPrice),
          amount: amounts.lineAmounts[idx],
          revenueAccountId: item.revenueAccountId ?? undefined,
          sortOrder: item.sortOrder ?? idx,
        })),
      );
    }

    return invoice;
  });
}
