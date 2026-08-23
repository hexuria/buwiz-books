/**
 * Reconciliation API — Suggestion Management
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  statementLines,
  statementLineMatches,
  reconciliationFlags,
  reconciliationSuggestions,
  reconciliations,
} from "../../../db/schema/reconciliations";
import {
  effectiveJournalPredicate,
  journalHeaders,
  journalLines,
} from "../../../db/schema/journals";
import { eq, and, desc, inArray } from "drizzle-orm";
import { isDateInLockedPeriod } from "../../../lib/period-close";
import {
  claimConflictMessage,
  findClaimedJournalLine,
} from "../../../lib/reconciliation-claimed-lines";
import {
  withSessionOrgContext,
  withMutationPermissionOrgContext,
} from "../../../lib/server-context";
import { learnAliasFromMatch } from "../../../lib/match-assist/learn";
import { assertRolePermission } from "../../../lib/auth-middleware";
import {
  enqueueMatchAssistJob,
  MATCH_ASSIST_JOB_TYPE,
} from "../../../lib/jobs/handlers/match-assist";
import { triggerWorker } from "../../../lib/jobs/trigger";

// ============================================================================
// Schemas
// ============================================================================

const reconciliationIdSchema = z.object({
  reconciliationId: z.string().uuid(),
});

const suggestionIdSchema = z.object({
  suggestionId: z.string().uuid(),
});

// ============================================================================
// Server Functions — Suggestions
// ============================================================================

/**
 * List AI-generated suggestions for a reconciliation
 */
export const listReconciliationSuggestions = createServerFn({ method: "GET" })
  .inputValidator((data) => reconciliationIdSchema.parse(data))
  .handler(async ({ data }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { reconciliationId } = data;

      const rows = await db
        .select()
        .from(reconciliationSuggestions)
        .where(
          and(
            eq(reconciliationSuggestions.reconciliationId, reconciliationId),
            eq(reconciliationSuggestions.organizationId, orgId),
          ),
        )
        .orderBy(desc(reconciliationSuggestions.confidence));

      return rows;
    });
  });

/**
 * Apply a suggestion — execute the proposed action
 */
