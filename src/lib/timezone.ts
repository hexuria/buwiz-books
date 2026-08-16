/**
 * Timezone Utilities
 *
 * IANA timezone list + formatting helpers that use Intl.DateTimeFormat
 * for correct timezone-aware display.
 */

export interface TimezoneOption {
  value: string;
  label: string;
}

/**
 * Build a sorted list of IANA timezones with UTC offset labels.
 * Uses Intl.supportedValuesOf when available, falls back to a curated list.
 */
function buildTimezoneList(): TimezoneOption[] {
  let zones: string[];
  try {
    zones = (
      Intl as typeof Intl & { supportedValuesOf: (key: string) => string[] }
    ).supportedValuesOf("timeZone");
  } catch {
    // Fallback for older runtimes
    zones = FALLBACK_TIMEZONES;
  }

  const now = new Date();

  return zones
    .map((tz) => {
      const offset = getUtcOffset(now, tz);
      return { value: tz, label: `(UTC${offset}) ${tz.replace(/_/g, " ")}` };
    })
    .sort((a, b) => {
      // Sort by offset (numeric), then alphabetically
      const oa = getUtcOffsetMinutes(now, a.value);
      const ob = getUtcOffsetMinutes(now, b.value);
      if (oa !== ob) return oa - ob;
      return a.value.localeCompare(b.value);
    });
}

/** Get UTC offset string like "+08:00" or "-05:00" */
function getUtcOffset(date: Date, tz: string): string {
  const minutes = getUtcOffsetMinutes(date, tz);
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

/** Get UTC offset in minutes for a timezone */
function getUtcOffsetMinutes(date: Date, tz: string): number {
  // Format date parts in UTC and the target timezone, then compare
  const utcParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const getVal = (parts: Intl.DateTimeFormatPart[], type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  const utcTotal =
    getVal(utcParts, "year") * 525960 +
    getVal(utcParts, "month") * 43800 +
    getVal(utcParts, "day") * 1440 +
    (getVal(utcParts, "hour") === 24 ? 0 : getVal(utcParts, "hour")) * 60 +
    getVal(utcParts, "minute");

  const tzTotal =
    getVal(tzParts, "year") * 525960 +
    getVal(tzParts, "month") * 43800 +
    getVal(tzParts, "day") * 1440 +
    (getVal(tzParts, "hour") === 24 ? 0 : getVal(tzParts, "hour")) * 60 +
    getVal(tzParts, "minute");

  return tzTotal - utcTotal;
}

/** Lazily-built timezone list singleton */
let _timezoneList: TimezoneOption[] | null = null;
export function getTimezoneList(): TimezoneOption[] {
  if (!_timezoneList) {
    _timezoneList = buildTimezoneList();
  }
  return _timezoneList;
}

/**
 * Format a YYYY-MM-DD date string for display in a specific timezone.
 * The date is treated as a calendar date (no time component).
 */
export function formatDateInTz(
  dateStr: string,
  timezone = "UTC",
  options?: Intl.DateTimeFormatOptions,
): string {
  // Parse as UTC midnight to avoid local-time shifts
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
    ...options,
  });
}

/**
 * Format a full ISO timestamp for display in a specific timezone.
 */
export function formatTimestampInTz(
  isoStr: string,
  timezone = "UTC",
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(isoStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    ...options,
  });
}

/**
 * Format relative time (e.g. "5 minutes ago").
 * This is timezone-agnostic since it only computes elapsed duration,
 * but both values must be valid UTC-based timestamps.
 */
export function formatRelativeTimeFromUtc(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    return `${m} minute${m > 1 ? "s" : ""} ago`;
  }
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    return `${h} hour${h > 1 ? "s" : ""} ago`;
  }
  if (diffSec < 2592000) {
    const d = Math.floor(diffSec / 86400);
    return `${d} day${d > 1 ? "s" : ""} ago`;
  }
  const mo = Math.floor(diffSec / 2592000);
  return `${mo} month${mo > 1 ? "s" : ""} ago`;
}

// Fallback timezone list for runtimes without Intl.supportedValuesOf
const FALLBACK_TIMEZONES = [
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
  "America/Anchorage",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Lima",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Phoenix",
  "America/Santiago",
  "America/Sao_Paulo",
  "America/Toronto",
  "America/Vancouver",
  "Asia/Bangkok",
  "Asia/Colombo",
  "Asia/Dhaka",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Istanbul",
  "Asia/Jakarta",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kuala_Lumpur",
  "Asia/Manila",
  "Asia/Riyadh",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Taipei",
  "Asia/Tehran",
  "Asia/Tokyo",
  "Atlantic/Reykjavik",
  "Australia/Melbourne",
  "Australia/Perth",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Berlin",
  "Europe/Brussels",
  "Europe/Dublin",
  "Europe/Helsinki",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Moscow",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Vienna",
  "Europe/Warsaw",
  "Europe/Zurich",
  "Pacific/Auckland",
  "Pacific/Fiji",
  "Pacific/Honolulu",
  "UTC",
];
