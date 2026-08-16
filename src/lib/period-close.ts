import { db, type DbExecutor } from "../db";
import { organization } from "../db/schema/auth";
import { eq } from "drizzle-orm";

/**
 * Helper: Check if a transaction date falls within a locked period
 * Used by transaction CRUD functions for enforcement
 */
export async function isDateInLockedPeriod(
  orgId: string,
  transactionDate: string,
  executor: DbExecutor = db,
): Promise<{ locked: boolean; closedThrough: string | null }> {
  const [org] = await executor
    .select({ closedThrough: organization.closedThrough })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  const closedThrough = org?.closedThrough ?? null;
  return { locked: isDateLocked(transactionDate, closedThrough), closedThrough };
}

/**
 * Fetch an organization's period-close boundary once (for callers that need to check many
 * dates in a loop without re-querying per date, e.g. bulk imports).
 */
export async function getClosedThrough(
  orgId: string,
  executor: DbExecutor = db,
): Promise<string | null> {
  const [org] = await executor
    .select({ closedThrough: organization.closedThrough })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return org?.closedThrough ?? null;
}

/**
 * Pure check: is an ISO date (YYYY-MM-DD) on or before the close boundary?
 * ISO date strings compare correctly lexicographically.
 */
export function isDateLocked(transactionDate: string, closedThrough: string | null): boolean {
  if (!closedThrough) return false;
  return transactionDate <= closedThrough;
}
