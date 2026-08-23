/**
 * Bills API Server Functions
 * ABAC-protected CRUD + workflow transitions for Bill Pay (Accounts Payable)
 */
import { createServerFn } from "@tanstack/react-start";
import type { DbExecutor } from "../../db";

import { bills, billLineItems } from "../../db/schema/bills";
import { parties } from "../../db/schema/parties";
import { accounts } from "../../db/schema/accounts";
import { journalHeaders, journalLines } from "../../db/schema/journals";
import { activityLogs } from "../../db/schema/activity-logs";
import { eq, desc, and, asc } from "drizzle-orm";
import { z } from "zod";
import { createLogger } from "../../lib/logger";
import { insertActivityLog } from "../../lib/insert-activity-log";
import { getClosedThrough, isDateLocked } from "../../lib/period-close";
import { postBillAccrualJournal } from "../../lib/bill-journal";
import { sumMoney } from "../../lib/inbox/money";
import { statementLines, reconciliations } from "../../db/schema/reconciliations";
import { inArray } from "drizzle-orm";
import { isR2Configured, getPresignedDownloadUrl } from "../../lib/storage";
import { documents, documentAttachments } from "../../db/schema/documents";
import { ensureDocument } from "../../lib/documents/ensure-document";
import {
  assertIdempotencyPayloadMatches,
  idempotencyPayloadHash,
  scopedIdempotencyUuid,
} from "../../lib/idempotency";
import { centsToMoney, moneyToCents } from "../../lib/money";
import {
  assertBillReferences,
  assertBillFinanciallyEditable,
  deriveBillBalanceDue,
} from "../../lib/bill-mutation-guards";
import {
  beginAccountingOperation,
  completeAccountingOperation,
} from "../../lib/operational-idempotency";
import { assertRolePermission } from "../../lib/auth-middleware";
import { journalsClearedByFinalizedReconciliation } from "../../lib/reconciliation-claimed-lines";
import { recordManualBillPayment } from "../../lib/manual-bill-payment";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
  withSessionOrgContext,
} from "../../lib/server-context";
import { extractBoundingBoxes } from "./-ai-bill-ocr";
import { generateThumbnail } from "@/services/thumbnail-generator";
import { createTransactionCandidate } from "@/lib/inbox/service";
import { requireMappedAccountId } from "../../lib/coa/resolve-mapped-account";
import {
  inboxItems,
  integrationSources,
  reviewFindings,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";

const logger = createLogger("api.bills");

// ============================================================================
// Constants
// ============================================================================

const BILL_STATUSES = [
  "draft",
  "in_review",
  "pending_approval",
  "approved",
  "awaiting_payment",
  "scheduled",
  "partial",
  "paid",
  "voided",
] as const;

/** Valid state transitions for the bill workflow
 *
 * Simplified flow:
 *   Upload → In Review → (optional) Pending Approval → Awaiting Payment → Paid
 *
 * Key shortcuts:
 *   - Owner can pay directly from in_review (skip approval entirely)
 *   - Self-approve from in_review goes straight to awaiting_payment
 *   - "Approve" from pending_approval goes to awaiting_payment (no separate "approved" step)
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["in_review", "voided"],
  in_review: ["pending_approval", "awaiting_payment", "paid", "partial", "voided"],
  pending_approval: ["awaiting_payment", "in_review", "voided"],
  approved: ["awaiting_payment", "in_review"], // legacy — treat as alias for awaiting_payment
  // voided is reachable from the accrued-but-unpaid states: a mistaken bill
  // most often sits exactly here, and the old table made it unvoidable.
  awaiting_payment: ["scheduled", "paid", "partial", "voided"],
  scheduled: ["paid", "partial", "voided"],
  partial: ["paid", "partial", "voided"], // additional partial payments
  paid: ["voided"], // allow voiding paid bills for corrections
  voided: [],
};

const JOURNAL_PRODUCING_BILL_STATUSES = new Set(["awaiting_payment", "scheduled"]);

// ============================================================================
// Schemas
// ============================================================================

const listBillsSchema = z.object({
  status: z.enum(BILL_STATUSES).optional(),
  vendorId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(250).optional().default(100),
});

const getBillSchema = z.object({
  id: z.string().uuid(),
});

const createBillSchema = z.object({
  idempotencyKey: z.string().uuid(),
  vendorId: z.string().uuid(),
  billNumber: z.string().optional(),
  billDate: z.string(),
  dueDate: z.string(),
  memo: z.string().optional(),
  documentUrl: z.string().optional(),
  documentType: z.string().optional(),
  status: z.enum(["draft", "in_review"]).optional().default("in_review"),
  isRecurring: z.boolean().optional(),
  recurringFrequency: z.string().optional(),
  categoryConfidence: z.string().optional(),
  classificationStatus: z.enum(["auto", "needs_review", "manual"]).optional(),
  ocrBoundingBoxes: z
    .array(
      z.object({
        fieldId: z.string(),
        label: z.string(),
        text: z.string().optional(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        page: z.number(),
      }),
    )
    .optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().optional(),
        // Stored as a decimal string; must be a positive number — a negative
        // bill line strands the bill as unpayable (audit, AR/AP).
        amount: z
          .string()
          .regex(/^\d+(?:\.\d+)?$/, "Line amount must be a non-negative number")
          .refine((v) => Number(v) > 0, "Line amount must be greater than zero"),
        accountId: z.string().uuid(),
        departmentId: z.string().uuid().optional(),
        locationId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});

const updateBillSchema = z.object({
  id: z.string().uuid(),
  billNumber: z.string().optional(),
  billDate: z.string().optional(),
  dueDate: z.string().optional(),
  memo: z.string().optional(),
  // Same discipline as line amounts: a negative or non-numeric header amount
  // strands the bill as unpayable.
  amount: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/, "Amount must be a non-negative number")
    .optional(),
  approverId: z.string().optional(), // better-auth uses text IDs, not UUIDs
});

const transitionStatusSchema = z.object({
  billId: z.string().uuid(),
  newStatus: z.enum(BILL_STATUSES),
  idempotencyKey: z.string().uuid().optional(),
  paymentMethod: z.string().optional(),
  paymentReference: z.string().optional(),
  bankAccountId: z.string().uuid().optional(), // Required when newStatus === 'paid' or 'partial'
  paymentAmount: z.string().or(z.number()).optional(), // For partial payments — omit for full balance
  // The day the payment actually happened. Without it every manual payment
  // was journaled on the day it was KEYED IN — a cheque cleared 28 July and
  // entered 3 August posted into August, and the period-lock guard never
  // fired because the date was always today.
  paymentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "paymentDate must be YYYY-MM-DD")
    .optional(),
  ewtWithheld: z.string().optional(),
});

const deleteBillSchema = z.object({
  id: z.string().uuid(),
});

// ============================================================================
// Types
// ============================================================================

export type BillListItem = typeof bills.$inferSelect & {
  vendorName: string | null;
};

export type BillDetail = typeof bills.$inferSelect & {
  vendorName: string | null;
  vendorEmail: string | null;
  vendorPhone: string | null;
  previewImageUrl: string | null;
  vendorBankRouting: string | null;
  vendorBankAccount: string | null;
  vendorMailingAddress: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  } | null;
  lineItems: Array<
    typeof billLineItems.$inferSelect & {
      accountName: string;
      accountNumber: string | null;
    }
  >;
};

// ============================================================================
// Server Functions
// ============================================================================

/**
 * List bills with optional status/vendor filters
 */
export const listBills = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = listBillsSchema.parse(rawData ?? {});
      const { status, vendorId, limit } = parsed;

      const conditions = [eq(bills.organizationId, orgId)];
      if (status) {
        conditions.push(eq(bills.status, status));
      }
      if (vendorId) {
        conditions.push(eq(bills.vendorId, vendorId));
      }

      const rows = await db
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
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(bills.dueDate))
        .limit(limit);

      return rows;
    });
  },
);

