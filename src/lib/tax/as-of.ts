/**
 * The effective-dated lookup discipline.
 *
 * Every Philippine tax rule in this product is effective-dated, and every
 * computation must resolve rules against the date of the TRANSACTION or the
 * PERIOD — never against `now()`. Getting this wrong is not a visible bug: an
 * amended 2024 return silently recomputes under 2026 rates and the number
 * simply comes out different, with nothing to catch it.
 *
 * So the as-of date is a branded type rather than a `string`. A caller cannot
 * pass a bare date, cannot default it, and cannot reach a reference table
 * without going through `asOf()` — which is a deliberate speed bump in front of
 * the one decision that matters. `asOfNow()` exists for genuinely
 * present-tense work and is named so it stands out in review.
 *
 * See DECISIONS D1 ("every tax computation takes a mandatory asOf date derived
 * from the transaction or period — never now()").
 */

declare const AS_OF_BRAND: unique symbol;

/** An ISO `YYYY-MM-DD` date that has been deliberately chosen as a rule as-of date. */
export type AsOfDate = string & { readonly [AS_OF_BRAND]: true };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidAsOfDateError extends Error {
  constructor(received: unknown) {
    super(
      `as-of date must be an ISO YYYY-MM-DD string or a Date, received ${JSON.stringify(received)}`,
    );
    this.name = "InvalidAsOfDateError";
  }
}

/**
 * Brand a date as the as-of date for a rule lookup.
 *
 * Pass the transaction date, the period end, or the pay date — whichever the
 * governing rule keys on. For withholding, RR 4-2024 §2.57.4 makes that the
 * EARLIER of the payor's booking date and the seller's invoice date, not the
 * payment date.
 */
export function asOf(date: string | Date): AsOfDate {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new InvalidAsOfDateError(date);
    return date.toISOString().slice(0, 10) as AsOfDate;
  }
  if (typeof date !== "string" || !ISO_DATE.test(date)) throw new InvalidAsOfDateError(date);
  // Reject 2026-02-31 and friends: Postgres would, and a silently shifted date
  // could select the wrong effective-dated row.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new InvalidAsOfDateError(date);
  }
  return date as AsOfDate;
}

/**
 * The current date as an as-of date.
 *
 * Correct only for genuinely present-tense questions ("what rate applies to a
 * payment I am making right now?"). Anything touching a stored transaction, a
 * filing period, or an amendment must use that record's own date instead.
 */
export function asOfNow(): AsOfDate {
  return asOf(new Date());
}

/**
 * Whether an effective-dated row is in force on `at`.
 *
 * Half-open by design: `effectiveTo` is the last day the row is in force, and
 * a NULL `effectiveTo` means "still current". Both bounds inclusive matches how
 * BIR issuances read ("effective 1 January 2023" / "until 31 December 2022").
 */
export function isInForce(
  row: { effectiveFrom: string; effectiveTo: string | null },
  at: AsOfDate,
): boolean {
  if (at < row.effectiveFrom) return false;
  if (row.effectiveTo !== null && at > row.effectiveTo) return false;
  return true;
}

/**
 * Pick the row in force on `at` from rows sharing a natural key.
 *
 * Returns null rather than throwing: callers decide whether a missing rule is
 * an error (a withholding rate) or an absence (an optional ceiling), and a
 * thrown error here would lose that distinction.
 */
export function pickInForce<T extends { effectiveFrom: string; effectiveTo: string | null }>(
  rows: readonly T[],
  at: AsOfDate,
): T | null {
  const inForce = rows.filter((row) => isInForce(row, at));
  if (inForce.length === 0) return null;
  // Overlapping rows are a data bug, but picking the latest-starting one is the
  // least surprising resolution and matches "the most recent issuance wins".
  return inForce.reduce((best, row) => (row.effectiveFrom > best.effectiveFrom ? row : best));
}
