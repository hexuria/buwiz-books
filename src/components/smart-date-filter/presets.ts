// ============================================================================
// Smart Date Filter — Preset Computation Utilities
// ============================================================================

import type { DatePreset, PresetOption, DateGranularity } from "./types";

/** Format a Date to YYYY-MM-DD using local time (avoids UTC shift from toISOString) */
function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Get the list of available presets for the combo box */
export function getPresetList(): PresetOption[] {
  return [
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
    { value: "last_7_days", label: "Last 7 Days" },
    { value: "last_30_days", label: "Last 30 Days" },
    { value: "this_month", label: "This Month" },
    { value: "last_month", label: "Last Month" },
    { value: "this_quarter", label: "This Quarter" },
    { value: "last_quarter", label: "Last Quarter" },
    { value: "this_year", label: "This Year" },
    { value: "last_year", label: "Last Year" },
    { value: "year_to_date", label: "Year to Date" },
  ];
}

/** Get the quarter (0-based) for a month (0-based) */
function getQuarter(month: number): number {
  return Math.floor(month / 3);
}

/**
 * Compute the date range for a given preset.
 * All calculations use the provided referenceDate (defaults to now).
 */
export function computePreset(
  preset: DatePreset,
  referenceDate?: Date,
): { from: string; to: string; label: string } {
  const now = referenceDate ?? new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  switch (preset) {
    case "today": {
      const today = new Date(y, m, d);
      return { from: fmt(today), to: fmt(today), label: "Today" };
    }
    case "yesterday": {
      const yest = new Date(y, m, d - 1);
      return { from: fmt(yest), to: fmt(yest), label: "Yesterday" };
    }
    case "last_7_days": {
      const end = new Date(y, m, d);
      const start = new Date(y, m, d - 6);
      return { from: fmt(start), to: fmt(end), label: "Last 7 Days" };
    }
    case "last_30_days": {
      const end = new Date(y, m, d);
      const start = new Date(y, m, d - 29);
      return { from: fmt(start), to: fmt(end), label: "Last 30 Days" };
    }
    case "this_month": {
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0);
      return { from: fmt(start), to: fmt(end), label: "This Month" };
    }
    case "last_month": {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return { from: fmt(start), to: fmt(end), label: "Last Month" };
    }
    case "this_quarter": {
      const q = getQuarter(m);
      const start = new Date(y, q * 3, 1);
      const end = new Date(y, q * 3 + 3, 0);
      return { from: fmt(start), to: fmt(end), label: "This Quarter" };
    }
    case "last_quarter": {
      const q = getQuarter(m);
      const prevQ = q === 0 ? 3 : q - 1;
      const prevY = q === 0 ? y - 1 : y;
      const start = new Date(prevY, prevQ * 3, 1);
      const end = new Date(prevY, prevQ * 3 + 3, 0);
      return { from: fmt(start), to: fmt(end), label: "Last Quarter" };
    }
    case "this_year": {
      const start = new Date(y, 0, 1);
      const end = new Date(y, 11, 31);
      return { from: fmt(start), to: fmt(end), label: "This Year" };
    }
    case "last_year": {
      const start = new Date(y - 1, 0, 1);
      const end = new Date(y - 1, 11, 31);
      return { from: fmt(start), to: fmt(end), label: "Last Year" };
    }
    case "year_to_date": {
      const start = new Date(y, 0, 1);
      const end = new Date(y, m + 1, 0);
      return { from: fmt(start), to: fmt(end), label: "Year to Date" };
    }
    case "custom":
      return { from: fmt(now), to: fmt(now), label: "Custom" };
  }
}

/** Month names abbreviation */
const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Compute a date range from a granularity selection.
 * - day: returns the full month range for the given year/month
 * - month: returns first→last day of the selected month
 * - quarter: returns first→last day of the selected quarter (1-4)
 * - year: returns Jan 1→Dec 31 of the selected year
 */
