import { describe, it, expect } from "vitest";
import {
  formatPeriodLabel,
  formatMoney,
} from "../../../src/components/reconciliations/reconHelpers";

describe("Reconciliation Helpers", () => {
  // ========================================================================
  // formatPeriodLabel
  // ========================================================================

  describe("formatPeriodLabel", () => {
    it("should show abbreviated month + year for same-month range", () => {
      const label = formatPeriodLabel("2026-01-01", "2026-01-31");
      expect(label).toBe("Jan 2026");
    });

    it("should show cross-month range with dates", () => {
      const label = formatPeriodLabel("2026-01-15", "2026-02-15");
      expect(label).toContain("Jan");
      expect(label).toContain("Feb");
      expect(label).toContain("2026");
    });

    it("should handle same start and end date", () => {
      const label = formatPeriodLabel("2026-06-15", "2026-06-15");
      expect(label).toBe("Jun 2026");
    });

    it("should handle cross-year range", () => {
      const label = formatPeriodLabel("2025-12-01", "2026-01-31");
      expect(label).toContain("Dec");
      expect(label).toContain("Jan");
    });
  });

  // ========================================================================
  // formatMoney
  // ========================================================================

  describe("formatMoney", () => {
    it("should format a positive number as USD currency", () => {
      const result = formatMoney(1234.56);
      expect(result).toBe("$1,234.56");
    });

    it("should format a string value", () => {
      const result = formatMoney("999.99");
      expect(result).toBe("$999.99");
    });

    it("should format zero", () => {
      const result = formatMoney(0);
      expect(result).toBe("$0.00");
    });

    it("should format negative values", () => {
      const result = formatMoney(-500.5);
      // Intl formats negatives as -$500.50
      expect(result).toContain("500.50");
    });

    it("should add trailing zeros for whole numbers", () => {
      const result = formatMoney(100);
      expect(result).toBe("$100.00");
    });

    it("should handle large numbers with commas", () => {
      const result = formatMoney(1000000);
      expect(result).toBe("$1,000,000.00");
    });

    it("should parse string with decimal", () => {
      const result = formatMoney("42.1");
      expect(result).toBe("$42.10");
    });
  });
});
