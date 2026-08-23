/**
 * Invoice Server Functions — CRUD + Status Transitions + Ledger Integration
 * Mirrors the bills server pattern for invoice management.
 * Implements accrual-basis double-entry: A/R journal on send, payment journal on receipt.
 */
import { createServerFn } from "@tanstack/react-start";
import { serverBrand } from "@/config/brand";
import type { DbExecutor } from "../../db";
import { invoices, invoiceLineItems } from "../../db/schema/invoices";
import { parties } from "../../db/schema/parties";
import { accounts } from "../../db/schema/accounts";
import { journalHeaders, journalLines } from "../../db/schema/journals";
import { reconciliations, statementLines } from "../../db/schema/reconciliations";
import { activityLogs } from "../../db/schema/activity-logs";
import { eq, desc, asc, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { allocateInvoiceNumber } from "../../lib/sequence";
import { getClosedThrough, isDateLocked } from "../../lib/period-close";
import { journalsClearedByFinalizedReconciliation } from "../../lib/reconciliation-claimed-lines";
import { resolveFunctionalCurrency } from "../../lib/functional-currency";
import { sendInvoiceEmail as sendEmail } from "../../services/email";
import { organization, member, user } from "../../db/schema/auth";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { calculateInvoiceAmounts, centsToMoney, moneyToCents } from "../../lib/money";
import { parseOrgMetadata } from "../../lib/org-metadata";
import { getOrganizationSecrets } from "../../lib/org-secrets";
import {
  beginAccountingOperation,
  completeAccountingOperation,
} from "../../lib/operational-idempotency";
import { recordManualInvoicePayment } from "../../lib/manual-invoice-payment";
import { createArJournalEntry } from "../../lib/invoice-journal";

// ============================================================================
// Types
// ============================================================================

export type InvoiceListItem = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  status: string;
  total: string;
  balanceDue: string;
  createdAt: Date;
  customerName: string | null;
};

export type InvoiceLineItemDetail = {
  id: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  revenueAccountId: string | null;
  accountName: string | null;
  sortOrder: number;
};

export type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  status: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  notes: string | null;
  paymentTerms: string | null;
  sentAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  customerName: string | null;
  customerEmail: string | null;
  lineItems: InvoiceLineItemDetail[];
};

// ============================================================================
// List Invoices
// ============================================================================

const listInvoicesSchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
});

export const listInvoices = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { status } = listInvoicesSchema.parse(rawData ?? {});

      // Fetch all org invoices (we'll filter after auto-transitioning overdue ones)
      const rows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          customerId: invoices.customerId,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
          createdAt: invoices.createdAt,
          customerName: parties.name,
        })
        .from(invoices)
        .leftJoin(parties, eq(invoices.customerId, parties.id))
        .where(eq(invoices.organizationId, orgId))
        .orderBy(desc(invoices.createdAt));

      // Auto-transition sent/viewed invoices to overdue when their due date has passed
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const overdueIds = rows
        .filter((r) => {
          if (r.status !== "sent" && r.status !== "viewed") return false;
          if (!r.dueDate) return false;
          return new Date(r.dueDate) < today;
        })
        .map((r) => r.id);

      let patchedRows = rows;
      if (overdueIds.length > 0) {
        await db
          .update(invoices)
          .set({ status: "overdue", updatedAt: new Date() })
          .where(and(eq(invoices.organizationId, orgId), inArray(invoices.id, overdueIds)));
        // Rebuild with corrected status so the return reflects DB state immediately
        patchedRows = rows.map((r) =>
          overdueIds.includes(r.id) ? { ...r, status: "overdue" as const } : r,
        );
      }

      // Apply optional status filter
      const filtered = status ? patchedRows.filter((r) => r.status === status) : patchedRows;
      return filtered as InvoiceListItem[];
    });
  },
);

// ============================================================================
// Get Invoice (Detail)
// ============================================================================

const getInvoiceSchema = z.object({
  id: z.string().uuid(),
});

