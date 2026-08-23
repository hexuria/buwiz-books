// ============================================================================
// Overdue invoice sweep — the ONE place sent/viewed invoices become overdue.
//
// History: listInvoices (a GET) used to run this UPDATE inline, so a read
// endpoint mutated state — retries, prefetches, and idle tabs all wrote to
// the database. The list now only DERIVES the display status; persisting the
// transition is an explicit mutation (refreshOverdueInvoices) the invoices
// page fires on load.
//
// Timezone: "past due" is evaluated against the UTC calendar date. The org
// has no timezone setting yet (the P12 country/settings work is the natural
// home for one); when it grows one, thread it into overdueCutoffDate.
// ============================================================================
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { invoices } from "../../db/schema/invoices";

/** Today's date (YYYY-MM-DD) as seen by the overdue rule. */
export function overdueCutoffDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Statuses the sweep may advance. Everything else is never touched. */
export const OVERDUE_SWEEPABLE_STATUSES = ["sent", "viewed"] as const;

/**
 * Display-only derivation for list reads: a sent/viewed invoice past its due
 * date SHOWS as overdue even before the sweep has persisted the transition.
 */
export function deriveDisplayStatus<T extends { status: string; dueDate: string | null }>(
  row: T,
  cutoff: string = overdueCutoffDate(),
): T {
  if (
    (row.status === "sent" || row.status === "viewed") &&
    row.dueDate !== null &&
    row.dueDate < cutoff
  ) {
    return { ...row, status: "overdue" };
  }
  return row;
}

/**
 * Persist sent/viewed → overdue for every invoice past due. Org-scoped,
 * idempotent, and safe to call from any mutation path. Returns the number of
 * invoices transitioned.
 */
export async function sweepOverdueInvoices(
  db: DbExecutor,
  orgId: string,
  cutoff: string = overdueCutoffDate(),
): Promise<number> {
  const updated = await db
    .update(invoices)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(
      and(
        eq(invoices.organizationId, orgId),
        inArray(invoices.status, [...OVERDUE_SWEEPABLE_STATUSES]),
        sql`${invoices.dueDate} IS NOT NULL`,
        lt(invoices.dueDate, cutoff),
      ),
    )
    .returning({ id: invoices.id });
  return updated.length;
}
