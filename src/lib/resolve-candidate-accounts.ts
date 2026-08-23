import type { DbExecutor } from "../db";

/**
 * The COA account ids to search when matching a reconciliation's statement
 * lines: exactly the reconciliation's own ledger account.
 *
 * This used to include every SIBLING under the same parent plus the parent
 * itself, while computeFinalizeBalances sums only the exact account. A
 * Checking statement line auto-matched to a Savings journal line of the same
 * amount looked matched, contributed nothing to the cleared balance — a
 * permanent clearedDifference — and claimed the Savings line org-wide so its
 * own reconciliation could never clear it. Siblings belong to their own
 * reconciliations; a parent-posted line staying visibly unmatched is the
 * honest outcome.
 *
 * The signature keeps the executor (and stays async) so the four call sites
 * did not change; the narrowing is the entire fix.
 */
export async function resolveCandidateAccountIds(
  _db: DbExecutor,
  ledgerAccountId: string,
): Promise<string[]> {
  return [ledgerAccountId];
}