export const getInvoice = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { id } = getInvoiceSchema.parse(rawData);

      const [invoice] = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          customerId: invoices.customerId,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          amountPaid: invoices.amountPaid,
          balanceDue: invoices.balanceDue,
          notes: invoices.notes,
          paymentTerms: invoices.paymentTerms,
          sentAt: invoices.sentAt,
          paidAt: invoices.paidAt,
          createdAt: invoices.createdAt,
          updatedAt: invoices.updatedAt,
          customerName: parties.name,
          customerEmail: parties.email,
        })
        .from(invoices)
        .leftJoin(parties, eq(invoices.customerId, parties.id))
        .where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId)));

      if (!invoice) {
        throw new Error("Invoice not found");
      }

      const lineItemRows = await db
        .select({
          id: invoiceLineItems.id,
          description: invoiceLineItems.description,
          quantity: invoiceLineItems.quantity,
          unitPrice: invoiceLineItems.unitPrice,
          amount: invoiceLineItems.amount,
          revenueAccountId: invoiceLineItems.revenueAccountId,
          accountName: accounts.name,
          sortOrder: invoiceLineItems.sortOrder,
        })
        .from(invoiceLineItems)
        .leftJoin(accounts, eq(invoiceLineItems.revenueAccountId, accounts.id))
        .where(eq(invoiceLineItems.invoiceId, id))
        .orderBy(invoiceLineItems.sortOrder);

      return {
        ...invoice,
        lineItems: lineItemRows,
      } as InvoiceDetail;
    });
  },
);

// ============================================================================
// Get Next Invoice Number
// ============================================================================

export const getNextInvoiceNumber = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId }) => {
    return allocateInvoiceNumber(orgId);
  });
});

// ============================================================================
// Create Invoice
// ============================================================================

const lineItemSchema = z.object({
  description: z.string().optional(),
  quantity: z.string().or(z.number()).default("1"),
  unitPrice: z.string().or(z.number()).default("0"),
  amount: z.string().or(z.number()).default("0"),
  revenueAccountId: z.string().uuid().optional().nullable(),
  sortOrder: z.number().default(0),
});

