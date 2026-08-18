/**
 * Transactions API — Mutations
 * Create, update, void, post
 */
import { createServerFn } from "@tanstack/react-start";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { journalHeaders, journalLines } from "../../../db/schema/journals";
import { statementLines, reconciliations } from "../../../db/schema/reconciliations";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { isDateInLockedPeriod } from "../../../lib/period-close";
import { withMutationPermissionOrgContext } from "../../../lib/server-context";
import { createTransactionCandidate } from "../../../lib/inbox/service";
import {
  createTransactionSchema,
  updateTransactionSchema,
  validateBalance,
} from "../../../db/validation/journals";

import {
  getTransactionSchema,
  voidTransactionSchema,
  fetchLinesWithNames,
  resolvePartyName,
  buildLineDiffs,
} from "./-_shared";

// ============================================================================
// Server Functions — Mutations
// ============================================================================

/**
 * Submit a new transaction candidate to Inbox review.
 * No ledger journal is created until a separate reviewer approves the Inbox item.
 */
export const createTransaction = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof createTransactionSchema>) =>
    createTransactionSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "inbox",
      "create",
      { routeKey: "transactions:create", limit: 45, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const parsed = createTransactionSchema.parse(rawData);
        return createTransactionCandidate(
          { orgId, userId, role, db },
          {
            transactionDate: parsed.transactionDate,
            transactionType: parsed.transactionType,
            memo: parsed.memo,
            partyId: parsed.partyId,
            referenceNumber: parsed.referenceNumber,
            originalCurrency: parsed.currency,
            functionalCurrency: parsed.functionalCurrency,
            exchangeRate: parsed.exchangeRate,
            exchangeRateId: parsed.exchangeRateId,
            sourceChannel:
              parsed.source === "import"
                ? "csv"
                : parsed.source === "document"
                  ? "upload"
                  : parsed.source === "email"
                    ? "email"
                    : parsed.source === "bill"
                      ? "bills_expenses"
                      : "manual",
            sourceProvider: parsed.source === "bill" ? "internal_bills" : "internal",
            requestIdempotencyKey: parsed.idempotencyKey,
            externalId: parsed.externalId,
            documentIds: parsed.documentIds,
            lines: parsed.lines,
          },
        );
      },
    );
  });

/**
 * Update a draft transaction
 * Only draft transactions can be edited
 */