/**
 * Get a single bill with line items and vendor info
 */
export const getBill = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("bill", "view", async ({ orgId, db }) => {
      const parsed = getBillSchema.parse(rawData);

      const [bill] = await db
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
          vendorEmail: parties.email,
          vendorPhone: parties.phone,
          vendorBankRouting: parties.bankRoutingNumber,
          vendorBankAccount: parties.bankAccountNumber,
          vendorMailingAddress: parties.mailingAddress,
        })
        .from(bills)
        .leftJoin(parties, eq(bills.vendorId, parties.id))
        .where(and(eq(bills.id, parsed.id), eq(bills.organizationId, orgId)))
        .limit(1);

      if (!bill) {
        throw new Error("Bill not found");
      }

      let resolvedDocumentUrl = bill.documentUrl;
      if (bill.documentUrl?.startsWith("r2://") && isR2Configured()) {
        const r2Path = bill.documentUrl.replace(/^r2:\/\/[^/]+\//, "");
        resolvedDocumentUrl = await getPresignedDownloadUrl(r2Path, { expiresIn: 3600 });
      } else if (bill.documentUrl?.startsWith("local://")) {
        const localPath = bill.documentUrl.replace("local://", "");
        resolvedDocumentUrl = `/uploads/${localPath.split("/").pop()}`;
      }

      let previewImageUrl: string | null = null;
      if (isR2Configured()) {
        const attachment = await db
          .select({ previewImageR2Key: documents.previewImageR2Key })
          .from(documentAttachments)
          .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
          .where(
            and(
              eq(documentAttachments.linkableId, parsed.id),
              eq(documentAttachments.linkableType, "bill"),
            ),
          )
          .limit(1);

        const previewKey = attachment[0]?.previewImageR2Key;
        if (previewKey) {
          previewImageUrl = await getPresignedDownloadUrl(previewKey, { expiresIn: 3600 });
        }
      }

      const lineItems = await db
        .select({
          id: billLineItems.id,
          billId: billLineItems.billId,
          description: billLineItems.description,
          amount: billLineItems.amount,
          accountId: billLineItems.accountId,
          departmentId: billLineItems.departmentId,
          locationId: billLineItems.locationId,
          sortOrder: billLineItems.sortOrder,
          createdAt: billLineItems.createdAt,
          accountName: accounts.name,
          accountNumber: accounts.accountNumber,
        })
        .from(billLineItems)
        .innerJoin(accounts, eq(billLineItems.accountId, accounts.id))
        .where(eq(billLineItems.billId, parsed.id))
        .orderBy(asc(billLineItems.sortOrder));

      return { ...bill, documentUrl: resolvedDocumentUrl, previewImageUrl, lineItems };
    });
  },
);

