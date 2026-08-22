import { describe, expect, it } from "vitest";
import { isAnnualizationPeriod, periodIndexFromDates } from "@/lib/tax/payroll-period";

describe("periodIndexFromDates", () => {
  it("uses the calendar month for a monthly period", () => {
    expect(periodIndexFromDates("monthly", "2026-03-31")).toBe(3);
  });

  it("splits a month into two semi-monthly indexes", () => {
    expect(periodIndexFromDates("semi_monthly", "2026-01-15")).toBe(1);
    expect(periodIndexFromDates("semi_monthly", "2026-01-31")).toBe(2);
    expect(periodIndexFromDates("semi_monthly", "2026-02-28")).toBe(4);
  });
});

describe("isAnnualizationPeriod", () => {
  it("treats December 31 and explicit annual periods as annualization", () => {
    expect(isAnnualizationPeriod("monthly", "2026-12-31")).toBe(true);
    expect(isAnnualizationPeriod("annual", "2026-12-31")).toBe(true);
    expect(isAnnualizationPeriod("monthly", "2026-01-31")).toBe(false);
  });
});
