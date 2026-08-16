/**
 * Account Tree Helpers
 *
 * Shared utilities for traversing the account hierarchy.
 * Uses a single DB query + in-memory traversal to avoid N+1 patterns.
 */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { accounts } from "../db/schema/accounts";
import { descendantAccountIds } from "./account-hierarchy";

export { descendantAccountIds } from "./account-hierarchy";

/**
 * Get all descendant account IDs for a given parent, using a single query.
 * Fetches all org accounts, builds a child-map, and walks the tree in-memory.
 * Runs on the caller's executor (ctx.db) so it stays inside RLS org context.
 */
export async function getAllDescendantIds(
  db: DbExecutor,
  parentId: string,
  orgId: string,
): Promise<string[]> {
  const allAccounts = await db
    .select({ id: accounts.id, parentId: accounts.parentId })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));

  return descendantAccountIds(allAccounts, parentId);
}
