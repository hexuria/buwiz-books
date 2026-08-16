import { describe, expect, it } from "vitest";
import { formatCurrency } from "@/lib/format-currency";

describe("format-currency", () => {
  it("formats using the provided currency code", () => {
    expect(formatCurrency(1234.5, "EUR")).toContain("€");
  });

  it("supports string inputs", () => {
    expect(formatCurrency("99.95", "USD")).toBe("$99.95");
  });

  it("falls back when the currency code is invalid", () => {
    expect(formatCurrency(10, "INVALID")).toBe("INVALID 10.00");
  });
});
