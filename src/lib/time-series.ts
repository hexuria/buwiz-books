import {
  eachDayOfInterval,
  eachMonthOfInterval,
  eachQuarterOfInterval,
  eachYearOfInterval,
  endOfDay,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  format,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  differenceInDays,
  addDays,
} from "date-fns";

export type TimeGranularity = "day" | "week" | "month" | "quarter" | "year";

export interface TimeBucket {
  start: Date;
  end: Date;
  label: string;
  value: number;
}

/**
 * Resolves the ideal granularity based on the length of the date range.
 */
export function resolveGranularity(dateFrom: Date, dateTo: Date): TimeGranularity {
  const days = differenceInDays(dateTo, dateFrom);

  if (days <= 14) return "day";
  if (days <= 90) return "week";
  if (days <= 730) return "month"; // ~2 years
  return "quarter";
}

/**
 * Generates empty time buckets for a given range and granularity.
 */
export function generateTimeBuckets(
  dateFrom: Date,
  dateTo: Date,
  granularity: TimeGranularity,
): TimeBucket[] {
  let intervals: Date[] = [];

  switch (granularity) {
    case "day":
      intervals = eachDayOfInterval({ start: dateFrom, end: dateTo });
      return intervals.map((date) => ({
        start: startOfDay(date),
        end: endOfDay(date),
        label: format(date, "EEE"), // Mon, Tue, etc.
        value: 0,
      }));

    case "week": {
      const buckets: TimeBucket[] = [];
      let currentStart = startOfDay(dateFrom);
      let weekNum = 1;

      while (currentStart <= dateTo) {
        // True 7-day windows starting from dateFrom
        const nextStart = startOfDay(addDays(currentStart, 7));

        // End is exactly 1 millisecond before the start of the next 7-day window
        const currentEnd = new Date(nextStart.getTime() - 1);

        buckets.push({
          start: currentStart,
          end: currentEnd,
          label: `Week ${weekNum}`,
          value: 0,
        });

        currentStart = nextStart;
        weekNum++;
      }
      return buckets;
    }

    case "month":
      intervals = eachMonthOfInterval({ start: dateFrom, end: dateTo });
      return intervals.map((date) => ({
        start: startOfMonth(date),
        end: endOfMonth(date),
        label: format(date, "MMM"), // Jan, Feb
        value: 0,
      }));

    case "quarter":
      intervals = eachQuarterOfInterval({ start: dateFrom, end: dateTo });
      return intervals.map((date) => ({
        start: startOfQuarter(date),
        end: endOfQuarter(date),
        label: `Q${format(date, "Q yyyy")}`, // Q1 2026
        value: 0,
      }));

    case "year":
      intervals = eachYearOfInterval({ start: dateFrom, end: dateTo });
      return intervals.map((date) => ({
        start: startOfYear(date),
        end: endOfYear(date),
        label: format(date, "yyyy"), // 2026
        value: 0,
      }));
  }
}
