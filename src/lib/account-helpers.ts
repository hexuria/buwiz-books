/**
 * Account Tree Helpers
 *
 * Shared utilities for traversing the account hierarchy.
 * Uses a single DB query + in-memory traversal to avoid N+1 patterns.
 */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { accounts } from "../db/schema/accounts";

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

  // Build parent → children lookup
  const childMap = new Map<string | null, string[]>();
  for (const a of allAccounts) {
    const key = a.parentId ?? null;
    const bucket = childMap.get(key) ?? [];
    bucket.push(a.id);
    childMap.set(key, bucket);
  }

  // Iterative DFS — no recursion, no extra queries
  const result: string[] = [];
  const stack = [...(childMap.get(parentId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    result.push(current);
    const children = childMap.get(current);
    if (children) {
      stack.push(...children);
    }
  }

  return result;
}