async function assertInvoiceReferences(
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

const createInvoiceSchema = z.object({
  invoiceNumber: z.string().min(1),
  customerId: z.string().uuid(),
  issueDate: z.string(),
  dueDate: z.string(),
  subtotal: z.string().or(z.number()).default("0"),
  discountAmount: z.string().or(z.number()).default("0"),
  taxAmount: z.string().or(z.number()).default("0"),
  total: z.string().or(z.number()).default("0"),
  notes: z.string().optional(),
  paymentTerms: z.string().optional(),
  lineItems: z.array(lineItemSchema).default([]),
});

export const createInvoice = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "invoice",
      "create",
      { routeKey: "invoice:create", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createInvoiceSchema.parse(rawData);
        await assertInvoiceReferences(db, orgId, parsed.customerId, parsed.lineItems);
        const amounts = calculateInvoiceAmounts(
          parsed.lineItems,
          parsed.discountAmount,
          parsed.taxAmount,
        );

        return await db.transaction(async (tx) => {
          const [invoice] = await tx
            .insert(invoices)
            .values({
              organizationId: orgId,
              invoiceNumber: parsed.invoiceNumber,
              customerId: parsed.customerId,
              issueDate: parsed.issueDate,
              dueDate: parsed.dueDate,
              status: "draft",
              subtotal: amounts.subtotal,
              discountAmount: amounts.discountAmount,
              taxAmount: amounts.taxAmount,
              total: amounts.total,
              balanceDue: amounts.total,
              amountPaid: "0",
              notes: parsed.notes,
              paymentTerms: parsed.paymentTerms,
            })
            .returning();

          if (parsed.lineItems.length > 0) {
            await tx.insert(invoiceLineItems).values(
              parsed.lineItems.map((item, idx) => ({
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
      },
    );
  },
);

// ============================================================================
// Update Invoice
// ============================================================================

const updateInvoiceSchema = z.object({
  id: z.string().uuid(),
  invoiceNumber: z.string().optional(),
  customerId: z.string().uuid().optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  subtotal: z.string().or(z.number()).optional(),
  discountAmount: z.string().or(z.number()).optional(),
  taxAmount: z.string().or(z.number()).optional(),
  total: z.string().or(z.number()).optional(),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  lineItems: z.array(lineItemSchema).optional(),
});

export const updateInvoice = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "invoice",
      "update",
      { routeKey: "invoice:update", limit: 45, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = updateInvoiceSchema.parse(rawData);
        const { id, lineItems: newLineItems, ...updates } = parsed;
        await assertInvoiceReferences(db, orgId, parsed.customerId, newLineItems);

        return await db.transaction(async (tx) => {
          const [current] = await tx
            .select({
              status: invoices.status,
              amountPaid: invoices.amountPaid,
              discountAmount: invoices.discountAmount,
              taxAmount: invoices.taxAmount,
            })
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId)))
            .for("update");
          if (!current) throw new Error("Invoice not found");
          if (current.status !== "draft") {
            throw new Error("Only draft invoices can be edited");
          }

          let calculatedAmounts: ReturnType<typeof calculateInvoiceAmounts> | undefined;
          if (
            newLineItems ||
            updates.discountAmount !== undefined ||
            updates.taxAmount !== undefined
          ) {
            const itemsForCalculation =
              newLineItems ??
              (await tx
                .select({
                  quantity: invoiceLineItems.quantity,
                  unitPrice: invoiceLineItems.unitPrice,
                })
                .from(invoiceLineItems)
                .where(eq(invoiceLineItems.invoiceId, id)));
            calculatedAmounts = calculateInvoiceAmounts(
              itemsForCalculation,
              updates.discountAmount ?? current.discountAmount ?? "0",
              updates.taxAmount ?? current.taxAmount ?? "0",
            );
          } else if (updates.subtotal !== undefined || updates.total !== undefined) {
            throw new Error("Invoice subtotal and total are derived from line items");
          }

          // Build update fields
          const updateFields: Record<string, any> = { updatedAt: new Date() };
          for (const [key, value] of Object.entries(updates)) {
            if (
              key === "subtotal" ||
              key === "total" ||
              key === "discountAmount" ||
              key === "taxAmount"
            ) {
              continue;
            }
            if (value !== undefined) {
              updateFields[key] = typeof value === "number" ? String(value) : value;
            }
          }

          if (calculatedAmounts) {
            Object.assign(updateFields, {
              subtotal: calculatedAmounts.subtotal,
              discountAmount: calculatedAmounts.discountAmount,
              taxAmount: calculatedAmounts.taxAmount,
              total: calculatedAmounts.total,
              balanceDue: centsToMoney(
                moneyToCents(calculatedAmounts.total) - moneyToCents(current.amountPaid ?? "0"),
              ),
            });
          }

          const [updated] = await tx
            .update(invoices)
            .set(updateFields)
            .where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId)))
            .returning();

          // Replace line items if provided
          if (newLineItems) {
            await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id));

            if (newLineItems.length > 0) {
              await tx.insert(invoiceLineItems).values(
                newLineItems.map((item, idx) => ({
                  invoiceId: id,
                  description: item.description ?? "",
                  quantity: String(item.quantity),
                  unitPrice: String(item.unitPrice),
                  amount: calculatedAmounts!.lineAmounts[idx],
                  revenueAccountId: item.revenueAccountId ?? undefined,
                  sortOrder: item.sortOrder ?? idx,
                })),
              );
            }
          }

          return updated;
        });
      },
    );
  },
);

// ============================================================================
// Transition Invoice Status (with Ledger Integration)
// ============================================================================

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["sent", "voided"],
  sent: ["viewed", "overdue", "paid", "partial", "voided"],
  viewed: ["overdue", "paid", "partial", "voided"],
  overdue: ["paid", "partial", "voided"],
  partial: ["paid", "partial", "voided"],
  // A paid invoice posted in error previously had NO correction path: this
  // table had no "paid" key, so paid→voided threw, and deleteInvoice refuses
  // non-draft rows. Bills already allow exactly this for corrections.
  paid: ["voided"],
};