/**
 * Create a new bill with line items
 */
export const createBill = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "create",
      { routeKey: "bill:create", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const parsed = createBillSchema.parse(rawData);
        // Org-ownership and account-type checks BEFORE anything persists —
        // the invoice path has had this since assertInvoiceReferences; bills
        // accepted any UUID.
        await assertBillReferences(db, orgId, parsed.vendorId, parsed.lineItems);

        // Exact summation. Float `reduce` + `.toFixed(2)` drifted from the
        // raw line amounts, so a bill whose lines carry more than two decimals
        // produced an A/P credit that did not equal the debits it offsets —
        // an unbalanced journal, which the ledger now rejects outright (0038).
        const totalAmount = sumMoney(parsed.lineItems.map((l) => l.amount));
        const requestPayloadHash = idempotencyPayloadHash("bill-submission", {
          vendorId: parsed.vendorId,
          billNumber: parsed.billNumber,
          billDate: parsed.billDate,
          dueDate: parsed.dueDate,
          memo: parsed.memo,
          documentUrl: parsed.documentUrl,
          documentType: parsed.documentType,
          status: parsed.status,
          isRecurring: parsed.isRecurring,
          recurringFrequency: parsed.recurringFrequency,
          categoryConfidence: parsed.categoryConfidence,
          classificationStatus: parsed.classificationStatus,
          ocrBoundingBoxes: parsed.ocrBoundingBoxes,
          lineItems: parsed.lineItems,
        });
        const billId = scopedIdempotencyUuid(`bill:${orgId}`, parsed.idempotencyKey);

        return db.transaction(async (tx) => {
          const [bill] = await tx
            .insert(bills)
            .values({
              id: billId,
              organizationId: orgId,
              vendorId: parsed.vendorId,
              billNumber: parsed.billNumber,
              billDate: parsed.billDate,
              dueDate: parsed.dueDate,
              memo: parsed.memo,
              documentUrl: parsed.documentUrl,
              documentType: parsed.documentType,
              amount: totalAmount,
              balanceDue: totalAmount,
              status: parsed.status ?? "in_review",
              isRecurring: parsed.isRecurring ?? false,
              recurringFrequency: parsed.recurringFrequency,
              categoryConfidence: parsed.categoryConfidence,
              classificationStatus: parsed.classificationStatus ?? "manual",
              ocrBoundingBoxes: parsed.ocrBoundingBoxes ?? null,
            })
            .onConflictDoNothing()
            .returning();

          if (!bill) {
            const [existing] = await tx
              .select()
              .from(bills)
              .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
              .limit(1);
            if (!existing) {
              throw new Error("Unable to persist bill submission");
            }
            const [existingRequest] = await tx
              .select({ sourceRawData: sourceRecords.rawData })
              .from(transactionCandidates)
              .leftJoin(sourceRecords, eq(transactionCandidates.sourceRecordId, sourceRecords.id))
              .where(
                and(
                  eq(transactionCandidates.organizationId, orgId),
                  eq(transactionCandidates.requestIdempotencyKey, parsed.idempotencyKey),
                ),
              )
              .limit(1);
            assertIdempotencyPayloadMatches(
              existingRequest?.sourceRawData?.requestPayloadHash,
              requestPayloadHash,
              "bill",
            );
            await tx
              .insert(workflowEvents)
              .values({
                organizationId: orgId,
                entityType: "bill",
                entityId: existing.id,
                action: "exact_replay_suppressed",
                actorType: "user",
                actorId: userId,
                idempotencyKey: `exact-replay:bill:${existing.id}`,
                data: {
                  replayType: "request_idempotency",
                  sourceChannel: "bills_expenses",
                },
              })
              .onConflictDoNothing();
            return { ...existing, deduplicated: true };
          }

          if (parsed.lineItems.length > 0) {
            await tx.insert(billLineItems).values(
              parsed.lineItems.map((line, i) => ({
                billId: bill.id,
                description: line.description,
                amount: line.amount,
                accountId: line.accountId,
                departmentId: line.departmentId,
                locationId: line.locationId,
                sortOrder: i,
              })),
            );
          }

          await insertActivityLog(
            {
              orgId,
              entityType: "bill",
              entityId: bill.id,
              action: "created",
              actorId: userId,
              changes: {
                vendorId: parsed.vendorId,
                billNumber: parsed.billNumber ?? null,
                billDate: parsed.billDate,
                dueDate: parsed.dueDate,
                totalAmount,
                status: parsed.status ?? "in_review",
                lineItemCount: parsed.lineItems.length,
              },
            },
            tx,
          );

          const apAccountId = await resolveApAccount(tx, orgId);
          const inboxResult = await createTransactionCandidate(
            { orgId, userId, role, db: tx },
            {
              transactionDate: bill.billDate,
              transactionType: "journal",
              memo: parsed.memo || `Bill ${bill.billNumber || bill.id}`,
              referenceNumber: bill.billNumber,
              partyId: bill.vendorId,
              sourceChannel: "bills_expenses",
              sourceProvider: "internal_bills",
              requestIdempotencyKey: parsed.idempotencyKey,
              requestPayloadHash,
              externalId: bill.id,
              candidateType: "bill",
              lines: [
                ...parsed.lineItems.map((line, index) => ({
                  accountId: line.accountId,
                  debit: line.amount,
                  lineDescription: line.description,
                  departmentId: line.departmentId,
                  locationId: line.locationId,
                  categoryConfidence: parsed.categoryConfidence,
                  sortOrder: index,
                })),
                {
                  accountId: apAccountId,
                  credit: totalAmount,
                  lineDescription: `A/P: ${bill.billNumber || "Bill"}`,
                  partyId: bill.vendorId,
                  sortOrder: parsed.lineItems.length,
                },
              ],
            },
          );

          return { ...bill, inboxItemId: inboxResult.inboxItem.id, deduplicated: false };
        });
      },
    ) as any;
  },
);

