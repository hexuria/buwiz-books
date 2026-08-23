/**
 * Reconciliation API — Write mutations (CRUD + match + finalize + reopen)
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  reconciliations,
  statementLines,
  statementLineMatches,
  reconciliationFlags,
} from "../../../db/schema/reconciliations";
import { financialAccounts } from "../../../db/schema/financial-accounts";
import {
  effectiveJournalPredicate,
  journalHeaders,
  journalLines,
} from "../../../db/schema/journals";
import { eq, and, desc, sql } from "drizzle-orm";
import { withMutationPermissionOrgContext } from "../../../lib/server-context";
import {
  claimConflictMessage,
  findClaimedJournalLine,
} from "../../../lib/reconciliation-claimed-lines";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { learnAliasFromMatch } from "@/lib/match-assist/learn";
import { persistReconciliationAnomalies } from "@/lib/reconciliation-anomaly-flags";
import { isDateInLockedPeriod } from "../../../lib/period-close";
import {
  computeFinalizeBalances,
  RECONCILIATION_BALANCE_TOLERANCE,
} from "../../../lib/reconciliation-finalize";

import {
  createReconciliationSchema,
  reconfigureReconciliationSchema,
  matchTransactionSchema,
  finalizeReconciliationSchema,
  reopenReconciliationSchema,
  deleteReconciliationSchema,
} from "./-_shared";

// ============================================================================
// Server Functions — Mutations
// ============================================================================

/**
 * Reconfigure a reconciliation — update period, balances, etc.
 */
