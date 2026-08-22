import { describe, it, expect } from "vitest";
import { annualize, annualTax } from "@/lib/tax/annualization";
import { asOf, isInForce } from "@/lib/tax/as-of";
import { toPesoString, toScaled } from "@/lib/tax/money";
import { WITHHOLDING_BRACKETS } from "@/lib/tax/reference-catalog";
import type { Bracket } from "@/lib/tax/withholding";

/** The annual NIRC Sec. 24(A)(2) schedule, resolved by as-of date. */
function annualBracketsAt(at: string): Bracket[] {
  return WITHHOLDING_BRACKETS.filter(
    (b) => b.payrollPeriod === "annual" && isInForce(b, asOf(at)),
  ).map((b) => ({
    bracketIndex: b.bracketIndex,
    floorAmount: b.floorAmount,
    prescribedTax: b.prescribedTax,
    rateBps: b.rateBps,
  }));
}

const YEAR_2018 = "2018-12-31";
const annual2018 = annualBracketsAt(YEAR_2018);

describe("annualTax — the NIRC Sec. 24(A)(2) schedule", () => {
  it("matches the schedule printed in RR 11-2018 Step 3(a) for 2018-2022", () => {
    // Verbatim from the RR: basic amount + rate × excess over.
    const cases: Array<[string, string]> = [
      ["250000", "0.00"],
      ["400000", "30000.00"], // 0 + 20% × 150,000
      ["720000", "110000.00"], // 30,000 + 25% × 320,000 — Illustration 13
      ["800000", "130000.00"],
      ["1515000", "344500.00"], // 130,000 + 30% × 715,000 — Illustration 14
      ["8000000", "2410000.00"],
    ];
    for (const [taxable, expected] of cases) {
      expect(toPesoString(annualTax(toScaled(taxable), annual2018).tax), taxable).toBe(expected);
    }
  });

  it("matches the 2023-onwards schedule from Step 3(b)", () => {
    const annual2026 = annualBracketsAt("2026-12-31");
    const cases: Array<[string, string]> = [
      ["250000", "0.00"],
      ["400000", "22500.00"], // 0 + 15% × 150,000
      ["800000", "102500.00"],
      ["2000000", "402500.00"],
      ["8000000", "2202500.00"],
    ];
    for (const [taxable, expected] of cases) {
      expect(toPesoString(annualTax(toScaled(taxable), annual2026).tax), taxable).toBe(expected);
    }
  });

  it("taxes nothing at or below the 250,000 exemption", () => {
    expect(toPesoString(annualTax(toScaled("249999"), annual2018).tax)).toBe("0.00");
    expect(toPesoString(annualTax(toScaled("0"), annual2018).tax)).toBe("0.00");
  });
});

/**
 * RR 11-2018's own annualization illustrations, 13 through 15, all Annex-D era.
 * Each exercises a different branch of Step 4.
 */
describe("annualize — RR 11-2018 illustrations", () => {
  it("Illustration 13: mid-year termination producing a refund (Mr. Bembem)", () => {
    // ₱120,000/month from 1 January, resigned effective 30 June, withheld
    // ₱134,164.50 to 31 May. Tax due on ₱720,000 is ₱110,000, so he is owed
    // ₱24,164.50 — and because this is a TERMINATION, the refund is due at the
    // last compensation payment, not the following 25 January.
    const result = annualize({
      trigger: "termination",
      taxableRegular: "720000",
      taxableSupplementary: "0",
      taxWithheldByThisEmployer: "134164.50",
      annualBrackets: annual2018,
    });

    expect(toPesoString(result.totalTaxableCompensation)).toBe("720000.00");
    expect(result.taxDuePesos).toBe("110000.00");
    expect(result.outcome).toBe("excess");
    expect(result.amountPesos).toBe("24164.50");
    expect(result.settlement.action).toBe("refund_at_last_pay");
  });

  it("Illustration 14: successive employers producing a December deficiency (Mr. Joey)", () => {
    // CCF Corp January to June: ₱720,000, ₱134,164.50 withheld, per the 2316 he
    // furnished. EBQ from July: ₱780,000 regular plus ₱15,000 commissions in
    // December, ₱178,997.40 withheld.
    const result = annualize({
      trigger: "year_end",
      taxableRegular: "780000",
      taxableSupplementary: "15000", // commissions are SUPPLEMENTARY
      previousEmployerTaxable: "720000",
      taxWithheldByThisEmployer: "178997.40",
      taxWithheldByPreviousEmployer: "134164.50",
      annualBrackets: annual2018,
    });

    expect(toPesoString(result.totalTaxableCompensation)).toBe("1515000.00");
    expect(result.taxDuePesos).toBe("344500.00");
    expect(toPesoString(result.totalTaxWithheld)).toBe("313161.90");
    expect(result.outcome).toBe("deficiency");
    expect(result.amountPesos).toBe("31338.10");
    expect(result.settlement.action).toBe("withhold_from_last_pay");
  });

  it("Illustration 15 case 1: year-end deficiency with the ₱90,000 exclusion (Ms. Grace)", () => {
    // ₱600,000 basic + ₱10,000 November overtime; ₱50,000 13th month and
    // ₱10,000 other benefits are non-taxable, being wholly within ₱90,000.
    // The overtime is FULLY taxable because she is not a minimum wage earner —
    // the mirror of Illustration 4, where an MWE's overtime is exempt.
    const result = annualize({
      trigger: "year_end",
      taxableRegular: "600000",
      taxableSupplementary: "10000",
      taxWithheldByThisEmployer: "73334.25",
      annualBrackets: annual2018,
    });

    expect(toPesoString(result.totalTaxableCompensation)).toBe("610000.00");
    expect(result.taxDuePesos).toBe("82500.00");
    expect(result.outcome).toBe("deficiency");
    expect(result.amountPesos).toBe("9165.75");
  });

  it("Illustration 15 case 1 reconciles with the per-period Annex D table", () => {
    // The RR's own numbers tie the two instruments together: monthly taxable
    // ₱50,000 under Annex D gives 2,500 + 25% × (50,000 − 33,333) = 6,666.75,
    // and 6,666.75 × 11 = 73,334.25 — exactly the January-November withholding
    // the illustration states. If either table were wrong this would not close.
    const monthly = WITHHOLDING_BRACKETS.filter(
      (b) => b.payrollPeriod === "monthly" && isInForce(b, asOf("2018-06-30")),
    ).map((b) => ({
      bracketIndex: b.bracketIndex,
      floorAmount: b.floorAmount,
      prescribedTax: b.prescribedTax,
      rateBps: b.rateBps,
    }));
    const perMonth = annualTax(toScaled("50000"), monthly).tax;
    expect(toPesoString(perMonth)).toBe("6666.75");
    expect(toPesoString((perMonth * 11n) as typeof perMonth)).toBe("73334.25");
  });

  it("Illustration 15 case 2: year-end refund for a mid-year hire (Mr. Gerry)", () => {
    // Hired 1 July. Previous employer January to May ₱125,000 with ₱4,167
    // withheld; present employer ₱150,000 with ₱4,167 withheld. 13th month
    // ₱25,000 and other benefits ₱5,000 are non-taxable within ₱90,000.
    // Note the June gap — deliberate in the RR's facts, and the source of the
    // cumulative-method divisor ambiguity tested in cumulative-average.test.ts.
    const result = annualize({
      trigger: "year_end",
      taxableRegular: "150000",
      taxableSupplementary: "0",
      previousEmployerTaxable: "125000",
      taxWithheldByThisEmployer: "4167.00",
      taxWithheldByPreviousEmployer: "4167.00",
      annualBrackets: annual2018,
    });

    expect(toPesoString(result.totalTaxableCompensation)).toBe("275000.00");
    expect(result.taxDuePesos).toBe("5000.00"); // 0 + 20% × 25,000
    expect(toPesoString(result.totalTaxWithheld)).toBe("8334.00");
    expect(result.outcome).toBe("excess");
    expect(result.amountPesos).toBe("3334.00");
    // A YEAR-END refund, so the 25 January deadline applies — not Illustration
    // 13's last-payment timing.
    expect(result.settlement.action).toBe("refund_by_jan_25");
  });
});

