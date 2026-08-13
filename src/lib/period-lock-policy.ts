/**
 * Decide whether a ledger date falls inside an organization's closed period.
 *
 * This policy accepts an already-loaded close boundary so callers can enforce it
 * inside their own transaction without importing the database adapter.
 */
export function isDateLocked(transactionDate: string, closedThrough: string | null): boolean {
  if (!closedThrough) return false;
  return transactionDate <= closedThrough;
}