export const reconfigureReconciliation = createServerFn({ method: "POST" })
  .inputValidator((data) => reconfigureReconciliationSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:reconfigure", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        // Verify reconciliation belongs to org
        const [recon] = await db
          .select({
            id: reconciliations.id,
            bankAccountId: reconciliations.bankAccountId,
            status: reconciliations.status,
            periodEnd: reconciliations.periodEnd,
          })
          .from(reconciliations)
          .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
          .limit(1)
          .for("update");

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized") {
          throw new Error("Cannot modify a finalized reconciliation");
        }

        // Period lock check — prevent changes in locked periods
        const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
        if (locked) {
          throw new Error(
            `Cannot modify reconciliation: period is locked through ${closedThrough}. Open the period first.`,
          );
        }

        // Check for existing reconciliation in this period (excluding self)
        const [existing] = await db
          .select({ id: reconciliations.id })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.organizationId, orgId),
              eq(reconciliations.bankAccountId, recon.bankAccountId),
              eq(reconciliations.periodStart, parsed.periodStart),
              eq(reconciliations.periodEnd, parsed.periodEnd),
              sql`${reconciliations.id} != ${parsed.id}`,
            ),
          )
          .limit(1);

        if (existing) {
          throw new Error("Another reconciliation already exists for this period");
        }

        // Capture old values for diff
        const [oldRecon] = await db
          .select({
            periodStart: reconciliations.periodStart,
            periodEnd: reconciliations.periodEnd,
            statementEndingBalance: reconciliations.statementEndingBalance,
            statementBeginningBalance: reconciliations.statementBeginningBalance,
          })
          .from(reconciliations)
          .where(eq(reconciliations.id, parsed.id))
          .limit(1);

        const setFields: Record<string, any> = {
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
          updatedAt: new Date(),
        };
        if (parsed.statementEndingBalance !== undefined) {
          setFields.statementEndingBalance = parsed.statementEndingBalance;
        }
        if (parsed.statementBeginningBalance !== undefined) {
          setFields.statementBeginningBalance = parsed.statementBeginningBalance;
        }

        const [updated] = await db
          .update(reconciliations)
          .set(setFields)
          .where(eq(reconciliations.id, parsed.id))
          .returning();

        // Build changes diff (only include fields that actually changed)
        const changes: Record<string, { from: string; to: string }> = {};
        if (oldRecon) {
          if (oldRecon.periodStart !== parsed.periodStart) {
            changes.periodStart = { from: oldRecon.periodStart, to: parsed.periodStart };
          }
          if (oldRecon.periodEnd !== parsed.periodEnd) {
            changes.periodEnd = { from: oldRecon.periodEnd, to: parsed.periodEnd };
          }
          if (
            parsed.statementEndingBalance !== undefined &&
            oldRecon.statementEndingBalance !== parsed.statementEndingBalance
          ) {
            changes.statementEndingBalance = {
              from: oldRecon.statementEndingBalance ?? "0.00",
              to: parsed.statementEndingBalance,
            };
          }
          if (
            parsed.statementBeginningBalance !== undefined &&
            oldRecon.statementBeginningBalance !== parsed.statementBeginningBalance
          ) {
            changes.statementBeginningBalance = {
              from: oldRecon.statementBeginningBalance ?? "0.00",
              to: parsed.statementBeginningBalance,
            };
          }
        }

        // Log activity only if something actually changed
        if (Object.keys(changes).length > 0 || parsed.charges || parsed.payments) {
          if (parsed.charges) {
            (changes as Record<string, unknown>).charges = parsed.charges;
          }
          if (parsed.payments) {
            (changes as Record<string, unknown>).payments = parsed.payments;
          }
          await insertActivityLog(
            {
              orgId,
              entityType: "reconciliation",
              entityId: parsed.id,
              action: "reconfigured",
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
 * Create a new reconciliation for a bank account + period
 */
export const createReconciliation = createServerFn({ method: "POST" })
  .inputValidator((data) => createReconciliationSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:create", limit: 15, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        // Verify the bank account belongs to this org
        const [bankAccount] = await db
          .select()
          .from(financialAccounts)
          .where(
            and(
              eq(financialAccounts.id, parsed.bankAccountId),
              eq(financialAccounts.organizationId, orgId),
            ),
          )
          .limit(1);

        if (!bankAccount) {
          throw new Error("Bank account not found");
        }

        // Check for existing reconciliation in this period
        const [existing] = await db
          .select({ id: reconciliations.id })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.organizationId, orgId),
              eq(reconciliations.bankAccountId, parsed.bankAccountId),
              eq(reconciliations.periodStart, parsed.periodStart),
              eq(reconciliations.periodEnd, parsed.periodEnd),
            ),
          )
          .limit(1);

        if (existing) {
          throw new Error("A reconciliation already exists for this bank account and period");
        }

        // Carry forward beginning balance from previous finalized reconciliation
        let beginningBalance = parsed.statementBeginningBalance ?? null;
        if (beginningBalance === null || beginningBalance === undefined) {
          const [prevRecon] = await db
            .select({ statementEndingBalance: reconciliations.statementEndingBalance })
            .from(reconciliations)
            .where(
              and(
                eq(reconciliations.organizationId, orgId),
                eq(reconciliations.bankAccountId, parsed.bankAccountId),
                eq(reconciliations.status, "finalized"),
              ),
            )
            .orderBy(desc(reconciliations.periodEnd))
            .limit(1);

          beginningBalance = prevRecon?.statementEndingBalance ?? "0.00";
        }

        const [recon] = await db
          .insert(reconciliations)
          .values({
            organizationId: orgId,
            bankAccountId: parsed.bankAccountId,
            periodStart: parsed.periodStart,
            periodEnd: parsed.periodEnd,
            statementBeginningBalance: beginningBalance,
            statementEndingBalance: parsed.statementEndingBalance ?? "0.00",
            status: "draft",
          })
          .returning();

        // Log creation
        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: recon.id,
            action: "created",
            actorId: userId,
            changes: {
              bankAccountId: parsed.bankAccountId,
              period: `${parsed.periodStart} — ${parsed.periodEnd}`,
            },
          },
          db,
        );
        return recon;
      },
    );
  });