export const applySuggestion = createServerFn({ method: "POST" })
  .inputValidator((data) => suggestionIdSchema.parse(data))
  .handler(async ({ data }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:apply-suggestion", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { suggestionId } = data;

        const [suggestion] = await db
          .select()
          .from(reconciliationSuggestions)
          .where(
            and(
              eq(reconciliationSuggestions.id, suggestionId),
              eq(reconciliationSuggestions.organizationId, orgId),
            ),
          );

        if (!suggestion) throw new Error("Suggestion not found");
        if (suggestion.status !== "pending") throw new Error("Suggestion already resolved");

        // The manual match path refuses to touch a finalized or period-locked
        // reconciliation; applying a stale suggestion is the same mutation and
        // gets the same gate. Without it, a pending suggestion applied after
        // finalization silently invalidated the finalized snapshot.
        const [recon] = await db
          .select({
            id: reconciliations.id,
            status: reconciliations.status,
            periodEnd: reconciliations.periodEnd,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, suggestion.reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot apply a suggestion to a finalized reconciliation");
        {
          const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
          if (locked) {
            throw new Error(
              `Cannot modify reconciliation: period is locked through ${closedThrough}. Open the period first.`,
            );
          }
        }

        if (
          ["auto_match", "date_fix"].includes(suggestion.suggestionType) &&
          suggestion.journalLineId
        ) {
          const [effectiveLine] = await db
            .select({ id: journalLines.id })
            .from(journalLines)
            .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
            .where(
              and(
                eq(journalLines.id, suggestion.journalLineId),
                eq(journalHeaders.organizationId, orgId),
                eq(journalHeaders.status, "posted"),
                effectiveJournalPredicate(),
              ),
            )
            .limit(1)
            .for("update", { of: journalHeaders });
          if (!effectiveLine) {
            throw new Error(
              "This suggestion targets a suppressed or unavailable journal. Refresh matching suggestions.",
            );
          }
        }

        let resolutionSummary = "";

        // Execute action based on suggestion type
        switch (suggestion.suggestionType) {
          case "auto_match": {
            // Link statement line to journal line
            if (suggestion.statementLineId && suggestion.journalLineId) {
              // Both clearing representations are checked, and any split rows
              // on the target line are replaced by the 1:1 link — mirroring
              // matchTransaction. Applying a suggestion is the same mutation.
              const claim = await findClaimedJournalLine(db, orgId, [suggestion.journalLineId], {
                excludeStatementLineId: suggestion.statementLineId,
              });
              if (claim) throw new Error(claimConflictMessage(claim));
              await db
                .delete(statementLineMatches)
                .where(
                  and(
                    eq(statementLineMatches.statementLineId, suggestion.statementLineId),
                    eq(statementLineMatches.organizationId, orgId),
                  ),
                );
              await db
                .update(statementLines)
                .set({
                  matchedJournalLineId: suggestion.journalLineId,
                  matchStatus: "matched",
                  matchConfidence: suggestion.confidence,
                })
                .where(eq(statementLines.id, suggestion.statementLineId));
              // A human confirmed this pairing — teach the alias memory.
              await learnAliasFromMatch(db, {
                orgId,
                statementLineId: suggestion.statementLineId,
                journalLineId: suggestion.journalLineId,
                source: "llm_suggestion_accepted",
              });
              resolutionSummary = `Matched statement line to ledger transaction`;
            }
            break;
          }

          case "date_fix": {
            // Match the statement line to the journal line without modifying the ledger date.
            // Date differences between bank clearing and ledger booking are normal.
            if (suggestion.statementLineId && suggestion.journalLineId) {
              const claim = await findClaimedJournalLine(db, orgId, [suggestion.journalLineId], {
                excludeStatementLineId: suggestion.statementLineId,
              });
              if (claim) throw new Error(claimConflictMessage(claim));
              await db
                .delete(statementLineMatches)
                .where(
                  and(
                    eq(statementLineMatches.statementLineId, suggestion.statementLineId),
                    eq(statementLineMatches.organizationId, orgId),
                  ),
                );
              await db
                .update(statementLines)
                .set({
                  matchedJournalLineId: suggestion.journalLineId,
                  matchStatus: "matched",
                  matchConfidence: suggestion.confidence,
                })
                .where(eq(statementLines.id, suggestion.statementLineId));
              await learnAliasFromMatch(db, {
                orgId,
                statementLineId: suggestion.statementLineId,
                journalLineId: suggestion.journalLineId,
                source: "llm_suggestion_accepted",
              });
              const fromDate = suggestion.proposedChanges?.date?.from ?? "unknown";
              const toDate = suggestion.proposedChanges?.date?.to ?? "unknown";
              resolutionSummary = `Matched despite date difference (statement: ${toDate}, ledger: ${fromDate})`;
            }
            break;
          }

          case "ignore": {
            // Mark statement line as ignored
            if (suggestion.statementLineId) {
              await db
                .update(statementLines)
                .set({ matchStatus: "ignored" })
                .where(eq(statementLines.id, suggestion.statementLineId));
              resolutionSummary = "Statement line marked as ignored";
            }
            break;
          }

          case "create_txn": {
            throw new Error(
              "This suggestion requires creating a new transaction. " +
                "Please use the 'Create Transaction' button on the reconciliation page to " +
                "record this bank statement item in your ledger, then match it.",
            );
          }

          case "duplicate": {
            throw new Error(
              "Duplicate suggestions require manual review. " +
                "Please examine the flagged transactions and either match or ignore them.",
            );
          }

          case "split": {
            // One statement line settling MULTIPLE ledger transactions.
            // Everything is re-verified here — the suggestion's payload is
            // data at rest, written by a model, so none of it is trusted:
            //   • every ledger line must be org-owned, posted, and unclaimed
            //   • the allocations must sum EXACTLY to the statement amount
            //     (recomputed in cents, never floats)
            const payload = suggestion.proposedChanges?.split?.to as
              | {
                  statementLineId?: string;
                  parts?: Array<{ journalLineId: string; allocatedAmount: string }>;
                }
              | undefined;
            const parts = payload?.parts ?? [];
            if (!suggestion.statementLineId || parts.length < 2) {
              throw new Error("This split suggestion is malformed and cannot be applied.");
            }

            const [line] = await db
              .select({ id: statementLines.id, amount: statementLines.amount })
              .from(statementLines)
              .where(
                and(
                  eq(statementLines.id, suggestion.statementLineId),
                  eq(statementLines.reconciliationId, suggestion.reconciliationId),
                ),
              )
              .limit(1);
            if (!line) throw new Error("Statement line not found.");

            const totalCents = parts.reduce(
              (sum, p) => sum + Math.round(Number(p.allocatedAmount) * 100),
              0,
            );
            if (totalCents !== Math.round(Number(line.amount) * 100)) {
              throw new Error(
                `Split allocations total ${(totalCents / 100).toFixed(2)} but the statement line is ${Number(line.amount).toFixed(2)}.`,
              );
            }

            const journalLineIds = parts.map((p) => p.journalLineId);
            const available = await db
              .select({ id: journalLines.id })
              .from(journalLines)
              .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
              .where(
                and(
                  inArray(journalLines.id, journalLineIds),
                  eq(journalHeaders.organizationId, orgId),
                  eq(journalHeaders.status, "posted"),
                  effectiveJournalPredicate(),
                ),
              )
              .for("update", { of: journalHeaders });
            if (available.length !== journalLineIds.length) {
              throw new Error(
                "One or more ledger transactions in this split are no longer available. Refresh matching suggestions.",
              );
            }

            // The join table's unique index catches split-vs-split; it cannot
            // see a 1:1 claim on statement_lines. Check both representations
            // so the failure is a message, with the 0048 trigger as backstop.
            const splitClaim = await findClaimedJournalLine(db, orgId, journalLineIds, {
              excludeStatementLineId: line.id,
            });
            if (splitClaim) throw new Error(claimConflictMessage(splitClaim));

            // The join table's unique index on journal_line_id is the real
            // guard against double-clearing; inserting inside this
            // transaction turns a race into a constraint violation, not a
            // corrupted reconciliation.
            await db.insert(statementLineMatches).values(
              parts.map((p) => ({
                organizationId: orgId,
                statementLineId: line.id,
                journalLineId: p.journalLineId,
                allocatedAmount: p.allocatedAmount,
              })),
            );
            await db
              .update(statementLines)
              .set({
                matchStatus: "matched",
                // Split matches live in the join table; the 1:1 column stays null.
                matchedJournalLineId: null,
                matchConfidence: suggestion.confidence,
              })
              .where(eq(statementLines.id, line.id));

            for (const journalLineId of journalLineIds) {
              await learnAliasFromMatch(db, {
                orgId,
                statementLineId: line.id,
                journalLineId,
                source: "llm_suggestion_accepted",
              });
            }

            resolutionSummary = `Split-matched across ${parts.length} ledger transactions`;
            break;
          }

          default:
            resolutionSummary = `Suggestion type '${suggestion.suggestionType}' acknowledged`;
        }

        // Update suggestion status
        await db
          .update(reconciliationSuggestions)
          .set({
            status: "applied",
            appliedAt: new Date(),
            resolutionSummary,
          })
          .where(eq(reconciliationSuggestions.id, suggestionId));

        // Resolve any linked flags (statement-side and ledger-side)
        const flagConditions = [
          eq(reconciliationFlags.reconciliationId, suggestion.reconciliationId),
          eq(reconciliationFlags.resolved, false),
        ];

        if (suggestion.statementLineId) {
          // Resolve statement-side flags (unmatched_statement)
          await db
            .update(reconciliationFlags)
            .set({
              resolved: true,
              resolvedAt: new Date(),
              resolutionNotes: resolutionSummary,
            })
            .where(
              and(
                ...flagConditions,
                eq(reconciliationFlags.statementLineId, suggestion.statementLineId),
              ),
            );
        }

        return { success: true, resolutionSummary };
      },
    );
  });