/**
 * Update bill metadata
 */
export const updateBill = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "update",
      { routeKey: "bill:update", limit: 45, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = updateBillSchema.parse(rawData);
        const { id, ...updates } = parsed;

        const [existing] = await db
          .select()
          .from(bills)
          .where(and(eq(bills.id, id), eq(bills.organizationId, orgId)))
          .limit(1);

        if (!existing) {
          throw new Error("Bill not found");
        }

        const updateFields: Record<string, any> = { updatedAt: new Date() };
        if (updates.billNumber !== undefined) updateFields.billNumber = updates.billNumber;
        if (updates.billDate !== undefined) updateFields.billDate = updates.billDate;
        if (updates.dueDate !== undefined) updateFields.dueDate = updates.dueDate;
        if (updates.memo !== undefined) updateFields.memo = updates.memo;
        if (updates.amount !== undefined) {
          // Amount edits are only legal pre-posting/pre-payment (the
          // partial-payment-then-raise-amount exploit); balanceDue is derived
          // in integer cents and floored at zero, never float math.
          assertBillFinanciallyEditable(existing);
          updateFields.amount = updates.amount;
          updateFields.balanceDue = deriveBillBalanceDue(updates.amount, existing.amountPaid);
        }
        if (updates.approverId !== undefined) updateFields.approverId = updates.approverId;

        const [updated] = await db
          .update(bills)
          .set(updateFields)
          .where(and(eq(bills.id, id), eq(bills.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  },
);

// ============================================================================
// Helpers
// ============================================================================

/** Resolve the organization's Accounts Payable account via the configured mapping. */
async function resolveApAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "bill", "accounts_payable");
}

async function linkBillDocumentToCandidate(
  db: DbExecutor,
  orgId: string,
  billId: string,
  documentId: string,
) {
  const [candidateSource] = await db
    .select({
      sourceRecordId: sourceRecords.id,
      candidateId: transactionCandidates.id,
      inboxItemId: inboxItems.id,
      lockVersion: inboxItems.lockVersion,
    })
    .from(sourceRecords)
    .innerJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
    .innerJoin(transactionCandidates, eq(transactionCandidates.sourceRecordId, sourceRecords.id))
    .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
    .where(
      and(
        eq(sourceRecords.organizationId, orgId),
        eq(sourceRecords.externalId, billId),
        eq(integrationSources.provider, "internal_bills"),
      ),
    )
    .limit(1);
  if (!candidateSource) return;
  await db
    .insert(sourceRecordDocuments)
    .values({
      organizationId: orgId,
      sourceRecordId: candidateSource.sourceRecordId,
      documentId,
      relationship: "invoice",
    })
    .onConflictDoNothing();
  await db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedAt: new Date(),
      resolutionNote: "Invoice attached to the bill source.",
    })
    .where(
      and(
        eq(reviewFindings.candidateId, candidateSource.candidateId),
        eq(reviewFindings.ruleKey, "missing_invoice"),
        eq(reviewFindings.state, "open"),
      ),
    );
  await db
    .update(inboxItems)
    .set({
      lockVersion: candidateSource.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.id, candidateSource.inboxItemId));
}

/**
 * Generate a sequential transaction number for journal entries.
 */
/**
 * Transition bill status with validation
 */