describe("annualize — Step 4 branches", () => {
  it("reports an exact match as requiring nothing", () => {
    const result = annualize({
      trigger: "year_end",
      taxableRegular: "720000",
      taxableSupplementary: "0",
      taxWithheldByThisEmployer: "110000",
      annualBrackets: annual2018,
    });
    expect(result.outcome).toBe("exact");
    expect(result.amountPesos).toBe("0.00");
    expect(result.settlement.action).toBe("none");
  });

  it("splits out a deficiency the last payment cannot cover", () => {
    // The RR makes the employer liable for what it cannot withhold, and leaves
    // recovery "a matter of settlement between the employee and employer".
    // In ledger terms that is an employer expense plus an employee receivable,
    // so it must surface as its own figure rather than quietly shrinking the
    // deficiency.
    const result = annualize({
      trigger: "year_end",
      taxableRegular: "1515000",
      taxableSupplementary: "0",
      taxWithheldByThisEmployer: "300000",
      lastCompensationPayment: "20000",
      annualBrackets: annual2018,
    });
    expect(result.outcome).toBe("deficiency");
    expect(toPesoString(result.deficiency)).toBe("44500.00");
    expect(toPesoString(result.uncollectibleDeficiency)).toBe("24500.00");
  });

  it("reports no uncollectible remainder when the last payment covers the deficiency", () => {
    const result = annualize({
      trigger: "year_end",
      taxableRegular: "610000",
      taxableSupplementary: "0",
      taxWithheldByThisEmployer: "73334.25",
      lastCompensationPayment: "50000",
      annualBrackets: annual2018,
    });
    expect(toPesoString(result.uncollectibleDeficiency)).toBe("0.00");
  });

  it("distinguishes the two refund deadlines by trigger", () => {
    const common = {
      taxableRegular: "300000",
      taxableSupplementary: "0",
      taxWithheldByThisEmployer: "50000",
      annualBrackets: annual2018,
    } as const;
    expect(annualize({ ...common, trigger: "year_end" }).settlement.action).toBe(
      "refund_by_jan_25",
    );
    expect(annualize({ ...common, trigger: "termination" }).settlement.action).toBe(
      "refund_at_last_pay",
    );
  });

  it("counts the previous employer's withholding toward the credit", () => {
    // Omitting it overstates the deficiency by exactly that amount — the
    // failure mode behind requiring the prior 2316 before the first run.
    const withPrior = annualize({
      trigger: "year_end",
      taxableRegular: "150000",
      taxableSupplementary: "0",
      previousEmployerTaxable: "125000",
      taxWithheldByThisEmployer: "4167.00",
      taxWithheldByPreviousEmployer: "4167.00",
      annualBrackets: annual2018,
    });
    const without = annualize({
      trigger: "year_end",
      taxableRegular: "150000",
      taxableSupplementary: "0",
      previousEmployerTaxable: "125000",
      taxWithheldByThisEmployer: "4167.00",
      annualBrackets: annual2018,
    });
    expect(withPrior.outcome).toBe("excess");
    expect(without.outcome).toBe("deficiency");
  });
});