export const updateTransaction = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof updateTransactionSchema>) =>
    updateTransactionSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "transactions:update", limit: 60, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = updateTransactionSchema.parse(rawData);
        const { id, lines, ...updates } = parsed;

        // Get existing header
        const [existing] = await db
          .select()
          .from(journalHeaders)
          .where(and(eq(journalHeaders.id, id), eq(journalHeaders.organizationId, orgId)))
          .limit(1)
          .for("update");

        if (!existing) {
          throw new Error("Transaction not found");
        }
        if (existing.duplicateOfHeaderId) {
          throw new Error("Suppressed duplicate transactions cannot be edited. Unmatch it first.");
        }

        if (existing.status === "voided") {
          throw new Error("Voided transactions cannot be edited");
        }

        // A POSTED journal is never edited in place. This path deletes every
        // line and reinserts the replacements, so before this guard existed any
        // tax line the compliance layer wrote could be silently mutated or
        // dropped, leaving only an activity-log row behind. The correct
        // operation is a reversal plus a replacement — see
        // lib/journal-amendment.ts. Database triggers (0039) enforce the same
        // rule underneath, so this check is the friendly message rather than
        // the actual guarantee.
        const changesFinancialSubstance =
          lines !== undefined ||
          (updates.transactionDate !== undefined &&
            updates.transactionDate !== existing.transactionDate) ||
          (updates.transactionType !== undefined &&
            updates.transactionType !== existing.transactionType) ||
          (updates.partyId !== undefined && updates.partyId !== existing.partyId);

        if (existing.status === "posted" && changesFinancialSubstance) {
          throw new Error(
            "This transaction is posted and cannot be edited in place. " +
              "Reverse and replace it instead, so the original entry stays on the record.",
          );
        }

        // Period lock check — the transaction must not currently sit in a locked period...
        const { locked, closedThrough } = await isDateInLockedPeriod(
          orgId,
          existing.transactionDate,
        );
        if (locked) {
          throw new Error(
            `Cannot edit transaction: period is locked through ${closedThrough}. Open the period first.`,
          );
        }
        // ...and it must not be MOVED into a locked period via a new date.
        if (updates.transactionDate && updates.transactionDate !== existing.transactionDate) {
          const target = await isDateInLockedPeriod(orgId, updates.transactionDate);
          if (target.locked) {
            throw new Error(
              `Cannot move transaction to ${updates.transactionDate}: that period is locked through ${target.closedThrough}.`,
            );
          }
        }

        // Reconciliation lock check
        const matchedStatementLines = await db
          .select({
            id: statementLines.id,
            status: reconciliations.status,
          })
          .from(statementLines)
          .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
          .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
          .where(eq(journalLines.journalHeaderId, existing.id));

        if (matchedStatementLines.some((sl) => sl.status === "finalized")) {
          throw new Error("Cannot edit transaction: it is locked by a finalized reconciliation.");
        }

        // Fetch old lines with names BEFORE any deletion (needed for per-line diffs)
        let oldLinesWithNames: Awaited<ReturnType<typeof fetchLinesWithNames>> | null = null;
        let computedTotalAmount: string | undefined;

        // If lines are provided, validate balance and replace
        if (lines && lines.length >= 2) {
          const balance = validateBalance(lines);
          if (!balance.valid) {
            throw new Error(
              `Unbalanced entry: Debits (${balance.totalDebits}) ≠ Credits (${balance.totalCredits})`,
            );
          }

          oldLinesWithNames = await fetchLinesWithNames(db, id);

          // Delete existing lines and insert new ones
          await db.delete(journalLines).where(eq(journalLines.journalHeaderId, id));

          const lineValues = lines.map((line, index) => ({
            journalHeaderId: id,
            accountId: line.accountId,
            debit: line.debit || null,
            credit: line.credit || null,
            lineDescription: line.lineDescription,
            partyId: line.partyId || null,
            departmentId: line.departmentId,
            locationId: line.locationId,
            sortOrder: line.sortOrder ?? index,
          }));

          await db.insert(journalLines).values(lineValues);

          // Update cached total
          computedTotalAmount = balance.totalDebitsExact;
        }

        // Build update object (only include provided fields)
        const updateFields: Record<string, unknown> = { updatedAt: new Date() };
        if (updates.transactionDate !== undefined)
          updateFields.transactionDate = updates.transactionDate;
        if (updates.transactionType !== undefined)
          updateFields.transactionType = updates.transactionType;
        if (updates.memo !== undefined) updateFields.memo = updates.memo;
        if (updates.partyId !== undefined) updateFields.partyId = updates.partyId;
        if (updates.referenceNumber !== undefined)
          updateFields.referenceNumber = updates.referenceNumber;
        if (computedTotalAmount !== undefined) updateFields.totalAmount = computedTotalAmount;

        const [updated] = await db
          .update(journalHeaders)
          .set(updateFields)
          .where(and(eq(journalHeaders.id, id), eq(journalHeaders.organizationId, orgId)))
          .returning();

        // Build changes snapshot (old → new) for header fields
        const changes: Record<string, unknown> = {};
        if (
          updates.transactionDate !== undefined &&
          updates.transactionDate !== existing.transactionDate
        )
          changes.transactionDate = { old: existing.transactionDate, new: updates.transactionDate };
        if (
          updates.transactionType !== undefined &&
          updates.transactionType !== existing.transactionType
        )
          changes.transactionType = { old: existing.transactionType, new: updates.transactionType };
        if (updates.memo !== undefined && updates.memo !== existing.memo)
          changes.memo = { old: existing.memo, new: updates.memo };
        if (
          updates.referenceNumber !== undefined &&
          updates.referenceNumber !== existing.referenceNumber
        )
          changes.referenceNumber = { old: existing.referenceNumber, new: updates.referenceNumber };
        if (computedTotalAmount !== undefined && computedTotalAmount !== existing.totalAmount)
          changes.totalAmount = { old: existing.totalAmount, new: computedTotalAmount };

        // Resolve party name changes (old → new) instead of raw UUIDs
        if (updates.partyId !== undefined && updates.partyId !== existing.partyId) {
          const [oldPartyName, newPartyName] = await Promise.all([
            resolvePartyName(db, existing.partyId),
            resolvePartyName(db, updates.partyId ?? null),
          ]);
          changes.party = { old: oldPartyName, new: newPartyName };
        }

        // Build per-line diffs if lines were updated
        if (lines && lines.length >= 2) {
          const newLinesWithNames = await fetchLinesWithNames(db, id);
          const lineDiffs = buildLineDiffs(oldLinesWithNames!, newLinesWithNames);
          Object.assign(changes, lineDiffs);
        }

        // Record activity log only if something actually changed
        if (Object.keys(changes).length > 0) {
          await insertActivityLog(
            {
              orgId,
              entityType: "transaction",
              entityId: id,
              action: "updated",
              actorId: userId,
              changes,
            },
            db,
          );
        }

        return updated;
      },
    );
  });