/**
 * Match/unmatch/ignore a statement line
 */
export const matchTransaction = createServerFn({ method: "POST" })
  .inputValidator((data) => matchTransactionSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:match", limit: 120, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        // Verify reconciliation belongs to org
        const [recon] = await db
          .select({
            id: reconciliations.id,
            status: reconciliations.status,
            periodEnd: reconciliations.periodEnd,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, parsed.reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          )
          .limit(1);

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot modify a finalized reconciliation");

        // Period lock check
        const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
        if (locked) {
          throw new Error(
            `Cannot modify reconciliation: period is locked through ${closedThrough}. Open the period first.`,
          );
        }

        // One-to-many guard: a journal line may be cleared by at most ONE statement line
        // across ALL reconciliations (not just this one) — otherwise the same ledger
        // transaction could be double-cleared in successive periods.
        if (parsed.action === "match" && parsed.journalLineId) {
          const [effectiveLine] = await db
            .select({ id: journalLines.id })
            .from(journalLines)
            .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
            .where(
              and(
                eq(journalLines.id, parsed.journalLineId),
                eq(journalHeaders.organizationId, orgId),
                eq(journalHeaders.status, "posted"),
                effectiveJournalPredicate(),
              ),
            )
            .limit(1)
            .for("update", { of: journalHeaders });
          if (!effectiveLine) {
            throw new Error(
              "Only an effective posted journal can be reconciled. Unmatch suppressed duplicates first.",
            );
          }

          // The claim check must consider BOTH clearing representations. The
          // old query read only statement_lines, so a line cleared by a SPLIT
          // row could be claimed 1:1 as well — each side's unique index is
          // per-table, and computeFinalizeBalances would then count the same
          // ledger line twice. The 0048 triggers enforce this at COMMIT; this
          // check exists so the failure is an actionable message instead.
          const claim = await findClaimedJournalLine(db, orgId, [parsed.journalLineId], {
            excludeStatementLineId: parsed.statementLineId,
          });
          if (claim) {
            throw new Error(claimConflictMessage(claim));
          }
        }

        const updateFields: Record<string, any> = {
          matchStatus:
            parsed.action === "match"
              ? "matched"
              : parsed.action === "ignore"
                ? "ignored"
                : "unmatched",
          matchedJournalLineId: parsed.action === "match" ? parsed.journalLineId : null,
        };

        // ANY redefinition of this line's clearing — match, unmatch, or
        // ignore — clears its split rows. This used to run only on unmatch,
        // so a 1:1 match placed over an existing split left both
        // representations live and the finalize math counted the line's
        // clearing twice.
        await db
          .delete(statementLineMatches)
          .where(
            and(
              eq(statementLineMatches.statementLineId, parsed.statementLineId),
              eq(statementLineMatches.organizationId, orgId),
            ),
          );

        await db
          .update(statementLines)
          .set(updateFields)
          .where(
            and(
              eq(statementLines.id, parsed.statementLineId),
              eq(statementLines.reconciliationId, parsed.reconciliationId),
            ),
          );

        // A manual match is the strongest signal there is — teach the vendor
        // alias memory so future statements block this payee's candidates.
        if (parsed.action === "match" && parsed.journalLineId) {
          await learnAliasFromMatch(db, {
            orgId,
            statementLineId: parsed.statementLineId,
            journalLineId: parsed.journalLineId,
            source: "user_match",
          });
        }

        // Log match/unmatch/ignore action
        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: parsed.reconciliationId,
            action:
              parsed.action === "match"
                ? "matched"
                : parsed.action === "unmatch"
                  ? "unmatched"
                  : "ignored",
            actorId: userId,
            changes: {
              statementLineId: parsed.statementLineId,
              ...(parsed.journalLineId ? { journalLineId: parsed.journalLineId } : {}),
            },
          },
          db,
        );

        return { success: true };
      },
    );
  });

/**
 * Finalize a reconciliation
 * Snapshots the computed ledger balance for audit immutability
 */
