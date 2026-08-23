import { describe, expect, it } from "vitest";
import {
  assessRegime,
  buildPercentageTaxReturn,
  computeEightPercent,
  computePercentageTax,
  eightPercentBreachOutcome,
  monitorThreshold,
  percentageTaxRateBps,
} from "@/lib/tax/percentage-tax";

/**
 * The regime a small taxpayer sits in is a CHOICE with year-long consequences,
 * and the 8% election is irrevocable once made. The errors here are expensive
 * and quiet.
 */
describe("percentageTaxRateBps", () => {
  it("is 1% inside the CREATE window", () => {
    // RA 11534 cut it from 3% to 1% for 1 Jul 2020 – 30 Jun 2023.
    expect(percentageTaxRateBps("2021-06-30")).toBe(100);
    expect(percentageTaxRateBps("2020-07-01")).toBe(100);
    expect(percentageTaxRateBps("2023-06-30")).toBe(100);
  });

  it("is 3% outside it, on both sides", () => {
    expect(percentageTaxRateBps("2020-06-30")).toBe(300);
    expect(percentageTaxRateBps("2023-07-01")).toBe(300);
    expect(percentageTaxRateBps("2026-03-31")).toBe(300);
  });
});

describe("assessRegime", () => {
  const below = {
    grossReceipts: "1000000",
    isIndividual: true,
    hasCompensationIncome: false,
    isVatRegistered: false,
  };

  it("forces VAT above the threshold and removes the other options", () => {
    const assessment = assessRegime({ ...below, grossReceipts: "3500000" });
    expect(assessment.regime).toBe("vat");
    expect(assessment.eligible).toEqual(["vat"]);
    expect(assessment.mustRegisterForVat).toBe(true);
  });

  it("treats exactly the threshold as still below it", () => {
    // The rule is "exceeds", not "reaches".
    const assessment = assessRegime({ ...below, grossReceipts: "3000000" });
    expect(assessment.mustRegisterForVat).toBe(false);
  });

  it("offers the 8% option to an individual below the threshold", () => {
    const assessment = assessRegime(below);
    expect(assessment.eligible).toContain("eight_percent");
    expect(assessment.reasons.join(" ")).toMatch(/IRREVOCABLE/);
  });

  it("denies the 8% option to a corporation", () => {
    const assessment = assessRegime({ ...below, isIndividual: false });
    expect(assessment.eligible).not.toContain("eight_percent");
    expect(assessment.reasons.join(" ")).toMatch(/not to\s+corporations/);
  });

  it("defaults to percentage tax when 8% is available but not elected", () => {
    expect(assessRegime(below).regime).toBe("percentage_tax");
    expect(assessRegime({ ...below, electedEightPercent: true }).regime).toBe("eight_percent");
  });

  it("keeps a voluntarily VAT-registered taxpayer on VAT", () => {
    const assessment = assessRegime({ ...below, isVatRegistered: true });
    expect(assessment.regime).toBe("vat");
    expect(assessment.mustRegisterForVat).toBe(false);
  });
});

describe("computeEightPercent", () => {
  it("deducts ₱250,000 for a purely self-employed individual", () => {
    const result = computeEightPercent({
      grossReceipts: "1000000",
      hasCompensationIncome: false,
    });
    expect(result.deductionApplied).toBe("250000");
    expect(result.taxableBase).toBe("750000");
    expect(result.taxDue).toBe("60000");
  });

  it("does NOT deduct ₱250,000 for a mixed-income earner", () => {
    // The graduated table applied to their salary already absorbed it.
    // Granting it here understates tax by ₱20,000 a year, invisibly.
    const result = computeEightPercent({
      grossReceipts: "1000000",
      hasCompensationIncome: true,
    });
    expect(result.deductionApplied).toBe("0");
    expect(result.taxableBase).toBe("1000000");
    expect(result.taxDue).toBe("80000");
  });

  it("explains which deduction rule applied and why", () => {
    expect(
      computeEightPercent({ grossReceipts: "1", hasCompensationIncome: true }).deductionReason,
    ).toMatch(/already absorbed it/);
    expect(
      computeEightPercent({ grossReceipts: "1", hasCompensationIncome: false }).deductionReason,
    ).toMatch(/purely self-employed/);
  });

  it("never produces a negative base", () => {
    const result = computeEightPercent({
      grossReceipts: "100000",
      hasCompensationIncome: false,
    });
    expect(result.taxableBase).toBe("0");
    expect(result.taxDue).toBe("0");
  });

  it("quantifies the mixed-income difference", () => {
    // 8% of 250,000 = 20,000 — the exact cost of getting this wrong.
    const pure = computeEightPercent({ grossReceipts: "2000000", hasCompensationIncome: false });
    const mixed = computeEightPercent({ grossReceipts: "2000000", hasCompensationIncome: true });
    expect(Number(mixed.taxDue) - Number(pure.taxDue)).toBe(20000);
  });
});

