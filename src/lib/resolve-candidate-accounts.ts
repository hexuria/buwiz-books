import { eq } from "drizzle-orm";
import { accounts } from "../db/schema/accounts";
import type { DbExecutor } from "../db";

/**
 * Resolve all COA account IDs that should be searched for a given ledger account.
 * Returns the ledgerAccountId itself, its sibling accounts under the same parent,
 * and the parent account — since transactions may be posted at any of these levels.
 */
export async function resolveCandidateAccountIds(
  db: DbExecutor,
  ledgerAccountId: string,
): Promise<string[]> {
  const candidateIds: string[] = [ledgerAccountId];

  const [ledgerAcct] = await db
    .select({ parentId: accounts.parentId })
    .from(accounts)
    .where(eq(accounts.id, ledgerAccountId))
    .limit(1);

  if (ledgerAcct?.parentId) {
    const siblings = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.parentId, ledgerAcct.parentId));

    for (const s of siblings) {
      if (!candidateIds.includes(s.id)) candidateIds.push(s.id);
    }
    if (!candidateIds.includes(ledgerAcct.parentId)) {
      candidateIds.push(ledgerAcct.parentId);
    }
  }

  return candidateIds;
}
