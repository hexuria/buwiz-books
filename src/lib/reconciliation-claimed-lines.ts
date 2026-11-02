// ============================================================================
// Which ledger lines are already cleared by a reconciliation.
//
// A ledger line can be claimed two ways: the 1:1
// statementLines.matchedJournalLineId column, or a split row in
// statement_line_matches. Every matcher and candidate query must consider
// BOTH, or a line cleared by a split would be offered up for matching again
// and trip the unique index (or worse, double-clear).
// ============================================================================

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "../db";
import {
  reconciliations,
  statementLineMatches,
  statementLines,
} from "../db/schema/reconciliations";
import { journalLines } from "../db/schema/journals";

/**
 * Journal line IDs cleared by ANY reconciliation in the org.
 *
 * Org-wide on purpose: a ledger line cleared by last period's finalized
 * reconciliation must never be offered for matching again.
 */
export async function getOrgClaimedJournalLineIds(
  db: DbExecutor,
  orgId: string,
): Promise<Set<string>> {
  const [direct, split] = await Promise.all([
    db
      .select({ journalLineId: statementLines.matchedJournalLineId })
      .from(statementLines)
      .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
      // Any non-null 1:1 link is a claim. Filtering on matchStatus="matched"
      // missed "created" lines, which computeFinalizeBalances counts as
      // cleared — so a line cleared last period via "created" was offered for
      // matching again this period.
      .where(
        and(
          eq(reconciliations.organizationId, orgId),
          isNotNull(statementLines.matchedJournalLineId),
        ),
      ),
    db
      .select({ journalLineId: statementLineMatches.journalLineId })
      .from(statementLineMatches)
      .where(eq(statementLineMatches.organizationId, orgId)),
  ]);

  const claimed = new Set<string>();
  for (const row of direct) if (row.journalLineId) claimed.add(row.journalLineId);
  for (const row of split) claimed.add(row.journalLineId);
  return claimed;
}

/** How an existing claim on a journal line was made, and where it lives. */
export interface JournalLineClaim {
  journalLineId: string;
  statementLineId: string;
  via: "direct" | "split";
  /** The reconciliation holding the claim — what to unmatch, or to reopen. */
  reconciliationId: string;
  reconciliationStatus: string;
  periodEnd: string;
}

/**
 * Find the first journal line among `journalLineIds` that is ALREADY cleared
 * anywhere in the org — by either representation.
 *
 * This is the application-side twin of the 0048/0053 constraint triggers:
 * every write path that claims a journal line calls this first (directly or
 * through {@link setStatementLineClearing}) so the failure is an actionable
 * message, and the deferred trigger stays what it is meant to be — a
 * backstop for the path nobody thought of, not the primary UX.
 *
 * `excludeStatementLineId` ignores claims held by one statement line, so
 * re-matching the SAME line (which replaces its own claim in the same
 * transaction) is not reported as a conflict. `excludeReconciliationId`
 * ignores every claim held by one reconciliation, for a writer that replaces
 * that reconciliation's statement lines wholesale.
 */
export async function findClaimedJournalLine(
  db: DbExecutor,
  orgId: string,
  journalLineIds: string[],
  options?: { excludeStatementLineId?: string; excludeReconciliationId?: string },
): Promise<JournalLineClaim | null> {
  if (journalLineIds.length === 0) return null;
  const excludeLine = options?.excludeStatementLineId;
  const excludeRecon = options?.excludeReconciliationId;

  const [[direct], [split]] = await Promise.all([
    db
      .select({
        journalLineId: statementLines.matchedJournalLineId,
        statementLineId: statementLines.id,
        reconciliationId: reconciliations.id,
        reconciliationStatus: reconciliations.status,
        periodEnd: reconciliations.periodEnd,
      })
      .from(statementLines)
      .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
      .where(
        and(
          eq(reconciliations.organizationId, orgId),
          inArray(statementLines.matchedJournalLineId, journalLineIds),
          excludeLine ? ne(statementLines.id, excludeLine) : sql`true`,
          excludeRecon ? ne(reconciliations.id, excludeRecon) : sql`true`,
        ),
      )
      .limit(1),
    db
      .select({
        journalLineId: statementLineMatches.journalLineId,
        statementLineId: statementLineMatches.statementLineId,
        reconciliationId: reconciliations.id,
        reconciliationStatus: reconciliations.status,
        periodEnd: reconciliations.periodEnd,
      })
      .from(statementLineMatches)
      .innerJoin(statementLines, eq(statementLineMatches.statementLineId, statementLines.id))
      .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
      .where(
        and(
          eq(statementLineMatches.organizationId, orgId),
          inArray(statementLineMatches.journalLineId, journalLineIds),
          excludeLine ? ne(statementLineMatches.statementLineId, excludeLine) : sql`true`,
          excludeRecon ? ne(reconciliations.id, excludeRecon) : sql`true`,
        ),
      )
      .limit(1),
  ]);

  if (direct?.journalLineId) {
    return { ...direct, journalLineId: direct.journalLineId, via: "direct" };
  }
  if (split) return { ...split, via: "split" };
  return null;
}

