import { describe, it, expect } from "vitest";
import { INDUSTRIES, CURRENCIES, FISCAL_MONTHS } from "../../../src/lib/constants";

describe("Application Constants", () => {
  // ========================================================================
  // INDUSTRIES
  // ========================================================================

  describe("INDUSTRIES", () => {
    it("should contain at least 10 industry options", () => {
      expect(INDUSTRIES.length).toBeGreaterThanOrEqual(10);
    });

    it("should have unique values", () => {
      const values = INDUSTRIES.map((i) => i.value);
      expect(new Set(values).size).toBe(values.length);
    });

    it("should have non-empty labels", () => {
      for (const industry of INDUSTRIES) {
        expect(industry.label.length).toBeGreaterThan(0);
      }
    });

    it('should include "other" as a catch-all', () => {
      expect(INDUSTRIES.some((i) => i.value === "other")).toBe(true);
    });
  });

  // ========================================================================
  // CURRENCIES
  // ========================================================================

  describe("CURRENCIES", () => {
    it("should contain USD as the first currency", () => {
      expect(CURRENCIES[0].value).toBe("USD");
    });

    it("should have unique 3-letter ISO codes", () => {
      const codes = CURRENCIES.map((c) => c.value);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) {
        expect(code).toHaveLength(3);
        expect(code).toMatch(/^[A-Z]{3}$/);
      }
    });

    it("should include PHP (Philippine Peso)", () => {
      expect(CURRENCIES.some((c) => c.value === "PHP")).toBe(true);
    });

    it("should have labels containing the ISO code", () => {
      for (const currency of CURRENCIES) {
        expect(currency.label).toContain(currency.value);
      }
    });
  });

  // ========================================================================
  // FISCAL_MONTHS
  // ========================================================================

  describe("FISCAL_MONTHS", () => {
    it("should contain exactly 12 months", () => {
      expect(FISCAL_MONTHS).toHaveLength(12);
    });

    it("should start with January and end with December", () => {
      expect(FISCAL_MONTHS[0]).toBe("January");
      expect(FISCAL_MONTHS[11]).toBe("December");
    });

    it("should be in calendar order", () => {
      const expected = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      expect([...FISCAL_MONTHS]).toEqual(expected);
    });
  });
});