const transitionSchema = z.object({
  invoiceId: z.string().uuid(),
  newStatus: z.string(),
  idempotencyKey: z.string().uuid().optional(),
  bankAccountId: z.string().uuid().optional(),
  paymentAmount: z.string().or(z.number()).optional(),
  // See the bill twin: without this, payments are dated by entry day.
  paymentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "paymentDate must be YYYY-MM-DD")
    .optional(),
});

const JOURNAL_PRODUCING_INVOICE_STATUSES = new Set(["sent"]);

/**
 * A/R, sales tax, and contra-revenue discount accounts.
 *
 * These are thin wrappers over the shared server-side resolver so this route
 * and `src/lib/invoice-journal.ts` cannot drift — they were previously three
 * copy-pasted lookups that scanned for a hardcoded subtype (and, for tax, for a
 * user-editable account NAME) while ignoring the mapping the org configured.
 */
export const transitionInvoiceStatus = createServerFn({
  method: "POST",
}).handler(async ({ data: rawData }: { data: unknown }) => {
  return withMutationPermissionOrgContext(
    "invoice",
    "update",
    { routeKey: "invoice:transition", limit: 30, windowMs: 60_000 },
    async ({ orgId, userId, db }) => {
      const { invoiceId, newStatus, idempotencyKey, bankAccountId, paymentAmount, paymentDate } =
        transitionSchema.parse(rawData);

      // Require bankAccountId when marking as paid or partial
      if ((newStatus === "paid" || newStatus === "partial") && !bankAccountId) {
        throw new Error("bankAccountId is required when recording a payment");
      }
      if (
        (JOURNAL_PRODUCING_INVOICE_STATUSES.has(newStatus) ||
          newStatus === "paid" ||
          newStatus === "partial") &&
        !idempotencyKey
      ) {
        throw new Error(
          "A caller-generated idempotencyKey is required for journal-producing invoice transitions.",
        );
      }
      if (newStatus === "paid" || newStatus === "partial") {
        return recordManualInvoicePayment(db, {
          organizationId: orgId,
          userId,
          invoiceId,
          requestedStatus: newStatus,
          bankAccountId: bankAccountId!,
          paymentAmount,
          paymentDate,
          idempotencyKey: idempotencyKey!,
        });
      }
      const canonicalPaymentAmount =
        paymentAmount == null ? null : centsToMoney(moneyToCents(paymentAmount, "Payment amount"));
      if (
        canonicalPaymentAmount != null &&
        moneyToCents(canonicalPaymentAmount, "Payment amount") <= 0
      ) {
        throw new Error("Payment amount must be greater than zero");
      }

      const [invoice] = await db
        .select({
          id: invoices.id,
          status: invoices.status,
          invoiceNumber: invoices.invoiceNumber,
          customerId: invoices.customerId,
          issueDate: invoices.issueDate,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          amountPaid: invoices.amountPaid,
          balanceDue: invoices.balanceDue,
          journalHeaderId: invoices.journalHeaderId,
        })
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
        .for("update");

      if (!invoice) {
        throw new Error("Invoice not found");
      }

      const operation = idempotencyKey
        ? await beginAccountingOperation(db, {
            organizationId: orgId,
            operationType: "invoice-status-transition",
            entityType: "invoice",
            entityId: invoiceId,
            idempotencyKey,
            payload: {
              invoiceId,
              newStatus,
              bankAccountId: bankAccountId ?? null,
              paymentAmount: canonicalPaymentAmount,
            },
            actorId: userId,
          })
        : null;
      if (operation?.replayed) {
        return {
          ...invoice,
          deduplicated: true,
          operationId: operation.operation.id,
          operationJournalHeaderId: operation.operation.journalHeaderId,
        };
      }

      const allowed = VALID_TRANSITIONS[invoice.status] ?? [];
      if (!allowed.includes(newStatus)) {
        throw new Error(`Cannot transition from "${invoice.status}" to "${newStatus}"`);
      }

      const updateFields: Record<string, any> = {
        status: newStatus,
        updatedAt: new Date(),
      };
      if (newStatus === "voided") {
        // A voided invoice is owed nothing. Leaving balanceDue standing made
        // the public pay link keep asking the customer for money the ledger no
        // longer claims (the capture itself was already refused downstream).
        updateFields.balanceDue = "0.00";
      }
      let operationJournalHeaderId: string | null = null;

      // ═══════════════════════════════════════════════════════════════
      // SENT — Create A/R journal entry (accrual basis)
      // DR Accounts Receivable, CR Revenue
      // ═══════════════════════════════════════════════════════════════
      if (newStatus === "sent") {
        updateFields.sentAt = new Date();

        // Only create A/R journal if not already posted (idempotent guard)
        if (!invoice.journalHeaderId) {
          updateFields.journalHeaderId = await createArJournalEntry(db, orgId, userId, {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            customerId: invoice.customerId,
            issueDate: invoice.issueDate,
            total: invoice.total,
            subtotal: invoice.subtotal,
            discountAmount: invoice.discountAmount,
            taxAmount: invoice.taxAmount,
          });
          operationJournalHeaderId = updateFields.journalHeaderId;
        } else {
          operationJournalHeaderId = invoice.journalHeaderId;
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // VOIDED — void the posted journal entries (void-only, no reversal)
      // Reports aggregate posted rows only, so flipping the source journals to
      // "voided" removes their effect entirely. Posting a reversal *as well* would
      // double the impact (net -1× the original) — that was the historical bug.
      // ═══════════════════════════════════════════════════════════════
      if (newStatus === "voided") {
        const linkedHeaders = await db
          .select({
            id: journalHeaders.id,
            transactionDate: journalHeaders.transactionDate,
            duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
          })
          .from(journalHeaders)
          .where(
            and(
              eq(journalHeaders.organizationId, orgId),
              eq(journalHeaders.sourceDocumentId, invoice.id),
              eq(journalHeaders.sourceDocumentType, "invoice"),
              eq(journalHeaders.status, "posted"),
            ),
          )
          .orderBy(asc(journalHeaders.id))
          .for("update");
        if (linkedHeaders.some((header) => header.duplicateOfHeaderId !== null)) {
          throw new Error(
            "Cannot void invoice: a linked journal is a suppressed duplicate. Unmatch it first.",
          );
        }
        const closedThrough = await getClosedThrough(orgId, db);
        if (linkedHeaders.some((header) => isDateLocked(header.transactionDate, closedThrough))) {
          throw new Error(
            `Cannot void invoice: a linked journal is in a period locked through ${closedThrough}.`,
          );
        }

        // Shared with bill void; unlike the old inline check this also sees
        // journals cleared by SPLIT matches, not only the 1:1 column.
        if (
          await journalsClearedByFinalizedReconciliation(
            db,
            orgId,
            linkedHeaders.map((header) => header.id),
          )
        ) {
          throw new Error(
            "Cannot void invoice: a linked journal is locked by a finalized reconciliation.",
          );
        }

        // Void the A/R journal and every payment journal linked to this invoice.
        await db
          .update(journalHeaders)
          .set({ status: "voided", voidedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(journalHeaders.organizationId, orgId),
              eq(journalHeaders.sourceDocumentId, invoice.id),
              eq(journalHeaders.sourceDocumentType, "invoice"),
              eq(journalHeaders.status, "posted"),
            ),
          );
      }

      // Activity log for the transition itself
      await db.insert(activityLogs).values({
        organizationId: orgId,
        entityType: "invoice",
        entityId: invoiceId,
        action: newStatus === "voided" ? "voided" : "updated",
        actorId: userId,
        changes: {
          previousStatus: invoice.status,
          newStatus: updateFields.status,
          ...(bankAccountId ? { bankAccountId } : {}),
          ...(canonicalPaymentAmount !== null ? { paymentAmount: canonicalPaymentAmount } : {}),
        },
      });

      const [updated] = await db
        .update(invoices)
        .set(updateFields)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
        .returning();

      if (operation) {
        await completeAccountingOperation(db, {
          operationId: operation.operation.id,
          journalHeaderId: operationJournalHeaderId,
          result: {
            invoiceId,
            previousStatus: invoice.status,
            status: updated.status,
            amountPaid: updated.amountPaid,
            balanceDue: updated.balanceDue,
            invoiceJournalHeaderId: updated.journalHeaderId,
            operationJournalHeaderId,
          },
        });
      }

      return {
        ...updated,
        ...(operation
          ? {
              deduplicated: false,
              operationId: operation.operation.id,
              operationJournalHeaderId,
            }
          : {}),
      };
    },
  );
});

// ============================================================================
// Delete Invoice (draft only)
// ============================================================================

const deleteInvoiceSchema = z.object({
  id: z.string().uuid(),
});

export const deleteInvoice = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "invoice",
      "delete",
      { routeKey: "invoice:delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id } = deleteInvoiceSchema.parse(rawData);

        const [invoice] = await db
          .select({ status: invoices.status })
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId)));

        if (!invoice) {
          throw new Error("Invoice not found");
        }

        if (invoice.status !== "draft" && invoice.status !== "voided") {
          throw new Error("Only draft or voided invoices can be deleted");
        }

        await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id));
        await db
          .delete(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId)));

        return { success: true };
      },
    );
  },
);

