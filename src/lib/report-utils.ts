/**
 * Pure utility functions for financial reports.
 * No database or server dependencies — safe to import anywhere.
 */

export { formatCurrency } from "../utils/format";

// ─── Period Label ────────────────────────────────────────────
const monthFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
});

/**
 * Returns a human-readable period label, e.g. "January 2026"
 */
export function periodLabel(dateFrom: string, _dateTo?: string): string {
  const d = new Date(`${dateFrom}T00:00:00`);
  return monthFormatter.format(d);
}

// ─── Month Range ─────────────────────────────────────────────
/**
 * Given a YYYY-MM string, returns the first and last day of the month as ISO date strings.
 */
export function getMonthRange(yearMonth: string): { start: string; end: string } {
  const [yearStr, monthStr] = yearMonth.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  // Last day: go to next month's 0th day
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

/**
 * Returns the current month as YYYY-MM.
 */
export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ─── Prior Period / Year ─────────────────────────────────────
/**
 * Navigate months by offset (negative = past, positive = future).
 * Input: "YYYY-MM", offset: number of months
 */
export function offsetMonth(yearMonth: string, offset: number): string {
  const [yearStr, monthStr] = yearMonth.split("-");
  const d = new Date(Number.parseInt(yearStr, 10), Number.parseInt(monthStr, 10) - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Compute the prior period by mirroring the actual date span.
 * e.g. Feb 1–28 (28 days) → Jan 4–31 (the 28 days before Feb 1)
 * e.g. single day Feb 16 → Feb 15 (the day before)
 */
export function getPriorPeriodRange(
  dateFrom: string,
  dateTo: string,
): { start: string; end: string } {
  // Report dates are calendar dates, not instants in the server's local time
  // zone. UTC arithmetic keeps the inclusive span stable across DST changes.
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  const spanMs = to.getTime() - from.getTime() + 86_400_000; // inclusive day count
  const priorEnd = new Date(from.getTime() - 86_400_000); // day before dateFrom
  const priorStart = new Date(priorEnd.getTime() - spanMs + 86_400_000);

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

  return { start: fmt(priorStart), end: fmt(priorEnd) };
}

/**
 * Prior as-of date for a balance-sheet comparison: one month before `asOf`, clamped to the
 * end of the prior month when the day doesn't exist there (2026-03-31 → 2026-02-28).
 *
 * A balance sheet is a point-in-time snapshot, so its comparison column is a prior DATE, not a
 * mirrored span. (getPriorPeriodRange, used for the P&L, would wrongly yield "yesterday" here.)
 */
export function getPriorAsOfDate(asOf: string): string {
  const [y, m, d] = asOf.split("-").map(Number);
  let py = y;
  let pm = m - 1; // target month, 1-based
  if (pm < 1) {
    pm = 12;
    py = y - 1;
  }
  const lastDay = new Date(py, pm, 0).getDate(); // last day of 1-based month `pm`
  const pd = Math.min(d, lastDay);
  return `${py}-${String(pm).padStart(2, "0")}-${String(pd).padStart(2, "0")}`;
}

// ─── Change Computation ─────────────────────────────────────
export interface ChangeResult {
  amount: number;
  pct: number | null; // null when prior is 0
  direction: "up" | "down" | "flat";
}

export function computeChange(current: number, prior: number): ChangeResult {
  const amount = current - prior;
  const pct = prior !== 0 ? (amount / Math.abs(prior)) * 100 : null;
  const direction = amount > 0.005 ? "up" : amount < -0.005 ? "down" : "flat";
  return { amount, pct, direction };
}

// ─── Balance Normalization ───────────────────────────────────
/**
 * Debit-normal accounts (Assets, Expenses): positive when DR > CR.
 * Credit-normal accounts (Liabilities, Equity, Revenue): positive when CR > DR.
 * Input `rawBalance` = totalDebit - totalCredit.
 */
const CREDIT_NORMAL_TYPES = new Set(["liability", "equity", "revenue", "other_income"]);

export function normalizeBalance(rawBalance: number, accountType: string): number {
  return CREDIT_NORMAL_TYPES.has(accountType) ? -rawBalance : rawBalance;
}

// ─── Aging Bucket Helpers ────────────────────────────────────
/**
 * Given a due date and an as-of date, returns how many days past due.
 * Returns 0 if not yet due.
 */
export function daysPastDue(dueDate: string, asOfDate: string): number {
  const due = new Date(`${dueDate}T00:00:00`);
  const asOf = new Date(`${asOfDate}T00:00:00`);
  const diff = Math.floor((asOf.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

/**
 * Given days past due and bucket thresholds [30, 60, 90],
 * returns the bucket index (0 = current, 1 = 1-30, 2 = 31-60, etc.).
 */
export function getBucketIndex(days: number, buckets: number[]): number {
  if (days === 0) return 0;
  for (let i = 0; i < buckets.length; i++) {
    if (days <= buckets[i]) return i + 1;
  }
  return buckets.length + 1; // overflow bucket (e.g. 90+)
}

/**
 * Returns human-readable bucket labels for the given thresholds.
 * e.g. [30, 60, 90] → ["Current", "1-30", "31-60", "61-90", "90+"]
 */
export function getBucketLabels(buckets: number[]): string[] {
  const labels = ["Current"];
  for (let i = 0; i < buckets.length; i++) {
    const start = i === 0 ? 1 : buckets[i - 1] + 1;
    labels.push(`${start}-${buckets[i]}`);
  }
  labels.push(`${buckets[buckets.length - 1]}+`);
  return labels;
}