export const transitionBillStatus = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "update",
      { routeKey: "bill:transition", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const parsed = transitionStatusSchema.parse(rawData);
        const {
          billId,
          newStatus,
          idempotencyKey,
          paymentMethod,
          paymentReference,
          bankAccountId,
          paymentAmount,
          paymentDate,
          ewtWithheld,
        } = parsed;

        if ((newStatus === "paid" || newStatus === "partial") && !bankAccountId) {
          throw new Error("bankAccountId is required when recording a bill payment");
        }
        if ((newStatus === "paid" || newStatus === "partial") && !idempotencyKey) {
          throw new Error(
            "A caller-generated idempotencyKey is required for journal-producing bill transitions.",
          );
        }
        if (newStatus === "paid" || newStatus === "partial") {
          // The endpoint gates on bill:update because most transitions here are
          // ordinary status edits. Recording a payment is not one of those — it
          // writes a journal and moves money — and `bill:pay` exists precisely
          // to withhold that from roles allowed to edit a bill. Checked here
          // rather than on the wrapper so non-payment transitions keep needing
          // only update.
          assertRolePermission(role, "bill", "pay");
          return recordManualBillPayment(db, {
            organizationId: orgId,
            userId,
            billId,
            requestedStatus: newStatus,
            bankAccountId: bankAccountId!,
            paymentAmount,
            paymentMethod,
            paymentReference,
            paymentDate,
            idempotencyKey: idempotencyKey!,
            ewtWithheld,
          });
        }
        const canonicalPaymentAmount =
          paymentAmount == null
            ? null
            : centsToMoney(moneyToCents(paymentAmount, "Payment amount"));
        if (
          canonicalPaymentAmount != null &&
          moneyToCents(canonicalPaymentAmount, "Payment amount") <= 0
        ) {
          throw new Error("Payment amount must be positive");
        }

        const [bill] = await db
          .select()
          .from(bills)
          .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
          .limit(1)
          .for("update");

        if (!bill) {
          throw new Error("Bill not found");
        }
        const requiresIdempotency =
          JOURNAL_PRODUCING_BILL_STATUSES.has(newStatus) ||
          (newStatus === "voided" && bill.journalHeaderId !== null);
        if (requiresIdempotency && !idempotencyKey) {
          throw new Error(
            "A caller-generated idempotencyKey is required for journal-producing bill transitions.",
          );
        }

        const operation = requiresIdempotency
          ? await beginAccountingOperation(db, {
              organizationId: orgId,
              operationType: "bill-status-transition",
              entityType: "bill",
              entityId: billId,
              idempotencyKey: idempotencyKey!,
              payload: {
                billId,
                newStatus,
                paymentMethod: paymentMethod ?? null,
                paymentReference: paymentReference ?? null,
                bankAccountId: bankAccountId ?? null,
                paymentAmount: canonicalPaymentAmount,
              },
              actorId: userId,
            })
          : null;
        if (operation?.replayed) {
          return {
            ...bill,
            deduplicated: true,
            operationId: operation.operation.id,
            operationJournalHeaderId: operation.operation.journalHeaderId,
          };
        }

        const allowed = VALID_TRANSITIONS[bill.status];
        if (!allowed || !allowed.includes(newStatus)) {
          throw new Error(`Cannot transition from "${bill.status}" to "${newStatus}"`);
        }

        const updateFields: Record<string, any> = {
          status: newStatus,
          updatedAt: new Date(),
        };
        let operationJournalHeaderId: string | null = null;

        if (newStatus === "approved") {
          updateFields.approvedAt = new Date();
        }

        if (newStatus === "awaiting_payment" || newStatus === "scheduled") {
          const journalId = await postBillAccrualJournal(db, {
            organizationId: orgId,
            userId,
            bill,
          });
          updateFields.journalHeaderId = journalId;
          operationJournalHeaderId = journalId;
        }

        // ═══════════════════════════════════════════════════════════════
        // VOIDED — void the posted journals only. NO reversal.
        //
        // Reports and the projection aggregate `status = 'posted'` rows only,
        // so flipping the source journals to "voided" already removes their
        // effect entirely. This branch ALSO posted a full mirrored reversal,
        // which subtracted the same amount a second time — every voided bill
        // understated its period by the bill's value. The invoice path fixed
        // exactly this and its comment calls it "the historical bug"; the bill
        // path kept it.
        //
        // It also skipped the period lock that bill-delete and invoice-void
        // both check, so a bill accrued in a filed month could be removed from
        // that month after the return was filed.
        // ═══════════════════════════════════════════════════════════════
        if (newStatus === "voided") {
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

          if (linkedJournals.some((journal) => journal.duplicateOfHeaderId !== null)) {
            throw new Error(
              "Cannot void bill: a linked journal is a suppressed duplicate. Unmatch it first.",
            );
          }

          const closedThrough = await getClosedThrough(orgId, db);
          const inLocked = linkedJournals.find((journal) =>
            isDateLocked(journal.transactionDate, closedThrough),
          );
          if (inLocked) {
            throw new Error(
              `Cannot void bill: its journal dated ${inLocked.transactionDate} falls in a period locked through ${closedThrough}. Open the period first.`,
            );
          }

          // Same rule as invoice void, batch delete and transaction void: a
          // journal cleared by a FINALIZED reconciliation cannot be voided out
          // from under it — the reconciliation's snapshot would no longer
          // reproduce, with nothing recording why.
          if (
            await journalsClearedByFinalizedReconciliation(
              db,
              orgId,
              linkedJournals.map((journal) => journal.id),
            )
          ) {
            throw new Error(
              "Cannot void bill: a linked journal is locked by a finalized reconciliation.",
            );
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
              changes: { reason: "bill_voided", billId },
            });
          }
        }

        await db.insert(activityLogs).values({
          organizationId: orgId,
          entityType: "bill",
          entityId: billId,
          action: "status_changed",
          actorId: userId,
          changes: {
            previousStatus: bill.status,
            newStatus: updateFields.status,
            ...(bankAccountId ? { bankAccountId } : {}),
            ...(canonicalPaymentAmount != null ? { paymentAmount: canonicalPaymentAmount } : {}),
          },
        });

        const [updated] = await db
          .update(bills)
          .set(updateFields)
          .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
          .returning();

        if (operation) {
          await completeAccountingOperation(db, {
            operationId: operation.operation.id,
            journalHeaderId: operationJournalHeaderId,
            result: {
              billId,
              previousStatus: bill.status,
              status: updated.status,
              amountPaid: updated.amountPaid,
              balanceDue: updated.balanceDue,
              billJournalHeaderId: updated.journalHeaderId,
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
  },
);

/**
 * Delete a bill — only allowed for draft/in_review bills.
 * If the bill has posted journal entries, void them instead of deleting.
 */
export const deleteBill = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "delete",
      { routeKey: "bill:delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = deleteBillSchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(bills)
          .where(and(eq(bills.id, parsed.id), eq(bills.organizationId, orgId)))
          .limit(1);

        if (!existing) {
          throw new Error("Bill not found");
        }

        const linkedJournals = await db
          .select()
          .from(journalHeaders)
          .where(
            and(
              eq(journalHeaders.sourceDocumentId, parsed.id),
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
          const closedThrough = await getClosedThrough(orgId);
          const inLocked = linkedJournals.find((j) =>
            isDateLocked(j.transactionDate, closedThrough),
          );
          if (inLocked) {
            throw new Error(
              `Cannot delete bill: its journal dated ${inLocked.transactionDate} falls in a period locked through ${closedThrough}. Open the period first.`,
            );
          }

          const journalIds = linkedJournals.map((j) => j.id);
          const reconciled = await db
            .select({ id: statementLines.id })
            .from(statementLines)
            .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
            .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
            .where(
              and(
                inArray(journalLines.journalHeaderId, journalIds),
                eq(reconciliations.status, "finalized"),
              ),
            )
            .limit(1);
          if (reconciled.length > 0) {
            throw new Error(
              "Cannot delete bill: its journal is locked by a finalized reconciliation.",
            );
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
            changes: { reason: "bill_deleted", billId: parsed.id },
          });
        }

        await db
          .delete(documentAttachments)
          .where(
            and(
              eq(documentAttachments.linkableId, parsed.id),
              eq(documentAttachments.linkableType, "bill"),
              eq(documentAttachments.organizationId, orgId),
            ),
          );

        await db.delete(bills).where(and(eq(bills.id, parsed.id), eq(bills.organizationId, orgId)));

        return { success: true };
      },
    );
  },
);