export const finalizeReconciliation = createServerFn({ method: "POST" })
  .inputValidator((data) => finalizeReconciliationSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "finalize",
      { routeKey: "reconciliation:finalize", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const [recon] = await db
          .select()
          .from(reconciliations)
          .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
          .limit(1)
          .for("update");

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized") throw new Error("Already finalized");

        // Cleared/uncleared (bank-rec) gate: the statement ending balance must equal the
        // statement opening + net of MATCHED activity. Uncleared GL activity (outstanding
        // checks / deposits in transit) is a legitimate timing difference and does NOT block;
        // unmatched STATEMENT lines do. (The historical gate summed ALL posted GL activity,
        // which both let unmatched statements finalize and blocked legitimate outstanding items.)
        // The reconciliation must be backed by a bank account mapped to a ledger
        // (chart-of-accounts) account, or the cleared/uncleared gate cannot be computed.
        // Finalizing ungated would bypass the entire reconciliation check and leave the
        // snapshot columns NULL, so we block it rather than silently allowing it.
        if (!recon.bankAccountId) {
          throw new Error("Cannot finalize: reconciliation has no bank account.");
        }
        const [bankAcct] = await db
          .select({ ledgerAccountId: financialAccounts.ledgerAccountId })
          .from(financialAccounts)
          .where(eq(financialAccounts.id, recon.bankAccountId))
          .limit(1);
        if (!bankAcct?.ledgerAccountId) {
          throw new Error(
            "Cannot finalize: the bank account is not linked to a ledger (chart-of-accounts) account. Link it in account settings before finalizing.",
          );
        }

        const balances = await computeFinalizeBalances(db, {
          orgId,
          reconciliationId: parsed.id,
          ledgerAccountId: bankAcct.ledgerAccountId,
          periodStart: recon.periodStart,
          periodEnd: recon.periodEnd,
          statementBeginningBalance: Number.parseFloat(recon.statementBeginningBalance ?? "0"),
          statementEndingBalance: Number.parseFloat(recon.statementEndingBalance ?? "0"),
        });

        if (balances.unmatchedStatementLines > 0) {
          throw new Error(
            `Cannot finalize: ${balances.unmatchedStatementLines} statement line(s) are still unmatched. Match or ignore them first.`,
          );
        }
        if (Math.abs(balances.clearedDifference) > RECONCILIATION_BALANCE_TOLERANCE) {
          throw new Error(
            "Cannot finalize: Statement ending balance does not match the cleared balance.",
          );
        }

        // Advisory anomaly pass — deterministic, never blocks (the arithmetic
        // gate above is the authority). Annotations land in this transaction
        // so the finalized reconciliation carries them for audit.
        const anomalyCount = await persistReconciliationAnomalies(db, {
          orgId,
          reconciliationId: parsed.id,
          bankAccountId: recon.bankAccountId,
        });

        const [updated] = await db
          .update(reconciliations)
          .set({
            status: "finalized",
            finalizedAt: new Date(),
            finalizedById: userId,
            updatedAt: new Date(),
            ledgerBalance: balances.ledgerBalance.toFixed(2),
            clearedBalance: balances.clearedBalance.toFixed(2),
            unclearedTotal: balances.unclearedTotal.toFixed(2),
          })
          .where(eq(reconciliations.id, parsed.id))
          .returning();

        // Log finalization with balance snapshot
        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: parsed.id,
            action: "finalized",
            actorId: userId,
            changes: {
              description: "Reconciliation finalized",
              clearedBalance: balances.clearedBalance.toFixed(2),
              unclearedTotal: balances.unclearedTotal.toFixed(2),
              ledgerBalance: balances.ledgerBalance.toFixed(2),
              clearedDifference: balances.clearedDifference.toFixed(2),
              anomalyFlags: anomalyCount,
            },
          },
          db,
        );

        return updated;
      },
    );
  });