// ============================================================================
// Send Invoice Email
// ============================================================================

const sendInvoiceEmailSchema = z.object({
  invoiceId: z.string().uuid(),
  to: z.string().email(),
  subject: z.string().optional(),
  memo: z.string().optional(),
  fromCompany: z.string().optional(),
  fromEmail: z.string().optional(),
});

export const sendInvoiceEmailFn = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    const emailPayload = await withMutationPermissionOrgContext(
      "invoice",
      "send",
      { routeKey: "invoice:send", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { invoiceId, to, subject, memo, fromCompany, fromEmail } =
          sendInvoiceEmailSchema.parse(rawData);

        // Fetch invoice details (full set for the PDF attachment)
        const [invoice] = await db
          .select({
            invoiceNumber: invoices.invoiceNumber,
            issueDate: invoices.issueDate,
            dueDate: invoices.dueDate,
            status: invoices.status,
            customerId: invoices.customerId,
            subtotal: invoices.subtotal,
            discountAmount: invoices.discountAmount,
            taxAmount: invoices.taxAmount,
            total: invoices.total,
            amountPaid: invoices.amountPaid,
            balanceDue: invoices.balanceDue,
            notes: invoices.notes,
            paymentTerms: invoices.paymentTerms,
          })
          .from(invoices)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
          .for("update");

        if (!invoice) {
          throw new Error("Invoice not found");
        }

        // Get customer name
        const [customer] = await db
          .select({ name: parties.name })
          .from(parties)
          .where(eq(parties.id, invoice.customerId));

        // Line items for the PDF
        const pdfLineItems = await db
          .select({
            description: invoiceLineItems.description,
            quantity: invoiceLineItems.quantity,
            unitPrice: invoiceLineItems.unitPrice,
            amount: invoiceLineItems.amount,
          })
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoiceId))
          .orderBy(invoiceLineItems.sortOrder);

        // Fetch org settings for email config (sender name, sender email, resend API key)
        const [org] = await db
          .select({
            name: organization.name,
            metadata: organization.metadata,
          })
          .from(organization)
          .where(eq(organization.id, orgId))
          .limit(1);

        const orgMeta = parseOrgMetadata(org?.metadata);
        const orgSecrets = await getOrganizationSecrets(db, orgId);

        // Resolve sender name: fromCompany param > org email setting > org name > brand default
        const resolvedFromCompany =
          fromCompany || orgMeta.emailSenderName || org?.name || serverBrand.appName;

        // Resolve sender email: fromEmail param > org email setting > owner email
        let resolvedFromEmail = fromEmail || orgMeta.emailSenderEmail || "";
        if (!resolvedFromEmail) {
          // Fallback to owner's email
          const [ownerRow] = await db
            .select({ email: user.email })
            .from(member)
            .innerJoin(user, eq(member.userId, user.id))
            .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
            .limit(1);
          resolvedFromEmail = ownerRow?.email ?? "";
        }

        // Build the invoice PDF attachment.
        const { invoicePdfBuffer } = await import("../../lib/generate-invoice-pdf");
        const invoiceCurrency = await resolveFunctionalCurrency(db, orgId);
        const pdfContent = invoicePdfBuffer({
          currency: invoiceCurrency,
          invoiceNumber: invoice.invoiceNumber,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          status: invoice.status,
          orgName: resolvedFromCompany,
          customerName: customer?.name ?? null,
          lineItems: pdfLineItems.map((li) => ({
            description: li.description,
            quantity: String(li.quantity),
            unitPrice: String(li.unitPrice),
            amount: String(li.amount),
          })),
          subtotal: String(invoice.subtotal),
          discountAmount: String(invoice.discountAmount ?? "0"),
          taxAmount: String(invoice.taxAmount ?? "0"),
          total: String(invoice.total),
          amountPaid: String(invoice.amountPaid ?? "0"),
          balanceDue: String(invoice.balanceDue),
          notes: invoice.notes,
          paymentTerms: invoice.paymentTerms,
        }).toString("base64");

        // Transition to sent + create A/R journal entry if still in draft
        const [currentInvoice] = await db
          .select({
            id: invoices.id,
            status: invoices.status,
            invoiceNumber: invoices.invoiceNumber,
            customerId: invoices.customerId,
            issueDate: invoices.issueDate,
            subtotal: invoices.subtotal,
            discountAmount: invoices.discountAmount,
            taxAmount: invoices.taxAmount,
            total: invoices.total,
            journalHeaderId: invoices.journalHeaderId,
          })
          .from(invoices)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
          .for("update");

        if (!currentInvoice) {
          throw new Error("Invoice not found");
        }

        // Emailing an invoice only advances draft → sent. A paid/voided invoice must not
        // silently revert to "sent" (that previously re-opened it for a second payment).
        const emailAllowsTransition =
          currentInvoice.status === "draft" || currentInvoice.status === "sent";
        if (!emailAllowsTransition) {
          throw new Error(
            `Cannot re-send invoice ${currentInvoice.invoiceNumber}: status is "${currentInvoice.status}".`,
          );
        }

        let journalHeaderId: string | undefined;

        // Create A/R journal entry if this is the first send (no journal yet)
        if (!currentInvoice.journalHeaderId) {
          journalHeaderId = await createArJournalEntry(db, orgId, userId, {
            id: currentInvoice.id,
            invoiceNumber: currentInvoice.invoiceNumber,
            customerId: currentInvoice.customerId,
            issueDate: currentInvoice.issueDate,
            total: currentInvoice.total,
            subtotal: currentInvoice.subtotal,
            discountAmount: currentInvoice.discountAmount,
            taxAmount: currentInvoice.taxAmount,
          });
        }

        await db
          .update(invoices)
          .set({
            status: "sent",
            sentAt: new Date(),
            updatedAt: new Date(),
            ...(journalHeaderId ? { journalHeaderId } : {}),
          })
          .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)));

        return {
          to,
          invoiceNumber: invoice.invoiceNumber,
          customerName: customer?.name ?? "Customer",
          total: String(invoice.total),
          // The organization's own books currency. The email template used to
          // hard-code a "$", so a PHP invoice reached the customer denominated
          // in dollars.
          currency: invoiceCurrency,
          dueDate: invoice.dueDate,
          fromCompany: resolvedFromCompany,
          pdfAttachment: {
            filename: `Invoice-${invoice.invoiceNumber}.pdf`,
            content: pdfContent,
          },
          fromEmail: resolvedFromEmail || undefined,
          subject,
          memo,
          invoiceId,
          resendApiKey: orgSecrets.resendApiKey || undefined,
        };
      },
    );
    // Ledger/status commit succeeds before external delivery is attempted. A mail-provider
    // outage can now be retried without creating a second accrual journal.
    await sendEmail(emailPayload);
    return { success: true };
  },
);