// ============================================================================
// Create Draft Bill (minimal placeholder before OCR)
// ============================================================================

const createDraftBillSchema = z.object({
  filename: z.string().optional(),
});

/**
 * Create a draft bill placeholder — used before OCR processing completes.
 * Requires: bill:create permission
 */
export const createDraftBill = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "create",
      { routeKey: "bill:create-draft", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createDraftBillSchema.parse(rawData);

        const [bill] = await db
          .insert(bills)
          .values({
            organizationId: orgId,
            billDate: new Date().toISOString().split("T")[0],
            dueDate: new Date().toISOString().split("T")[0],
            amount: "0.00",
            balanceDue: "0.00",
            status: "draft",
            memo: parsed.filename ? `Uploading: ${parsed.filename}` : "Processing…",
          })
          .returning();

        return bill;
      },
    );
  },
);

// ============================================================================
// Upload Bill Document (to R2 storage)
// ============================================================================

const MAX_BASE64_SIZE = Math.ceil(20 * 1024 * 1024 * 1.4); // ~20 MB file → ~28 MB base64

const uploadBillDocumentSchema = z.object({
  billId: z.string().uuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileBase64: z.string().min(1).max(MAX_BASE64_SIZE, "File exceeds maximum allowed size"),
});

/**
 * Upload a bill's document to R2 storage and link it.
 * Falls back to a local storage path if R2 is not configured.
 * Requires: bill:create permission
 */
export const uploadBillDocument = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "create",
      { routeKey: "bill:upload", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = uploadBillDocumentSchema.parse(rawData);

        const [bill] = await db
          .select()
          .from(bills)
          .where(and(eq(bills.id, parsed.billId), eq(bills.organizationId, orgId)))
          .limit(1);

        if (!bill) {
          throw new Error("Bill not found");
        }

        const fileBuffer = Buffer.from(parsed.fileBase64, "base64");
        const ensured = await ensureDocument(db, {
          organizationId: orgId,
          uploadedById: userId,
          filename: parsed.filename,
          contentType: parsed.contentType,
          fileBuffer,
          documentType: "bill",
        });
        const documentUrl = ensured.document.storagePath;

        await db
          .delete(documentAttachments)
          .where(
            and(
              eq(documentAttachments.linkableId, parsed.billId),
              eq(documentAttachments.linkableType, "bill"),
              eq(documentAttachments.organizationId, orgId),
            ),
          );

        const ext = parsed.filename.split(".").pop()?.toLowerCase() || "other";
        const [updatedBill] = await db
          .update(bills)
          .set({
            documentUrl,
            documentType: ext === "pdf" ? "pdf" : "image",
            ocrBoundingBoxes: null,
            classificationStatus: "needs_review",
            updatedAt: new Date(),
          })
          .where(eq(bills.id, parsed.billId))
          .returning();

        if (!updatedBill) {
          logger.error("Failed to update bill after document upload", { billId: parsed.billId });
          throw new Error("Failed to update bill with new document");
        }

        await db.insert(documentAttachments).values({
          organizationId: orgId,
          documentId: ensured.document.id,
          linkableType: "bill",
          linkableId: parsed.billId,
        });

        await linkBillDocumentToCandidate(db, orgId, parsed.billId, ensured.document.id);

        if (!ensured.deduplicated) {
          generateThumbnail(ensured.document.id, orgId).catch((err) =>
            logger.error("Bill document thumbnail generation failed", {
              error: err,
              billId: parsed.billId,
            }),
          );
        }

        return {
          success: true,
          document: ensured.document,
          documentUrl,
          documentId: ensured.document.id,
          deduplicated: ensured.deduplicated,
        };
      },
    ) as any;
  },
);