/**
 * Standard message for a claim conflict, shared so every path says the same
 * thing — and says something the user can act on. A claim inside a finalized
 * reconciliation cannot be unmatched there (that reconciliation refuses
 * edits), so the advice is to reopen it, not to unmatch.
 */
export function claimConflictMessage(
  claim: JournalLineClaim,
  currentReconciliationId?: string,
): string {
  const how = claim.via === "direct" ? "matched to a statement line" : "cleared by a split match";
  if (claim.reconciliationStatus === "finalized") {
    return `This ledger transaction is already ${how} in the finalized reconciliation for the period ending ${claim.periodEnd}. Reopen that reconciliation to change it.`;
  }
  if (currentReconciliationId && claim.reconciliationId !== currentReconciliationId) {
    return `This ledger transaction is already ${how} in the reconciliation for the period ending ${claim.periodEnd}. Unmatch it there first.`;
  }
  return claim.via === "direct"
    ? "This ledger transaction is already matched to another statement line. Unmatch it first before re-assigning."
    : "This ledger transaction is already cleared by a split match. Remove that split before re-assigning.";
}

/** What a statement line's clearing becomes. */
export type StatementLineClearing =
  | { action: "match"; journalLineId: string; confidence?: string | null }
  | { action: "ignore" }
  | { action: "unmatch" };

/**
 * Redefine one statement line's clearing — the ONE write sequence every
 * match, ignore and unmatch path uses.
 *
 * It was copy-pasted across matchTransaction, applySuggestion and the agent
 * loop, and the copies drifted: the suggestion and agent "ignore" branches
 * set matchStatus without clearing the 1:1 link or the split rows, so an
 * ignored line kept its journal line claimed (finalize does not count
 * "ignored", yet the claim checks and the unique index still blocked that
 * journal line for every other statement line in the org).
 *
 * Any redefinition — match, ignore or unmatch — drops the line's split rows
 * and sets the 1:1 column to the new link or NULL. A match is claim-checked
 * first across both representations, org-wide; the conflict is returned
 * (not thrown) so a batch caller can skip it and an interactive one can
 * report it. Returns whether the line was written.
 */
export async function setStatementLineClearing(
  db: DbExecutor,
  input: {
    orgId: string;
    reconciliationId: string;
    statementLineId: string;
    clearing: StatementLineClearing;
  },
): Promise<{ written: true } | { written: false; conflict: JournalLineClaim }> {
  const { orgId, reconciliationId, statementLineId, clearing } = input;

  if (clearing.action === "match") {
    const conflict = await findClaimedJournalLine(db, orgId, [clearing.journalLineId], {
      excludeStatementLineId: statementLineId,
    });
    if (conflict) return { written: false, conflict };
  }

  await db
    .delete(statementLineMatches)
    .where(
      and(
        eq(statementLineMatches.statementLineId, statementLineId),
        eq(statementLineMatches.organizationId, orgId),
      ),
    );

  await db
    .update(statementLines)
    .set(
      clearing.action === "match"
        ? {
            matchedJournalLineId: clearing.journalLineId,
            matchStatus: "matched",
            ...(clearing.confidence !== undefined ? { matchConfidence: clearing.confidence } : {}),
          }
        : {
            matchedJournalLineId: null,
            matchStatus: clearing.action === "ignore" ? "ignored" : "unmatched",
          },
    )
    .where(
      and(
        eq(statementLines.id, statementLineId),
        eq(statementLines.reconciliationId, reconciliationId),
      ),
    );

  return { written: true };
}

/**
 * Whether any of these journal headers has a line cleared by a FINALIZED
 * reconciliation — via either representation.
 *
 * Shared by the bill and invoice void paths: voiding a journal out from
 * under a finalized reconciliation makes its snapshot unreproducible, and the
 * invoice path's original inline check read only the 1:1 column.
 */
export async function journalsClearedByFinalizedReconciliation(
  db: DbExecutor,
  orgId: string,
  journalHeaderIds: string[],
): Promise<boolean> {
  if (journalHeaderIds.length === 0) return false;

  const [direct] = await db
    .select({ id: statementLines.id })
    .from(statementLines)
    .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
    .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
    .where(
      and(
        eq(reconciliations.organizationId, orgId),
        eq(reconciliations.status, "finalized"),
        inArray(journalLines.journalHeaderId, journalHeaderIds),
      ),
    )
    .limit(1);
  if (direct) return true;

  const [split] = await db
    .select({ id: statementLineMatches.id })
    .from(statementLineMatches)
    .innerJoin(journalLines, eq(statementLineMatches.journalLineId, journalLines.id))
    .innerJoin(statementLines, eq(statementLineMatches.statementLineId, statementLines.id))
    .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
    .where(
      and(
        eq(statementLineMatches.organizationId, orgId),
        eq(reconciliations.status, "finalized"),
        inArray(journalLines.journalHeaderId, journalHeaderIds),
      ),
    )
    .limit(1);
  return Boolean(split);
}
