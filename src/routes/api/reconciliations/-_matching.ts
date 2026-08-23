/**
 * Reconciliation API — Re-Run Matching
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  reconciliations,
  statementLines,
  reconciliationFlags,
  reconciliationSuggestions,
} from "../../../db/schema/reconciliations";
import { financialAccounts } from "../../../db/schema/financial-accounts";
import {
  effectiveJournalPredicate,
  journalLines,
  journalHeaders,
} from "../../../db/schema/journals";
import { parties } from "../../../db/schema/parties";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { isDateInLockedPeriod } from "../../../lib/period-close";
import { withMutationPermissionOrgContext } from "../../../lib/server-context";
import { resolveCandidateAccountIds } from "../../../lib/resolve-candidate-accounts";
import { getOrgClaimedJournalLineIds } from "../../../lib/reconciliation-claimed-lines";
import {
  runAutoMatcher,
  type StatementLineForMatching,
  type LedgerTransactionForMatching,
} from "../../../lib/auto-matcher";

const reRunMatchingSchema = z.object({
  reconciliationId: z.string().uuid(),
});

// ============================================================================
// Re-Run Matching
// ============================================================================

/**
 * Re-run the auto-matcher on remaining unmatched statement lines.
 * Useful after the user creates new ledger transactions from "Create Transaction" flow.
 * Only processes unmatched items — preserves existing matches and user-dismissed suggestions.
 */
export const reRunMatching = createServerFn({ method: "POST" })
  .inputValidator((data) => reRunMatchingSchema.parse(data))
  .handler(async ({ data }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:rerun-matching", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { reconciliationId } = data;

        // ── 1. Fetch reconciliation ──
        const [recon] = await db
          .select({
            id: reconciliations.id,
            bankAccountId: reconciliations.bankAccountId,
            periodStart: reconciliations.periodStart,
            periodEnd: reconciliations.periodEnd,
            status: reconciliations.status,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          );

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot re-run matching on a finalized reconciliation");
        {
          const { locked, closedThrough } = await isDateInLockedPeriod(orgId, recon.periodEnd, db);
          if (locked) {
            throw new Error(
              `Cannot re-run matching: period is locked through ${closedThrough}. Open the period first.`,
            );
          }
        }

        // ── 2. Get unmatched statement lines ──
        const unmatchedLines = await db
          .select({
            id: statementLines.id,
            date: statementLines.transactionDate,
            description: statementLines.description,
            amount: statementLines.amount,
          })
          .from(statementLines)
          .where(
            and(
              eq(statementLines.reconciliationId, reconciliationId),
              eq(statementLines.matchStatus, "unmatched"),
            ),
          );

        if (unmatchedLines.length === 0) {
          return {
            message: "No unmatched statement lines to process",
            newAutoMatched: 0,
            newSuggestions: 0,
          };
        }

        // ── 3. Resolve candidate ledger account IDs ──
        const [bankAcct] = await db
          .select({ ledgerAccountId: financialAccounts.ledgerAccountId })
          .from(financialAccounts)
          .where(eq(financialAccounts.id, recon.bankAccountId));

        if (!bankAcct?.ledgerAccountId) {
          return {
            message: "Bank account has no linked ledger account",
            newAutoMatched: 0,
            newSuggestions: 0,
          };
        }

        const candidateIds = await resolveCandidateAccountIds(db, bankAcct.ledgerAccountId);

        // ── 4. Get already-matched journal line IDs (exclude from matching pool) ──
        // Org-wide, not just this reconciliation: a journal line cleared by ANY
        // reconciliation (e.g. last period's finalized one) must never be matched again.
        // Counts BOTH 1:1 matches and split clearing rows.
        const alreadyMatchedIds = await getOrgClaimedJournalLineIds(db, orgId);

        // ── 5. Fetch fresh ledger transactions (only posted) ──
        const ledgerTxnRows = await db
          .select({
            journalLineId: journalLines.id,
            date: journalHeaders.transactionDate,
            debit: journalLines.debit,
            credit: journalLines.credit,
            partyName: parties.name,
            memo: journalHeaders.memo,
            lineDescription: journalLines.lineDescription,
          })
          .from(journalLines)
          .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
          .leftJoin(parties, eq(journalLines.partyId, parties.id))
          .where(
            and(
              inArray(journalLines.accountId, candidateIds),
              eq(journalHeaders.organizationId, orgId),
              eq(journalHeaders.status, "posted"),
              effectiveJournalPredicate(),
              gte(journalHeaders.transactionDate, recon.periodStart),
              lte(journalHeaders.transactionDate, recon.periodEnd),
            ),
          );

        // Filter out already-matched ledger entries
        const availableLedger = ledgerTxnRows.filter(
          (r) => !alreadyMatchedIds.has(r.journalLineId),
        );

        const stmtForMatching: StatementLineForMatching[] = unmatchedLines.map((l) => ({
          id: l.id,
          date: l.date,
          description: l.description,
          amount: Number(l.amount),
        }));

        const ledgerForMatching: LedgerTransactionForMatching[] = availableLedger.map((row) => {
          const debit = Number(row.debit || 0);
          const credit = Number(row.credit || 0);
          return {
            journalLineId: row.journalLineId,
            date: row.date,
            description: row.lineDescription || row.memo || "",
            amount: debit - credit,
            partyName: row.partyName || undefined,
            memo: row.memo || undefined,
          };
        });

        // ── 6. Run the auto-matcher ──
        const matchingResult = runAutoMatcher(stmtForMatching, ledgerForMatching);

        // ── 7. Apply new auto-matches ──
        if (matchingResult.autoMatched.length > 0) {
          await Promise.all(
            matchingResult.autoMatched.map((match) =>
              db
                .update(statementLines)
                .set({
                  matchedJournalLineId: match.journalLineId,
                  matchStatus: "matched",
                  matchConfidence: String(match.confidence),
                })
                .where(eq(statementLines.id, match.statementLineId)),
            ),
          );
        }

        // ── 8. Persist new suggestions ──
        if (matchingResult.suggestions.length > 0) {
          await db.insert(reconciliationSuggestions).values(
            matchingResult.suggestions.map((suggestion) => ({
              organizationId: orgId,
              reconciliationId,
              statementLineId: suggestion.statementLineId,
              journalLineId: suggestion.journalLineId,
              suggestionType:
                suggestion.suggestionType as typeof reconciliationSuggestions.$inferInsert.suggestionType,
              confidence: suggestion.confidence != null ? String(suggestion.confidence) : null,
              description: suggestion.description,
              proposedChanges: suggestion.proposedChanges || null,
            })),
          );
        }

        // ── 9. Resolve flags for newly matched items ──
        if (matchingResult.autoMatched.length > 0) {
          await Promise.all(
            matchingResult.autoMatched.map((match) =>
              db
                .update(reconciliationFlags)
                .set({
                  resolved: true,
                  resolvedAt: new Date(),
                  resolutionNotes: "Resolved by re-run matching",
                })
                .where(
                  and(
                    eq(reconciliationFlags.reconciliationId, reconciliationId),
                    eq(reconciliationFlags.statementLineId, match.statementLineId),
                    eq(reconciliationFlags.resolved, false),
                  ),
                ),
            ),
          );
        }

        return {
          message: `Re-run complete: ${matchingResult.autoMatched.length} new matches, ${matchingResult.suggestions.length} new suggestions`,
          newAutoMatched: matchingResult.autoMatched.length,
          newSuggestions: matchingResult.suggestions.length,
        };
      },
    );
  });
