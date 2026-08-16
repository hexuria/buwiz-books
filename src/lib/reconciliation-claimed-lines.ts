// ============================================================================
// Which ledger lines are already cleared by a reconciliation.
//
// A ledger line can be claimed two ways: the 1:1
// statementLines.matchedJournalLineId column, or a split row in
// statement_line_matches. Every matcher and candidate query must consider
// BOTH, or a line cleared by a split would be offered up for matching again
// and trip the unique index (or worse, double-clear).
// ============================================================================

import { and, eq } from "drizzle-orm";
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
      .where(
        and(eq(reconciliations.organizationId, orgId), eq(statementLines.matchStatus, "matched")),
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
