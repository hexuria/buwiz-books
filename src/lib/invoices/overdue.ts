// ============================================================================
// Overdue invoice sweep — the ONE place sent/viewed invoices become overdue.
//
// History: listInvoices (a GET) used to run this UPDATE inline, so a read
// endpoint mutated state — retries, prefetches, and idle tabs all wrote to
// the database. The list now only DERIVES the display status; persisting the
// transition is an explicit mutation (refreshOverdueInvoices) the invoices
// page fires on load.
//
// Timezone: "past due" is evaluated against the calendar date in the ORG'S
// OWN timezone (organization_accounting_settings.timezone, default UTC) — a
// Manila org's invoice due 2026-08-24 is not overdue at 08:00 UTC on the
// 24th just because UTC already rolled over.
// ============================================================================
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { organizationAccountingSettings } from "../../db/schema/inbox";
import { invoices } from "../../db/schema/invoices";

/** Today's date (YYYY-MM-DD) as seen by the overdue rule, in `timeZone`. */
export function overdueCutoffDate(now: Date = new Date(), timeZone = "UTC"): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The org's own cutoff date, from its accounting-settings timezone. */
export async function orgOverdueCutoffDate(db: DbExecutor, orgId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: organizationAccountingSettings.timezone })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  return overdueCutoffDate(new Date(), row?.timezone ?? "UTC");
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
  cutoff?: string,
): Promise<number> {
  const effectiveCutoff = cutoff ?? (await orgOverdueCutoffDate(db, orgId));
  const updated = await db
    .update(invoices)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(
      and(
        eq(invoices.organizationId, orgId),
        inArray(invoices.status, [...OVERDUE_SWEEPABLE_STATUSES]),
        sql`${invoices.dueDate} IS NOT NULL`,
        lt(invoices.dueDate, effectiveCutoff),
      ),
    )
    .returning({ id: invoices.id });
  return updated.length;
}
