import { describe, it, expect } from "vitest";
import {
  resolveGranularity,
  generateTimeBuckets,
  type TimeGranularity,
} from "../../../src/lib/time-series";
import { addDays, addMonths, addYears } from "date-fns";

describe("Time Series Utilities", () => {
  const BASE_DATE = new Date("2026-01-01T00:00:00Z");

  // ========================================================================
  // resolveGranularity
  // ========================================================================

  describe("resolveGranularity", () => {
    it('should return "day" for ranges ≤ 14 days', () => {
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 7))).toBe("day");
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 14))).toBe("day");
    });

    it('should return "week" for ranges 15-90 days', () => {
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 15))).toBe("week");
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 60))).toBe("week");
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 90))).toBe("week");
    });

    it('should return "month" for ranges 91-730 days (~2 years)', () => {
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 91))).toBe("month");
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 365))).toBe("month");
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 730))).toBe("month");
    });

    it('should return "quarter" for ranges > 730 days', () => {
      expect(resolveGranularity(BASE_DATE, addDays(BASE_DATE, 731))).toBe("quarter");
      expect(resolveGranularity(BASE_DATE, addYears(BASE_DATE, 5))).toBe("quarter");
    });

    it("should handle same-day range", () => {
      expect(resolveGranularity(BASE_DATE, BASE_DATE)).toBe("day");
    });
  });

  // ========================================================================
  // generateTimeBuckets
  // ========================================================================

  describe("generateTimeBuckets", () => {
    it("should generate day buckets with weekday labels", () => {
      const buckets = generateTimeBuckets(BASE_DATE, addDays(BASE_DATE, 6), "day");
      expect(buckets).toHaveLength(7); // 7 days inclusive
      expect(buckets[0].label).toBe("Thu"); // Jan 1, 2026 is Thursday
      expect(buckets[0].value).toBe(0); // All initialized to 0
    });

    it("should generate week buckets with sequential labels", () => {
      const buckets = generateTimeBuckets(BASE_DATE, addDays(BASE_DATE, 20), "week");
      expect(buckets.length).toBeGreaterThanOrEqual(3);
      expect(buckets[0].label).toBe("Week 1");
      expect(buckets[1].label).toBe("Week 2");
    });

    it("should generate month buckets with abbreviated month labels", () => {
      const buckets = generateTimeBuckets(BASE_DATE, addMonths(BASE_DATE, 5), "month");
      expect(buckets).toHaveLength(6); // Jan through Jun
      expect(buckets[0].label).toBe("Jan");
      expect(buckets[5].label).toBe("Jun");
    });

    it("should generate quarter buckets with Q labels", () => {
      const buckets = generateTimeBuckets(BASE_DATE, addMonths(BASE_DATE, 11), "quarter");
      expect(buckets).toHaveLength(4); // Q1-Q4
      expect(buckets[0].label).toBe("Q1 2026");
    });

    it("should generate year buckets for multi-year ranges", () => {
      const buckets = generateTimeBuckets(BASE_DATE, addYears(BASE_DATE, 2), "year");
      expect(buckets).toHaveLength(3); // 2026, 2027, 2028
      expect(buckets[0].label).toBe("2026");
      expect(buckets[2].label).toBe("2028");
    });

    it("should have start <= end for every bucket", () => {
      const granularities: TimeGranularity[] = ["day", "week", "month", "quarter", "year"];
      for (const g of granularities) {
        const buckets = generateTimeBuckets(BASE_DATE, addMonths(BASE_DATE, 6), g);
        for (const b of buckets) {
          expect(b.start.getTime()).toBeLessThanOrEqual(b.end.getTime());
        }
      }
    });

    it("should initialize all bucket values to 0", () => {
      const buckets = generateTimeBuckets(BASE_DATE, addMonths(BASE_DATE, 3), "month");
      for (const b of buckets) {
        expect(b.value).toBe(0);
      }
    });
  });
});
