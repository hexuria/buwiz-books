import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  periodLabel,
  getMonthRange,
  getCurrentMonth,
  offsetMonth,
  getPriorPeriodRange,
  getPriorAsOfDate,
  computeChange,
  normalizeBalance,
  daysPastDue,
  getBucketIndex,
  getBucketLabels,
} from "../../src/lib/report-utils";

describe("Report Utility Functions", () => {
  // ─── formatCurrency ──────────────────────────────────────
  describe("formatCurrency", () => {
    it("should format positive amounts", () => {
      expect(formatCurrency(1234.56)).toBe("$1,234.56");
    });

    it("should format negative amounts", () => {
      expect(formatCurrency(-1234.56)).toBe("-$1,234.56");
    });

    it("should format zero", () => {
      expect(formatCurrency(0)).toBe("$0.00");
    });

    it("should format large numbers", () => {
      expect(formatCurrency(1_000_000.99)).toBe("$1,000,000.99");
    });
  });

  // ─── periodLabel ─────────────────────────────────────────
  describe("periodLabel", () => {
    it("should return month and year", () => {
      expect(periodLabel("2026-01-01")).toBe("January 2026");
    });

    it("should handle December", () => {
      expect(periodLabel("2025-12-15")).toBe("December 2025");
    });
  });

  // ─── getMonthRange ───────────────────────────────────────
  describe("getMonthRange", () => {
    it("should return January range", () => {
      const { start, end } = getMonthRange("2026-01");
      expect(start).toBe("2026-01-01");
      expect(end).toBe("2026-01-31");
    });

    it("should return February range (non-leap)", () => {
      const { start, end } = getMonthRange("2025-02");
      expect(start).toBe("2025-02-01");
      expect(end).toBe("2025-02-28");
    });

    it("should return February range (leap year)", () => {
      const { start, end } = getMonthRange("2024-02");
      expect(start).toBe("2024-02-01");
      expect(end).toBe("2024-02-29");
    });

    it("should return December range", () => {
      const { start, end } = getMonthRange("2026-12");
      expect(start).toBe("2026-12-01");
      expect(end).toBe("2026-12-31");
    });
  });

  // ─── getCurrentMonth ─────────────────────────────────────
  describe("getCurrentMonth", () => {
    it("should return YYYY-MM format", () => {
      const result = getCurrentMonth();
      expect(result).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  // ─── offsetMonth ─────────────────────────────────────────
  describe("offsetMonth", () => {
    it("should go back one month", () => {
      expect(offsetMonth("2026-02", -1)).toBe("2026-01");
    });

    it("should go forward one month", () => {
      expect(offsetMonth("2026-01", 1)).toBe("2026-02");
    });

    it("should cross year boundary backward", () => {
      expect(offsetMonth("2026-01", -1)).toBe("2025-12");
    });

    it("should cross year boundary forward", () => {
      expect(offsetMonth("2025-12", 1)).toBe("2026-01");
    });
  });

  // ─── getPriorPeriodRange ─────────────────────────────────
  describe("getPriorPeriodRange", () => {
    it("should mirror a full month span", () => {
      // Feb 1–28 = 28 days → prior 28 days = Jan 4–31
      const { start, end } = getPriorPeriodRange("2026-02-01", "2026-02-28");
      expect(end).toBe("2026-01-31");
      expect(start).toBe("2026-01-04");
    });

    it("should mirror a single day", () => {
      // Feb 16 (1 day) → prior = Feb 15
      const { start, end } = getPriorPeriodRange("2026-02-16", "2026-02-16");
      expect(start).toBe("2026-02-15");
      expect(end).toBe("2026-02-15");
    });

    it("should mirror a 7-day span", () => {
      // Feb 10–16 (7 days) → Feb 3–9
      const { start, end } = getPriorPeriodRange("2026-02-10", "2026-02-16");
      expect(start).toBe("2026-02-03");
      expect(end).toBe("2026-02-09");
    });

    it("should cross year boundary", () => {
      // Jan 1–31 (31 days) → Dec 1–31
      const { start, end } = getPriorPeriodRange("2026-01-01", "2026-01-31");
      expect(start).toBe("2025-12-01");
      expect(end).toBe("2025-12-31");
    });

    it("keeps the inclusive span stable across a daylight-saving transition", () => {
      // This range crosses the US fall-back boundary. Calendar arithmetic must
      // still mirror exactly two days regardless of the process time zone.
      expect(getPriorPeriodRange("2026-11-01", "2026-11-02")).toEqual({
        start: "2026-10-30",
        end: "2026-10-31",
      });
    });
  });

  // ─── getPriorAsOfDate (balance-sheet comparison) ─────────────
  describe("getPriorAsOfDate", () => {
    it("goes back one month at a month-end", () => {
      expect(getPriorAsOfDate("2026-07-31")).toBe("2026-06-30");
    });
    it("clamps to the shorter prior month", () => {
      expect(getPriorAsOfDate("2026-03-31")).toBe("2026-02-28");
    });
    it("crosses the year boundary", () => {
      expect(getPriorAsOfDate("2026-01-15")).toBe("2025-12-15");
    });
    it("keeps a mid-month day", () => {
      expect(getPriorAsOfDate("2026-07-15")).toBe("2026-06-15");
    });
  });

  // ─── computeChange ───────────────────────────────────────
  describe("computeChange", () => {
    it("should detect increase", () => {
      const result = computeChange(150, 100);
      expect(result.direction).toBe("up");
      expect(result.amount).toBe(50);
      expect(result.pct).toBe(50);
    });

    it("should detect decrease", () => {
      const result = computeChange(50, 100);
      expect(result.direction).toBe("down");
      expect(result.amount).toBe(-50);
      expect(result.pct).toBe(-50);
    });

    it("should detect flat", () => {
      const result = computeChange(100, 100);
      expect(result.direction).toBe("flat");
      expect(result.amount).toBe(0);
    });

    it("should return null pct when prior is zero", () => {
      const result = computeChange(100, 0);
      expect(result.pct).toBeNull();
    });
  });

  // ─── normalizeBalance ────────────────────────────────────
  describe("normalizeBalance", () => {
    it("should keep debit-normal accounts positive", () => {
      expect(normalizeBalance(100, "asset")).toBe(100);
      expect(normalizeBalance(100, "expense")).toBe(100);
    });

    it("should invert credit-normal accounts", () => {
      expect(normalizeBalance(100, "liability")).toBe(-100);
      expect(normalizeBalance(100, "equity")).toBe(-100);
      expect(normalizeBalance(100, "revenue")).toBe(-100);
    });

    it("should handle negative raw balance for credit-normal", () => {
      // Raw balance of -500 for liability means CR > DR, so normalized = 500
      expect(normalizeBalance(-500, "liability")).toBe(500);
    });
  });

  // ─── daysPastDue ─────────────────────────────────────────
  describe("daysPastDue", () => {
    it("should return 0 for not yet due", () => {
      expect(daysPastDue("2026-02-15", "2026-02-10")).toBe(0);
    });

    it("should return days past due", () => {
      expect(daysPastDue("2026-01-01", "2026-01-31")).toBe(30);
    });

    it("should return 0 for same day", () => {
      expect(daysPastDue("2026-01-15", "2026-01-15")).toBe(0);
    });
  });

  // ─── getBucketIndex ──────────────────────────────────────
  describe("getBucketIndex", () => {
    const buckets = [30, 60, 90];

    it("should return 0 for current (0 days)", () => {
      expect(getBucketIndex(0, buckets)).toBe(0);
    });

    it("should return 1 for 1-30 days", () => {
      expect(getBucketIndex(15, buckets)).toBe(1);
      expect(getBucketIndex(30, buckets)).toBe(1);
    });

    it("should return 2 for 31-60 days", () => {
      expect(getBucketIndex(45, buckets)).toBe(2);
    });

    it("should return 3 for 61-90 days", () => {
      expect(getBucketIndex(75, buckets)).toBe(3);
    });

    it("should return 4 for 90+ days", () => {
      expect(getBucketIndex(120, buckets)).toBe(4);
    });
  });

  // ─── getBucketLabels ─────────────────────────────────────
  describe("getBucketLabels", () => {
    it("should generate labels for standard buckets", () => {
      const labels = getBucketLabels([30, 60, 90]);
      expect(labels).toEqual(["Current", "1-30", "31-60", "61-90", "90+"]);
    });

    it("should generate labels for custom buckets", () => {
      const labels = getBucketLabels([15, 45]);
      expect(labels).toEqual(["Current", "1-15", "16-45", "45+"]);
    });
  });
});