// ============================================================================
// Upload Document for Bill (without bill ID — for parallel background upload)
// ============================================================================

const uploadDocForBillSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileBase64: z.string().min(1).max(MAX_BASE64_SIZE, "File exceeds maximum allowed size"),
});

/**
 * Upload a bill document to R2 without requiring a bill ID.
 * Used by background processing: file is uploaded in parallel with AI OCR,
 * then linked to the bill after it's created.
 * Requires: bill:create permission
 */
export const uploadDocumentForBill = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "create",
      { routeKey: "bill:upload-pending", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = uploadDocForBillSchema.parse(rawData);

        const fileBuffer = Buffer.from(parsed.fileBase64, "base64");
        const ensured = await ensureDocument(db, {
          organizationId: orgId,
          uploadedById: userId,
          filename: parsed.filename,
          contentType: parsed.contentType,
          fileBuffer,
          documentType: "bill",
        });

        if (!ensured.deduplicated) {
          generateThumbnail(ensured.document.id, orgId).catch((err) =>
            logger.error("Pending bill document thumbnail generation failed", {
              error: err,
              filename: parsed.filename,
            }),
          );
        }

        return {
          success: true,
          document: ensured.document,
          documentUrl: ensured.document.storagePath,
          documentId: ensured.document.id,
          deduplicated: ensured.deduplicated,
        };
      },
    ) as any;
  },
);

// ============================================================================
// Link Document to Bill (post-creation)
// ============================================================================

const linkDocToBillSchema = z.object({
  billId: z.string().uuid(),
  documentId: z.string().uuid(),
});

/**
 * Link a previously uploaded document to a bill and update the bill's documentUrl.
 * Used after background processing creates the bill.
 * Requires: bill:create permission
 */
export const linkDocumentToBill = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "create",
      { routeKey: "bill:link-document", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = linkDocToBillSchema.parse(rawData);

        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, parsed.documentId), eq(documents.organizationId, orgId)))
          .limit(1);

        if (!doc) {
          throw new Error("Document not found");
        }

        const ext = doc.originalFilename?.split(".").pop()?.toLowerCase() || "other";

        // Fetch the bill to get its OCR bounding boxes, to sync them to the document
        const [bill] = await db
          .select({ ocrBoundingBoxes: bills.ocrBoundingBoxes })
          .from(bills)
          .where(and(eq(bills.id, parsed.billId), eq(bills.organizationId, orgId)))
          .limit(1);

        await db
          .update(bills)
          .set({
            documentUrl: doc.storagePath,
            documentType: ext === "pdf" ? "pdf" : "image",
            updatedAt: new Date(),
          })
          .where(and(eq(bills.id, parsed.billId), eq(bills.organizationId, orgId)));

        await db.insert(documentAttachments).values({
          organizationId: orgId,
          documentId: parsed.documentId,
          linkableType: "bill",
          linkableId: parsed.billId,
        });
        await linkBillDocumentToCandidate(db, orgId, parsed.billId, parsed.documentId);

        // Sync bounding boxes to the document record
        if (
          bill?.ocrBoundingBoxes &&
          Array.isArray(bill.ocrBoundingBoxes) &&
          bill.ocrBoundingBoxes.length > 0
        ) {
          await db
            .update(documents)
            .set({ ocrBoundingBoxes: bill.ocrBoundingBoxes })
            .where(and(eq(documents.id, parsed.documentId), eq(documents.organizationId, orgId)));
        }

        return { success: true };
      },
    );
  },
);

// ============================================================================
// Re-scan Bounding Boxes
// ============================================================================

/**
 * Re-scan a bill's document to extract updated bounding boxes using the
 * improved granular AI prompt. Fetches the document from R2, runs extraction,
 * and updates the bill's ocrBoundingBoxes field.
 */