/**
 * Dismiss a suggestion — mark as not applicable
 */
export const dismissSuggestion = createServerFn({ method: "POST" })
  .inputValidator((data) => suggestionIdSchema.parse(data))
  .handler(async ({ data }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:dismiss-suggestion", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { suggestionId } = data;

        const [suggestion] = await db
          .select()
          .from(reconciliationSuggestions)
          .where(
            and(
              eq(reconciliationSuggestions.id, suggestionId),
              eq(reconciliationSuggestions.organizationId, orgId),
            ),
          );

        if (!suggestion) throw new Error("Suggestion not found");
        if (suggestion.status !== "pending") throw new Error("Suggestion already resolved");

        await db
          .update(reconciliationSuggestions)
          .set({
            status: "dismissed",
            appliedAt: new Date(),
            resolutionSummary: "Dismissed by user",
          })
          .where(eq(reconciliationSuggestions.id, suggestionId));

        return { success: true };
      },
    );
  });

/**
 * Manually request AI match suggestions for a reconciliation's residual
 * unmatched set. Enqueues the match_assist job and triggers the worker —
 * the deterministic matcher has already run, so this only arbitrates what
 * it could not settle.
 *
 * Two-key model: aiTask:run (the AI surface) + reconciliation:create (the
 * permission to act on a reconciliation).
 */
export const requestMatchAssist = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z.object({ reconciliationId: z.string().uuid(), prefill: z.boolean().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "reconciliation:match-assist", limit: 10, windowMs: 60_000 },
      async ({ orgId, db, role }) => {
        assertRolePermission(role, "reconciliation", "create");
        const jobId = await enqueueMatchAssistJob(db, {
          organizationId: orgId,
          reconciliationId: data.reconciliationId,
          prefill: data.prefill,
        });
        // Fire the worker after the enclosing transaction commits; the
        // scheduler tick is the backstop if the trigger is dropped.
        queueMicrotask(() => triggerWorker([MATCH_ASSIST_JOB_TYPE]));
        return { status: "queued" as const, jobId };
      },
    );
  });