export function computeGranularityRange(
  granularity: DateGranularity,
  year: number,
  value: number, // 0-based month, 1-based quarter, or ignored for year
): { from: string; to: string; label: string } {
  switch (granularity) {
    case "day":
    case "month": {
      const start = new Date(year, value, 1);
      const end = new Date(year, value + 1, 0);
      return {
        from: fmt(start),
        to: fmt(end),
        label: `${MONTH_ABBR[value]} ${year}`,
      };
    }
    case "quarter": {
      const qStart = (value - 1) * 3;
      const start = new Date(year, qStart, 1);
      const end = new Date(year, qStart + 3, 0);
      return {
        from: fmt(start),
        to: fmt(end),
        label: `Q${String(value)} ${String(year)}`,
      };
    }
    case "year": {
      const start = new Date(year, 0, 1);
      const end = new Date(year, 11, 31);
      return {
        from: fmt(start),
        to: fmt(end),
        label: String(year),
      };
    }
  }
}

/** Format a date range for display as a human-readable label */
export function formatRangeLabel(from: string, to: string): string {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");

  // Same day
  if (from === to) {
    return f.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // Full year: Jan 1 – Dec 31
  if (
    f.getFullYear() === t.getFullYear() &&
    f.getMonth() === 0 &&
    f.getDate() === 1 &&
    t.getMonth() === 11 &&
    t.getDate() === 31
  ) {
    return String(f.getFullYear());
  }

  // Full quarter: starts on 1st of quarter month, ends on last day of quarter end month
  if (f.getFullYear() === t.getFullYear() && f.getDate() === 1) {
    const qStart = Math.floor(f.getMonth() / 3) * 3;
    if (f.getMonth() === qStart) {
      const qEnd = qStart + 2;
      const qEndLastDay = new Date(f.getFullYear(), qEnd + 1, 0).getDate();
      if (t.getMonth() === qEnd && t.getDate() === qEndLastDay) {
        return `Q${Math.floor(qStart / 3) + 1} ${f.getFullYear()}`;
      }
    }
  }

  // Same month
  if (f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth()) {
    if (
      f.getDate() === 1 &&
      t.getDate() === new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate()
    ) {
      return f.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
  }

  // Same year
  if (f.getFullYear() === t.getFullYear()) {
    const fStr = f.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tStr = t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${fStr} – ${tStr}`;
  }

  // Different years
  const fStr = f.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const tStr = t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fStr} – ${tStr}`;
}

// ============================================================================
// Date Navigation — Prev / Next step utilities
// ============================================================================

/**
 * Step descriptor for prev/next navigation.
 * - "day"     → shift by 1 day  (Today / Yesterday / single-day custom)
 * - "days_N"  → shift by N days (Last 7, Last 30, or any custom N-day span)
 * - "month"   → shift by 1 calendar month
 * - "quarter" → shift by 1 quarter (3 months)
 * - "year"    → shift by 1 year
 * - "none"    → navigation disabled (Year to Date)
 */
type DateStepKind = "day" | "month" | "quarter" | "year" | "none";
interface DateStep {
  kind: DateStepKind;
  days?: number; // only set for custom day-based steps
}

/** Detect the appropriate step size from the current date range */
function detectDateStep(from: string, to: string): DateStep {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const now = new Date();

  // Year to Date: Jan 1 of current year → today (or close to today)
  const isYTD =
    f.getFullYear() === now.getFullYear() &&
    f.getMonth() === 0 &&
    f.getDate() === 1 &&
    t.getFullYear() === now.getFullYear() &&
    // Allow a 1-day tolerance for "today" vs "yesterday" edge
    Math.abs(t.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) <=
      86400000;
  if (isYTD) return { kind: "none" };

  // Full year: Jan 1 – Dec 31
  if (
    f.getMonth() === 0 &&
    f.getDate() === 1 &&
    t.getMonth() === 11 &&
    t.getDate() === 31 &&
    f.getFullYear() === t.getFullYear()
  ) {
    return { kind: "year" };
  }

  // Full quarter: 1st of quarter-start → last day of quarter-end, same year
  if (f.getFullYear() === t.getFullYear() && f.getDate() === 1) {
    const qStart = Math.floor(f.getMonth() / 3) * 3;
    if (f.getMonth() === qStart) {
      const qEnd = qStart + 2;
      const qEndLastDay = new Date(f.getFullYear(), qEnd + 1, 0).getDate();
      if (t.getMonth() === qEnd && t.getDate() === qEndLastDay) {
        return { kind: "quarter" };
      }
    }
  }

  // Full month: 1st → last day, same month
  if (
    f.getFullYear() === t.getFullYear() &&
    f.getMonth() === t.getMonth() &&
    f.getDate() === 1 &&
    t.getDate() === new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()
  ) {
    return { kind: "month" };
  }

  // Single day
  if (from === to) {
    return { kind: "day" };
  }

  // Custom N-day span
  const diffMs = t.getTime() - f.getTime();
  const diffDays = Math.round(diffMs / 86400000) + 1; // inclusive
  return { kind: "day", days: diffDays };
}

/** Shift a date range backward by one step */
export function computePrevRange(from: string, to: string): { from: string; to: string } {
  const step = detectDateStep(from, to);
  const f = new Date(from + "T00:00:00");

  switch (step.kind) {
    case "none":
      return { from, to }; // no-op

    case "year": {
      return {
        from: fmt(new Date(f.getFullYear() - 1, 0, 1)),
        to: fmt(new Date(f.getFullYear() - 1, 11, 31)),
      };
    }

    case "quarter": {
      const qStart = Math.floor(f.getMonth() / 3);
      const prevQ = qStart === 0 ? 3 : qStart - 1;
      const prevY = qStart === 0 ? f.getFullYear() - 1 : f.getFullYear();
      return {
        from: fmt(new Date(prevY, prevQ * 3, 1)),
        to: fmt(new Date(prevY, prevQ * 3 + 3, 0)),
      };
    }

    case "month": {
      const prevMonth = f.getMonth() - 1;
      const prevYear = prevMonth < 0 ? f.getFullYear() - 1 : f.getFullYear();
      const pm = prevMonth < 0 ? 11 : prevMonth;
      return {
        from: fmt(new Date(prevYear, pm, 1)),
        to: fmt(new Date(prevYear, pm + 1, 0)),
      };
    }

    case "day": {
      const span = step.days ?? 1;
      const newTo = new Date(f.getTime() - 86400000); // day before current from
      const newFrom = new Date(newTo.getTime() - (span - 1) * 86400000);
      return { from: fmt(newFrom), to: fmt(newTo) };
    }
  }
}

/** Shift a date range forward by one step */
export function computeNextRange(from: string, to: string): { from: string; to: string } {
  const step = detectDateStep(from, to);
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");

  switch (step.kind) {
    case "none":
      return { from, to }; // no-op

    case "year": {
      return {
        from: fmt(new Date(f.getFullYear() + 1, 0, 1)),
        to: fmt(new Date(f.getFullYear() + 1, 11, 31)),
      };
    }

    case "quarter": {
      const qStart = Math.floor(f.getMonth() / 3);
      const nextQ = qStart === 3 ? 0 : qStart + 1;
      const nextY = qStart === 3 ? f.getFullYear() + 1 : f.getFullYear();
      return {
        from: fmt(new Date(nextY, nextQ * 3, 1)),
        to: fmt(new Date(nextY, nextQ * 3 + 3, 0)),
      };
    }

    case "month": {
      const nextMonth = f.getMonth() + 1;
      const nextYear = nextMonth > 11 ? f.getFullYear() + 1 : f.getFullYear();
      const nm = nextMonth > 11 ? 0 : nextMonth;
      return {
        from: fmt(new Date(nextYear, nm, 1)),
        to: fmt(new Date(nextYear, nm + 1, 0)),
      };
    }

    case "day": {
      const span = step.days ?? 1;
      const newFrom = new Date(t.getTime() + 86400000); // day after current to
      const newTo = new Date(newFrom.getTime() + (span - 1) * 86400000);
      return { from: fmt(newFrom), to: fmt(newTo) };
    }
  }
}

/** Returns true when the "next" button should be disabled */
export function isNextDisabled(from: string, to: string): boolean {
  const step = detectDateStep(from, to);
  if (step.kind === "none") return true;

  const next = computeNextRange(from, to);
  const today = new Date();
  const todayStr = fmt(today);
  // Disable if the next range's start date is past today
  return next.from > todayStr;
}

/** Returns true when the "prev" button should be disabled */
export function isPrevDisabled(from: string, to: string): boolean {
  const step = detectDateStep(from, to);
  return step.kind === "none";
}