export const rescanBoundingBoxes = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "update",
      { routeKey: "bill:rescan-bounding-boxes", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { billId } = rawData as { billId: string };
        if (!billId) throw new Error("billId is required");

        const [bill] = await db
          .select({
            id: bills.id,
            documentUrl: bills.documentUrl,
            documentType: bills.documentType,
          })
          .from(bills)
          .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
          .limit(1);

        if (!bill || !bill.documentUrl) {
          throw new Error("Bill not found or has no document");
        }

        let downloadUrl: string;
        const docUrl = bill.documentUrl;

        if (docUrl.startsWith("http://") || docUrl.startsWith("https://")) {
          downloadUrl = docUrl;
        } else if (docUrl.startsWith("r2://") && isR2Configured()) {
          const r2Path = docUrl.replace(/^r2:\/\/[^/]+\//, "");
          downloadUrl = await getPresignedDownloadUrl(r2Path, { expiresIn: 300 });
        } else if (isR2Configured()) {
          downloadUrl = await getPresignedDownloadUrl(docUrl, { expiresIn: 300 });
        } else {
          throw new Error("Cannot resolve document URL for download");
        }

        function resolveToDownloadUrl(path: string): Promise<string> {
          if (path.startsWith("http://") || path.startsWith("https://"))
            return Promise.resolve(path);
          const key = path.startsWith("r2://") ? path.replace(/^r2:\/\/[^/]+\//, "") : path;
          return getPresignedDownloadUrl(key, { expiresIn: 300 });
        }

        let actualDownloadUrl = downloadUrl;
        try {
          const testRes = await fetch(downloadUrl, { method: "HEAD" });
          if (!testRes.ok) {
            const [attachment] = await db
              .select({ storagePath: documents.storagePath })
              .from(documentAttachments)
              .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
              .where(
                and(
                  eq(documentAttachments.linkableId, billId),
                  eq(documentAttachments.linkableType, "bill"),
                ),
              )
              .limit(1);

            if (attachment?.storagePath) {
              actualDownloadUrl = await resolveToDownloadUrl(attachment.storagePath);
            }
          }
        } catch {
          const [attachment] = await db
            .select({ storagePath: documents.storagePath })
            .from(documentAttachments)
            .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
            .where(
              and(
                eq(documentAttachments.linkableId, billId),
                eq(documentAttachments.linkableType, "bill"),
              ),
            )
            .limit(1);

          if (attachment?.storagePath) {
            actualDownloadUrl = await resolveToDownloadUrl(attachment.storagePath);
          }
        }

        const response = await fetch(actualDownloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to download document: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const base64Content = Buffer.from(arrayBuffer).toString("base64");

        const ext = docUrl.split(".").pop()?.toLowerCase() || "";
        let mimeType = "application/pdf";
        if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
          mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
        }

        const boundingBoxes = await (
          extractBoundingBoxes as (opts: { data: unknown }) => Promise<any>
        )({
          data: { base64Content, mimeType },
        });

        if (!Array.isArray(boundingBoxes) || boundingBoxes.length === 0) {
          throw new Error("AI extraction returned no bounding boxes — existing data preserved");
        }

        await db
          .update(bills)
          .set({
            ocrBoundingBoxes: boundingBoxes,
            updatedAt: new Date(),
          })
          .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)));

        // Sync bounding boxes to the document record if one is linked
        const [attachment] = await db
          .select({ documentId: documentAttachments.documentId })
          .from(documentAttachments)
          .where(
            and(
              eq(documentAttachments.linkableId, billId),
              eq(documentAttachments.linkableType, "bill"),
            ),
          )
          .limit(1);

        if (attachment?.documentId) {
          await db
            .update(documents)
            .set({ ocrBoundingBoxes: boundingBoxes })
            .where(
              and(eq(documents.id, attachment.documentId), eq(documents.organizationId, orgId)),
            );
        }

        return { success: true, boxes: boundingBoxes };
      },
    );
  },
);

// ============================================================================
// Save Bill Line Items (upsert — delete existing + insert new)
// ============================================================================

const saveBillLineItemsSchema = z.object({
  billId: z.string().uuid(),
  lineItems: z
    .array(
      z.object({
        description: z.string().optional(),
        amount: z
          .string()
          .regex(/^\d+(?:\.\d+)?$/, "Line amount must be a non-negative number")
          .refine((v) => Number(v) > 0, "Line amount must be greater than zero"),
        accountId: z.string().uuid(),
        sortOrder: z.number().optional(),
      }),
    )
    .min(1),
});

export const saveBillLineItems = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "bill",
      "update",
      { routeKey: "bill:save-line-items", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = saveBillLineItemsSchema.parse(rawData);

        const [bill] = await db
          .select({
            id: bills.id,
            status: bills.status,
            journalHeaderId: bills.journalHeaderId,
            amountPaid: bills.amountPaid,
          })
          .from(bills)
          .where(and(eq(bills.id, parsed.billId), eq(bills.organizationId, orgId)))
          .limit(1);

        if (!bill) throw new Error("Bill not found");
        // Replacing lines rewrites what the accrual would post — refuse once
        // the journal exists or money moved, and org-check every accountId
        // (this path previously accepted any UUID).
        assertBillFinanciallyEditable(bill);
        await assertBillReferences(db, orgId, undefined, parsed.lineItems);

        // The bill's amount and balanceDue are DERIVED from its lines — the
        // old handler replaced the lines and left the stored totals stale.
        const totalAmount = sumMoney(parsed.lineItems.map((line) => line.amount));

        return db.transaction(async (tx) => {
          await tx.delete(billLineItems).where(eq(billLineItems.billId, parsed.billId));

          const newItems = await tx
            .insert(billLineItems)
            .values(
              parsed.lineItems.map((line, i) => ({
                billId: parsed.billId,
                description: line.description,
                amount: line.amount,
                accountId: line.accountId,
                sortOrder: line.sortOrder ?? i,
              })),
            )
            .returning();

          await tx
            .update(bills)
            .set({
              amount: totalAmount,
              balanceDue: deriveBillBalanceDue(totalAmount, bill.amountPaid),
              updatedAt: new Date(),
            })
            .where(and(eq(bills.id, parsed.billId), eq(bills.organizationId, orgId)));

          return { success: true, lineItems: newItems };
        });
      },
    );
  },
);
