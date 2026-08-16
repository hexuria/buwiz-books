import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getTimezoneList,
  formatDateInTz,
  formatTimestampInTz,
  formatRelativeTimeFromUtc,
} from "../../../src/lib/timezone";

describe("Timezone Utilities", () => {
  // ========================================================================
  // getTimezoneList
  // ========================================================================

  describe("getTimezoneList", () => {
    it("should return a non-empty array of timezone options", () => {
      const list = getTimezoneList();
      expect(list.length).toBeGreaterThan(10);
    });

    it("should include well-known timezones from the fallback list", () => {
      const list = getTimezoneList();
      // These are always present whether via Intl.supportedValuesOf or fallback
      expect(list.some((tz) => tz.value === "America/New_York")).toBe(true);
      expect(list.some((tz) => tz.value === "Asia/Manila")).toBe(true);
      expect(list.some((tz) => tz.value === "Europe/London")).toBe(true);
    });

    it("should have labels containing UTC offset pattern", () => {
      const list = getTimezoneList();
      // Every label should start with a UTC offset like "(UTC+08:00)"
      for (const tz of list) {
        expect(tz.value).toBeTruthy();
        expect(tz.label).toMatch(/\(UTC[+-]\d{2}:\d{2}\)/);
      }
    });

    it("should return the same singleton instance on repeated calls", () => {
      const a = getTimezoneList();
      const b = getTimezoneList();
      expect(a).toBe(b);
    });
  });

  // ========================================================================
  // formatDateInTz
  // ========================================================================

  describe("formatDateInTz", () => {
    it("should format a date in UTC", () => {
      const result = formatDateInTz("2026-01-15", "UTC");
      expect(result).toContain("January");
      expect(result).toContain("15");
      expect(result).toContain("2026");
    });

    it("should format a date in a specific timezone", () => {
      const result = formatDateInTz("2026-06-01", "America/New_York");
      // May show May 31 or June 1 depending on offset handling
      expect(result).toContain("2026");
    });

    it("should default to UTC when no timezone specified", () => {
      const result = formatDateInTz("2026-03-10");
      expect(result).toContain("March");
      expect(result).toContain("10");
    });

    it("should accept custom format options", () => {
      const result = formatDateInTz("2026-01-15", "UTC", { month: "short" });
      expect(result).toContain("Jan");
    });
  });

  // ========================================================================
  // formatTimestampInTz
  // ========================================================================

  describe("formatTimestampInTz", () => {
    it("should format a full ISO timestamp in UTC", () => {
      const result = formatTimestampInTz("2026-01-15T14:30:00Z", "UTC");
      expect(result).toContain("Jan");
      expect(result).toContain("15");
      expect(result).toContain("2026");
      expect(result).toContain("30");
    });

    it("should adjust display for different timezones", () => {
      const utc = formatTimestampInTz("2026-01-15T23:00:00Z", "UTC");
      const tokyo = formatTimestampInTz("2026-01-15T23:00:00Z", "Asia/Tokyo");
      // Tokyo is UTC+9, so the date may differ
      expect(utc).not.toBe(tokyo);
    });
  });

  // ========================================================================
  // formatRelativeTimeFromUtc
  // ========================================================================

  describe("formatRelativeTimeFromUtc", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "just now" for timestamps less than 60 seconds ago', () => {
      const result = formatRelativeTimeFromUtc("2026-01-15T11:59:30Z");
      expect(result).toBe("just now");
    });

    it("should return minutes ago", () => {
      const result = formatRelativeTimeFromUtc("2026-01-15T11:55:00Z");
      expect(result).toBe("5 minutes ago");
    });

    it("should use singular for 1 minute", () => {
      const result = formatRelativeTimeFromUtc("2026-01-15T11:59:00Z");
      expect(result).toBe("1 minute ago");
    });

    it("should return hours ago", () => {
      const result = formatRelativeTimeFromUtc("2026-01-15T09:00:00Z");
      expect(result).toBe("3 hours ago");
    });

    it("should use singular for 1 hour", () => {
      const result = formatRelativeTimeFromUtc("2026-01-15T11:00:00Z");
      expect(result).toBe("1 hour ago");
    });

    it("should return days ago", () => {
      const result = formatRelativeTimeFromUtc("2026-01-13T12:00:00Z");
      expect(result).toBe("2 days ago");
    });

    it("should return months ago", () => {
      const result = formatRelativeTimeFromUtc("2025-11-15T12:00:00Z");
      expect(result).toBe("2 months ago");
    });
  });
});
