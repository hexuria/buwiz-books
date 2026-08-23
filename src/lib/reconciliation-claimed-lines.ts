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

/** Journal line IDs already claimed within a reconciliation. */
export async function getClaimedJournalLineIds(
  db: DbExecutor,
  reconciliationId: string,
): Promise<Set<string>> {
  const [direct, split] = await Promise.all([
    db
      .select({ journalLineId: statementLines.matchedJournalLineId })
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, reconciliationId)),
    db
      .select({ journalLineId: statementLineMatches.journalLineId })
      .from(statementLineMatches)
      .innerJoin(statementLines, eq(statementLineMatches.statementLineId, statementLines.id))
      .where(eq(statementLines.reconciliationId, reconciliationId)),
  ]);

  const claimed = new Set<string>();
  for (const row of direct) if (row.journalLineId) claimed.add(row.journalLineId);
  for (const row of split) claimed.add(row.journalLineId);
  return claimed;
}

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

/** How an existing claim on a journal line was made. */
export interface JournalLineClaim {
  journalLineId: string;
  statementLineId: string;
  via: "direct" | "split";
}

/**
 * Find the first journal line among `journalLineIds` that is ALREADY cleared
 * anywhere in the org — by either representation.
 *
 * This is the application-side twin of the 0048 constraint triggers: every
 * write path that claims a journal line calls this first so the failure is an
 * actionable message, and the deferred trigger stays what it is meant to be —
 * a backstop for the path nobody thought of, not the primary UX.
 *
 * `excludeStatementLineId` ignores claims held by one statement line, so
 * re-matching the SAME line (which replaces its own claim in the same
 * transaction) is not reported as a conflict.
 */
export async function findClaimedJournalLine(
  db: DbExecutor,
  orgId: string,
  journalLineIds: string[],
  options?: { excludeStatementLineId?: string },
): Promise<JournalLineClaim | null> {
  if (journalLineIds.length === 0) return null;
  const exclude = options?.excludeStatementLineId;

  const [direct] = await db
    .select({
      journalLineId: statementLines.matchedJournalLineId,
      statementLineId: statementLines.id,
    })
    .from(statementLines)
    .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
    .where(
      and(
        eq(reconciliations.organizationId, orgId),
        inArray(statementLines.matchedJournalLineId, journalLineIds),
        exclude ? ne(statementLines.id, exclude) : sql`true`,
      ),
    )
    .limit(1);
  if (direct?.journalLineId) {
    return {
      journalLineId: direct.journalLineId,
      statementLineId: direct.statementLineId,
      via: "direct",
    };
  }

  const [split] = await db
    .select({
      journalLineId: statementLineMatches.journalLineId,
      statementLineId: statementLineMatches.statementLineId,
    })
    .from(statementLineMatches)
    .where(
      and(
        eq(statementLineMatches.organizationId, orgId),
        inArray(statementLineMatches.journalLineId, journalLineIds),
        exclude ? ne(statementLineMatches.statementLineId, exclude) : sql`true`,
      ),
    )
    .limit(1);
  if (split) {
    return {
      journalLineId: split.journalLineId,
      statementLineId: split.statementLineId,
      via: "split",
    };
  }

  return null;
}

/** Standard message for a claim conflict, shared so every path says the same thing. */
export function claimConflictMessage(claim: JournalLineClaim): string {
  return claim.via === "direct"
    ? "This ledger transaction is already matched to another statement line. Unmatch it first before re-assigning."
    : "This ledger transaction is already cleared by a split match. Remove that split before re-assigning.";
}
