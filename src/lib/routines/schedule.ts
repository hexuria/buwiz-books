/**
 * Schedule presets for routines (Inbox v2 spec §3, build step 5).
 *
 * Presets, not free cron — there is no cron dependency and the presets cover
 * the need:
 *
 *   { preset: "hourly", at?: "HH:MM", timezone }            every hour at :MM
 *   { preset: "daily",  at?: "HH:MM", timezone }            every day at HH:MM
 *   { preset: "weekly", at?: "HH:MM", weekday, timezone }   weekday 0 = Sunday … 6 = Saturday
 *
 * `at` defaults to "00:00"; an hourly schedule uses only its minutes. Times are
 * wall-clock times in `timezone` (IANA), resolved with Intl, so daylight
 * saving is handled the way RFC 5545 and Temporal's "compatible" mode do:
 *
 *   - a time that falls in a spring-forward gap runs that day, shifted
 *     forward by the gap (02:30 on a 02:00→03:00 night runs at 03:30);
 *   - a time that occurs twice in a fall-back overlap runs ONCE, at the
 *     earlier instant — a daily routine never fires twice in one day;
 *   - an hourly schedule fires every real hour, including the repeated one.
 *
 * `computeNextRunAt` is pure: no clock, no database.
 */
import { z } from "zod";

export const SCHEDULE_PRESETS = ["hourly", "daily", "weekly"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The zone's canonical IANA name, or null when Intl does not know it. */
export function canonicalTimeZone(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Shape only; the cross-field rules live in `refineSchedule`. */
export const scheduleShape = z.object({
  preset: z.enum(SCHEDULE_PRESETS),
  at: z.string().regex(TIME_OF_DAY_PATTERN, "at must be a 24-hour HH:MM time").optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  timezone: z
    .string()
    .min(1)
    .refine((value) => canonicalTimeZone(value) !== null, "timezone must be an IANA time zone")
    .transform((value) => canonicalTimeZone(value) ?? value),
});

export function refineSchedule(
  value: { preset: SchedulePreset; weekday?: number },
  ctx: z.RefinementCtx,
): void {
  if (value.preset === "weekly" && value.weekday === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["weekday"],
      message: "A weekly schedule needs a weekday (0 = Sunday … 6 = Saturday).",
    });
  }
  if (value.preset !== "weekly" && value.weekday !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["weekday"],
      message: "Only a weekly schedule takes a weekday.",
    });
  }
}

export const scheduleConfigSchema = scheduleShape.superRefine(refineSchedule);
export type ScheduleConfig = z.output<typeof scheduleConfigSchema>;

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallTimeAt(instant: number, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    // Some engines still print midnight as 24 under h23.
    hour: part("hour") % 24,
    minute: part("minute"),
    second: part("second"),
  };
}

/** The zone's offset from UTC at `instant`, in ms (wall = utc + offset). */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallTimeAt(instant, timeZone);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallAsUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant a wall-clock time names in a zone, disambiguated like
 * Temporal's "compatible": the earlier instant in an overlap, and a time in a
 * gap shifted forward by the gap's length.
 */
function instantForWallTime(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // A day either side brackets any single transition around this wall time.
  const offsetBefore = offsetAt(wallAsUtc - DAY_MS, timeZone);
  const offsetAfter = offsetAt(wallAsUtc + DAY_MS, timeZone);
  const matches = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => wallAsUtc - offset)
    .filter((instant) => {
      const wall = wallTimeAt(instant, timeZone);
      return (
        wall.year === date.year &&
        wall.month === date.month &&
        wall.day === date.day &&
        wall.hour === hour &&
        wall.minute === minute
      );
    })
    .sort((left, right) => left - right);
  if (matches.length > 0) return matches[0];
  // Spring-forward gap: the wall time never happens that day. Read it with
  // the pre-transition offset, which lands the same distance past the gap.
  return wallAsUtc - offsetBefore;
}

function parseAt(at: string | undefined): { hour: number; minute: number } {
  const match = TIME_OF_DAY_PATTERN.exec(at ?? "00:00");
  if (!match) throw new Error(`Schedule time "${at}" is not HH:MM.`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function nextHourly(minute: number, timeZone: string, from: number): number {
  // Step real minutes from the first whole minute strictly after `from`. At
  // most an hour in practice; three bound zones whose offset shifts by 30.
  let candidate = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < 180; step += 1) {
    if (wallTimeAt(candidate, timeZone).minute === minute) return candidate;
    candidate += MINUTE_MS;
  }
  throw new Error(`No hourly occurrence at :${minute} found in ${timeZone}.`);
}

function nextOnDays(
  hour: number,
  minute: number,
  weekday: number | null,
  timeZone: string,
  from: number,
): number {
  const today = wallTimeAt(from, timeZone);
  // Calendar-day stepping in UTC space: day arithmetic only, no offsets.
  // Starts a day early so a slot shifted forward out of yesterday's gap is
  // still considered; nine days cover any weekday plus that margin.
  for (let offset = -1; offset <= 8; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (weekday !== null && day.getUTCDay() !== weekday) continue;
    const instant = instantForWallTime(
      { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() },
      hour,
      minute,
      timeZone,
    );
    if (instant > from) return instant;
  }
  throw new Error(`No scheduled occurrence found in ${timeZone}.`);
}

/**
 * The first scheduled instant strictly after `from`.
 *
 * Strictly after, so a routine claimed exactly on its slot advances to the
 * following one, and a routine that missed slots while no worker ran resumes
 * at the next future slot instead of replaying every missed one.
 */
export function computeNextRunAt(config: ScheduleConfig, from: Date): Date {
  const parsed = scheduleConfigSchema.parse(config);
  const { hour, minute } = parseAt(parsed.at);
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) throw new Error("computeNextRunAt needs a valid start instant.");
  switch (parsed.preset) {
    case "hourly":
      return new Date(nextHourly(minute, parsed.timezone, fromMs));
    case "daily":
      return new Date(nextOnDays(hour, minute, null, parsed.timezone, fromMs));
    case "weekly":
      return new Date(nextOnDays(hour, minute, parsed.weekday!, parsed.timezone, fromMs));
  }
}
