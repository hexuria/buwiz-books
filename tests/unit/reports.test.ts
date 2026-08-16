import { describe, it, expect } from "vitest";
import {
  reportPeriodSchema,
  balanceSheetSchema,
  agingSchema,
  comparisonModeEnum,
  financialsSearchSchema,
  reportTabEnum,
} from "../../src/db/validation/reports";

describe("Report Validation Schemas", () => {
  // ─── reportPeriodSchema ──────────────────────────────────
  describe("reportPeriodSchema", () => {
    it("should validate a valid period", () => {
      const result = reportPeriodSchema.safeParse({
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.basis).toBe("accrual");
        expect(result.data.compare).toBe("none");
      }
    });

    it("should fail if dateFrom is missing", () => {
      const result = reportPeriodSchema.safeParse({ dateTo: "2026-01-31" });
      expect(result.success).toBe(false);
    });

    it("should fail if dateTo is missing", () => {
      const result = reportPeriodSchema.safeParse({ dateFrom: "2026-01-01" });
      expect(result.success).toBe(false);
    });

    it("should accept compare mode", () => {
      const result = reportPeriodSchema.safeParse({
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        compare: "prior_period",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.compare).toBe("prior_period");
      }
    });

    it("should reject invalid basis", () => {
      const result = reportPeriodSchema.safeParse({
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        basis: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── balanceSheetSchema ──────────────────────────────────
  describe("balanceSheetSchema", () => {
    it("should validate with asOf date", () => {
      const result = balanceSheetSchema.safeParse({ asOf: "2026-01-31" });
      expect(result.success).toBe(true);
    });

    it("should fail without asOf", () => {
      const result = balanceSheetSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  // ─── agingSchema ─────────────────────────────────────────
  describe("agingSchema", () => {
    it("should provide default buckets", () => {
      const result = agingSchema.safeParse({ asOf: "2026-01-31" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.buckets).toEqual([30, 60, 90]);
        expect(result.data.type).toBe("ap");
      }
    });

    it("should accept custom buckets", () => {
      const result = agingSchema.safeParse({
        asOf: "2026-01-31",
        buckets: [15, 30, 45, 60],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.buckets).toEqual([15, 30, 45, 60]);
      }
    });

    it("should accept ar type", () => {
      const result = agingSchema.safeParse({
        asOf: "2026-01-31",
        type: "ar",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("ar");
      }
    });
  });

  // ─── comparisonModeEnum ──────────────────────────────────
  describe("comparisonModeEnum", () => {
    it("should accept valid modes", () => {
      expect(comparisonModeEnum.safeParse("none").success).toBe(true);
      expect(comparisonModeEnum.safeParse("prior_period").success).toBe(true);
    });

    it("should reject invalid modes", () => {
      expect(comparisonModeEnum.safeParse("invalid").success).toBe(false);
    });
  });

  // ─── financialsSearchSchema ──────────────────────────────
  describe("financialsSearchSchema", () => {
    it("should provide defaults", () => {
      const result = financialsSearchSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tab).toBe("profit-loss");
        expect(result.data.compare).toBe("none");
        expect(result.data.agingType).toBe("ap");
      }
    });

    it("should validate month format", () => {
      const valid = financialsSearchSchema.safeParse({ month: "2026-01" });
      expect(valid.success).toBe(true);

      const invalid = financialsSearchSchema.safeParse({ month: "2026-1" });
      expect(invalid.success).toBe(false);
    });
  });

  // ─── reportTabEnum ───────────────────────────────────────
  describe("reportTabEnum", () => {
    it("should accept all tab values", () => {
      for (const tab of ["profit-loss", "balance-sheet", "cash-flow", "trial-balance", "aging"]) {
        expect(reportTabEnum.safeParse(tab).success).toBe(true);
      }
    });

    it("should reject invalid tabs", () => {
      expect(reportTabEnum.safeParse("revenue").success).toBe(false);
    });
  });
});
