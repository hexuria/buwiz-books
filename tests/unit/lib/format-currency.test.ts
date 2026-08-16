/**
 * Unit tests for format-currency utility
 */

import { describe, it, expect } from "vitest";
import { formatCurrency } from "@/lib/format-currency";

describe("formatCurrency", () => {
  it("should format USD amounts correctly", () => {
    expect(formatCurrency(1234.56, "USD")).toBe("$1,234.56");
    expect(formatCurrency("1234.56", "USD")).toBe("$1,234.56");
    expect(formatCurrency(0, "USD")).toBe("$0.00");
    expect(formatCurrency(-100, "USD")).toBe("-$100.00");
  });

  it("should format different currencies correctly", () => {
    expect(formatCurrency(1234.56, "EUR")).toBe("€1,234.56");
    expect(formatCurrency(1234.56, "GBP")).toBe("£1,234.56");
    expect(formatCurrency(1234.56, "JPY")).toBe("¥1,234.56"); // JPY shows decimals
  });

  it("should handle different locales", () => {
    expect(formatCurrency(1234.56, "USD", "de-DE")).toBe("1.234,56 $");
    expect(formatCurrency(1234.56, "EUR", "de-DE")).toBe("1.234,56 €");
  });

  it("should handle edge cases", () => {
    expect(formatCurrency(NaN, "USD")).toBe("");
    expect(formatCurrency("invalid", "USD")).toBe("");
    expect(formatCurrency("", "USD")).toBe("");
    expect(formatCurrency(null as any, "USD")).toBe("$0.00");
    expect(formatCurrency(undefined as any, "USD")).toBe("");
  });

  it("should fallback to simple format for invalid currency codes", () => {
    expect(formatCurrency(1234.56, "INVALID")).toBe("INVALID 1234.56");
    expect(formatCurrency(1234.56, "")).toBe(" 1234.56");
  });

  it("should handle very large numbers", () => {
    expect(formatCurrency(999999999.99, "USD")).toBe("$999,999,999.99");
    expect(formatCurrency(-999999999.99, "USD")).toBe("-$999,999,999.99");
  });

  it("should handle decimal precision correctly", () => {
    expect(formatCurrency(1234.567, "USD")).toBe("$1,234.57"); // rounds up
    expect(formatCurrency(1234.564, "USD")).toBe("$1,234.56"); // rounds down
    expect(formatCurrency(1234.5, "USD")).toBe("$1,234.50"); // adds trailing zero
  });

  it("should use default parameters", () => {
    expect(formatCurrency(1234.56)).toBe("$1,234.56");
    expect(formatCurrency("1234.56")).toBe("$1,234.56");
  });
});