describe("computePercentageTax", () => {
  it("applies the rate for the date", () => {
    expect(computePercentageTax({ grossReceipts: "1000000", asOf: "2022-03-31" }).taxDue).toBe(
      "10000",
    );
    expect(computePercentageTax({ grossReceipts: "1000000", asOf: "2026-03-31" }).taxDue).toBe(
      "30000",
    );
  });

  it("names which rate it used and why", () => {
    expect(computePercentageTax({ grossReceipts: "1", asOf: "2022-01-01" }).note).toMatch(/CREATE/);
  });
});

describe("monitorThreshold", () => {
  it("reports headroom below the threshold", () => {
    const status = monitorThreshold("2000000");
    expect(status.remaining).toBe("1000000");
    expect(status.breached).toBe(false);
  });

  it("warns at three quarters", () => {
    expect(monitorThreshold("2250000").advisory).toMatch(/Three quarters/);
  });

  it("escalates within 10%", () => {
    expect(monitorThreshold("2800000").advisory).toMatch(/Within 10%/);
  });

  it("says plainly what a breach costs", () => {
    // Sales invoiced without VAT after a breach still carry it — out of margin,
    // because it was never collected from the customer.
    const status = monitorThreshold("3500000");
    expect(status.breached).toBe(true);
    expect(status.advisory).toMatch(/comes out of margin/);
    expect(status.remaining).toBe("0");
  });

  it("stays quiet well below the threshold", () => {
    expect(monitorThreshold("500000").advisory).toBeNull();
  });
});

describe("eightPercentBreachOutcome", () => {
  it("credits the 8% already paid rather than forfeiting it", () => {
    // Treating it as forfeited overstates what the taxpayer owes at exactly
    // the moment they can least absorb it.
    const outcome = eightPercentBreachOutcome({
      eightPercentPaid: "60000",
      incomeTaxDueUnderGraduated: "100000",
    });
    expect(outcome.creditable).toBe("60000");
    expect(outcome.stillDue).toBe("40000");
    expect(outcome.refundable).toBe("0");
  });

  it("shows a refund when the 8% paid exceeds the graduated tax", () => {
    const outcome = eightPercentBreachOutcome({
      eightPercentPaid: "100000",
      incomeTaxDueUnderGraduated: "60000",
    });
    expect(outcome.stillDue).toBe("0");
    expect(outcome.refundable).toBe("40000");
  });

  it("says the switch is not a penalty", () => {
    const outcome = eightPercentBreachOutcome({
      eightPercentPaid: "1",
      incomeTaxDueUnderGraduated: "1",
    });
    expect(outcome.note).toMatch(/not forfeited and the switch is not a penalty/);
  });
});

// Deliberate expectation change (audit P13): the 2551Q builder emits
// centavo-rounded form strings, and credits beyond the liability surface as
// excessCredits instead of vanishing into a "0" stillDue.
describe("buildPercentageTaxReturn", () => {
  const base = { quarter: 1 as const, year: 2026, grossReceipts: "1000000" };

  it("computes tax at the period's rate", () => {
    const ret = buildPercentageTaxReturn(base);
    expect(ret.rateBps).toBe(300);
    expect(ret.taxDue).toBe("30000.00");
  });

  it("is due 25 days after the quarter closes", () => {
    expect(buildPercentageTaxReturn(base).dueDate).toBe("2026-04-25");
    expect(buildPercentageTaxReturn({ ...base, quarter: 4 }).dueDate).toBe("2027-01-25");
  });

  it("nets prior payments", () => {
    const ret = buildPercentageTaxReturn({ ...base, taxCreditsPayments: "10000" });
    expect(ret.stillDue).toBe("20000.00");
  });

  it("surfaces credits beyond the liability as excessCredits", () => {
    const ret = buildPercentageTaxReturn({ ...base, taxCreditsPayments: "40000" });
    expect(ret.stillDue).toBe("0.00");
    expect(ret.excessCredits).toBe("10000.00");
  });

  it("blocks when the 8% option was elected", () => {
    // 8% is IN LIEU OF percentage tax; filing both taxes the same receipts
    // twice.
    const ret = buildPercentageTaxReturn({ ...base, electedEightPercent: true });
    expect(ret.blockingIssues.join(" ")).toMatch(/tax the same receipts twice/);
  });

  it("blocks above the VAT threshold", () => {
    const ret = buildPercentageTaxReturn({ ...base, grossReceipts: "4000000" });
    expect(ret.blockingIssues.join(" ")).toMatch(/VAT\s+registration is mandatory/);
  });

  it("rejects an impossible quarter", () => {
    expect(() => buildPercentageTaxReturn({ ...base, quarter: 0 as never })).toThrow(
      /Invalid quarter/,
    );
  });
});