/**
 * Void a posted transaction
 * Sets status to 'voided' and records voidedAt timestamp
 */
export const voidTransaction = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "void",
      { routeKey: "transactions:void", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = voidTransactionSchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(journalHeaders)
          .where(and(eq(journalHeaders.id, parsed.id), eq(journalHeaders.organizationId, orgId)))
          .limit(1)
          .for("update");

        if (!existing) {
          throw new Error("Transaction not found");
        }
        if (existing.duplicateOfHeaderId) {
          throw new Error("Suppressed duplicate transactions cannot be voided. Unmatch it first.");
        }

        if (existing.status === "voided") {
          throw new Error("Transaction is already voided");
        }

        const { locked, closedThrough } = await isDateInLockedPeriod(
          orgId,
          existing.transactionDate,
        );
        if (locked) {
          throw new Error(
            `Cannot void transaction: period is locked through ${closedThrough}. Open the period first.`,
          );
        }

        // Reconciliation lock check
        const matchedStatementLines = await db
          .select({
            id: statementLines.id,
            status: reconciliations.status,
          })
          .from(statementLines)
          .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
          .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
          .where(eq(journalLines.journalHeaderId, existing.id));

        if (matchedStatementLines.some((sl) => sl.status === "finalized")) {
          throw new Error("Cannot void transaction: it is locked by a finalized reconciliation.");
        }

        const [voided] = await db
          .update(journalHeaders)
          .set({
            status: "voided",
            voidedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(journalHeaders.id, parsed.id), eq(journalHeaders.organizationId, orgId)))
          .returning();

        await insertActivityLog(
          {
            orgId,
            entityType: "transaction",
            entityId: parsed.id,
            action: "voided",
            actorId: userId,
          },
          db,
        );

        return voided;
      },
    );
  },
);

/**
 * Post a draft transaction (change status from draft to posted)
 */
export const postTransaction = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "post",
      { routeKey: "transactions:post", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = getTransactionSchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(journalHeaders)
          .where(and(eq(journalHeaders.id, parsed.id), eq(journalHeaders.organizationId, orgId)))
          .limit(1)
          .for("update");

        if (!existing) {
          throw new Error("Transaction not found");
        }
        if (existing.duplicateOfHeaderId) {
          throw new Error("Suppressed duplicate transactions cannot be posted. Unmatch it first.");
        }

        if (existing.status !== "draft") {
          throw new Error("Only draft transactions can be posted");
        }

        const { locked: isLocked, closedThrough: closedDate } = await isDateInLockedPeriod(
          orgId,
          existing.transactionDate,
        );
        if (isLocked) {
          throw new Error(
            `Cannot post transaction: period is locked through ${closedDate}. Open the period first.`,
          );
        }

        const lines = await db
          .select()
          .from(journalLines)
          .where(eq(journalLines.journalHeaderId, parsed.id));

        if (lines.length < 2) {
          throw new Error("Transaction must have at least 2 journal lines to be posted");
        }

        const balance = validateBalance(
          lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit ?? undefined,
            credit: l.credit ?? undefined,
          })),
        );

        if (!balance.valid) {
          throw new Error("Cannot post an unbalanced transaction");
        }

        const [posted] = await db
          .update(journalHeaders)
          .set({
            status: "posted",
            postedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(journalHeaders.id, parsed.id), eq(journalHeaders.organizationId, orgId)))
          .returning();

        await insertActivityLog(
          {
            orgId,
            entityType: "transaction",
            entityId: parsed.id,
            action: "posted",
            actorId: userId,
          },
          db,
        );

        return posted;
      },
    );
  },
);