/**
 * Reopen a finalized reconciliation — sets it back to in_progress
 */
export const reopenReconciliation = createServerFn({ method: "POST" })
  .inputValidator((data) => reopenReconciliationSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:reopen", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const [recon] = await db
          .select()
          .from(reconciliations)
          .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
          .limit(1);

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status !== "finalized") throw new Error("Reconciliation is not finalized");

        // Period lock check — cannot reopen a recon in a locked period
        const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
        if (locked) {
          throw new Error(
            `Cannot reopen reconciliation: period is locked through ${closedThrough}. Open the period first.`,
          );
        }

        const [updated] = await db
          .update(reconciliations)
          .set({
            status: "in_progress",
            finalizedAt: null,
            finalizedById: null,
            // The snapshot columns describe the moment of finalization; once
            // reopened they describe nothing, and leaving them made the list
            // and detail views show stale figures as if current.
            clearedBalance: null,
            unclearedTotal: null,
            ledgerBalance: null,
            aiAutoFinalized: false,
            updatedAt: new Date(),
          })
          .where(eq(reconciliations.id, parsed.id))
          .returning();

        // Log reopen
        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: parsed.id,
            action: "reopened",
            actorId: userId,
            changes: { description: "Reconciliation reopened" },
          },
          db,
        );

        return updated;
      },
    );
  });

/**
 * Delete a reconciliation and its child records (statement lines, flags, suggestions)
 * Only non-finalized reconciliations can be deleted.
 */
export const deleteReconciliation = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteReconciliationSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const [recon] = await db
          .select()
          .from(reconciliations)
          .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
          .limit(1);

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot delete a finalized reconciliation");

        // Period lock check
        const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
        if (locked) {
          throw new Error(
            `Cannot delete reconciliation: period is locked through ${closedThrough}. Open the period first.`,
          );
        }

        // Delete the reconciliation — child records (statement lines, flags, suggestions)
        // are automatically removed via ON DELETE CASCADE foreign keys
        await db.delete(reconciliations).where(eq(reconciliations.id, parsed.id));

        // Log deletion
        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: parsed.id,
            action: "deleted",
            actorId: userId,
            changes: {
              description: `Reconciliation for ${recon.periodStart} – ${recon.periodEnd} deleted`,
            },
          },
          db,
        );

        return { success: true };
      },
    );
  });

const resolveReconciliationFlagSchema = z.object({
  reconciliationId: z.string().uuid(),
  flagId: z.string().uuid(),
  action: z.string(),
});

/**
 * Resolve or dismiss a reconciliation flag
 */
export const resolveReconciliationFlag = createServerFn({ method: "POST" })
  .inputValidator((data) => resolveReconciliationFlagSchema.parse(data))
  .handler(async ({ data: parsed }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:resolve-flag", limit: 60, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        // Verify reconciliation belongs to org
        const [recon] = await db
          .select({
            id: reconciliations.id,
            status: reconciliations.status,
            periodEnd: reconciliations.periodEnd,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, parsed.reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          )
          .limit(1);

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot modify a finalized reconciliation");

        // Period lock check
        const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
        if (locked) {
          throw new Error(
            `Cannot modify reconciliation: period is locked through ${closedThrough}. Open the period first.`,
          );
        }

        await db
          .update(reconciliationFlags)
          .set({
            resolved: true,
            resolvedAt: new Date(),
            resolvedById: userId,
            resolutionNotes: `Resolved via action: ${parsed.action}`,
          })
          .where(
            and(
              eq(reconciliationFlags.id, parsed.flagId),
              eq(reconciliationFlags.reconciliationId, parsed.reconciliationId),
            ),
          );

        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: parsed.reconciliationId,
            action: "flag_resolved",
            actorId: userId,
            changes: { flagId: parsed.flagId, action: parsed.action },
          },
          db,
        );

        return { success: true };
      },
    );
  });
