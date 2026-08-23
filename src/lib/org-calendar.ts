/**
 * Organization-local calendar dates.
 *
 * Journal dates are calendar days, and "today" depends on whose calendar.
 * Several posting paths stamped `new Date().toISOString().slice(0, 10)` — the
 * UTC day — so a payment recorded at 07:00 on 1 September in Manila was
 * journaled on 31 August: the prior month, the prior VAT period, and possibly
 * a period that is closed. Every default day now comes from the org's own
 * timezone (`organization_accounting_settings.timezone`, default UTC).
 */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { organizationAccountingSettings } from "../db/schema/inbox";

/** The org's IANA timezone, defaulting to UTC when unset or unreadable. */
export async function resolveOrgTimezone(db: DbExecutor, orgId: string): Promise<string> {
  const [settings] = await db
    .select({ timezone: organizationAccountingSettings.timezone })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  return settings?.timezone || "UTC";
}

/**
 * The calendar date (YYYY-MM-DD) of an instant in a timezone.
 *
 * Pure so the timezone arithmetic is unit-testable; an invalid timezone falls
 * back to UTC rather than throwing, because a typo'd setting must not make
 * every payment in the org unpostable.
 */
export function orgDateOf(at: Date, timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Today's date on the org's calendar. */
export async function currentOrgDate(db: DbExecutor, orgId: string): Promise<string> {
  return orgDateOf(new Date(), await resolveOrgTimezone(db, orgId));
}

/**
 * The first open day after a period-close boundary.
 *
 * Date-string arithmetic in UTC on purpose: `closedThrough` is a calendar
 * date, and constructing it at UTC noon sidesteps DST edges entirely.
 */
export function firstOpenDateAfter(closedThrough: string): string {
  const at = new Date(`${closedThrough}T12:00:00.000Z`);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`Period boundary "${closedThrough}" is not a date.`);
  }
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
