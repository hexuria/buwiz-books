import { describe, it, expect } from "vitest";
import { asOf, isInForce } from "@/lib/tax/as-of";
import { computeCumulativeAverage, periodsRepresented } from "@/lib/tax/cumulative-average";
import { toPesoString, toScaled } from "@/lib/tax/money";
import { WITHHOLDING_BRACKETS } from "@/lib/tax/reference-catalog";
import type { Bracket, EmployeeYearState } from "@/lib/tax/withholding";
import type { PayrollPeriod } from "@/db/schema/tax-reference";

function bracketsFor(period: PayrollPeriod, at: string): Bracket[] {
  return WITHHOLDING_BRACKETS.filter(
    (b) => b.payrollPeriod === period && isInForce(b, asOf(at)),
  ).map((b) => ({
    bracketIndex: b.bracketIndex,
    floorAmount: b.floorAmount,
    prescribedTax: b.prescribedTax,
    rateBps: b.rateBps,
  }));
}

/** RR 11-2018's illustrations are all 2018 fact patterns and compute under Annex D. */
const ANNEX_D = "2018-06-30";
const ANNEX_E = "2026-06-30";

function state(overrides: Partial<EmployeeYearState> = {}): EmployeeYearState {
  return {
    taxableYear: 2018,
    method: "cumulative_average",
    latchedReason: "supplementary_at_or_above_regular",
    latchedAtPeriodEnd: null,
    ytdTaxableRegular: "0",
    ytdTaxableSupplementary: "0",
    ytdTaxWithheld: "0",
    periodsElapsed: 0,
    previousEmployer: null,
    ...overrides,
  };
}

describe("periodsRepresented — the Step 2 divisor", () => {
  it("counts only periods worked here when there is no previous employer", () => {
    expect(periodsRepresented(state({ periodsElapsed: 0 }))).toBe(1);
    expect(periodsRepresented(state({ periodsElapsed: 3 }))).toBe(4);
  });

  it("adds the periods the prior 2316 actually covers", () => {
    const withPrior = (periodsCovered: number, periodsElapsed: number) =>
      periodsRepresented(
        state({
          periodsElapsed,
          previousEmployer: {
            taxableCompensation: "180000",
            taxWithheld: "11000.40",
            periodsCovered,
            employmentFrom: "2018-01-01",
            employmentTo: "2018-06-30",
          },
        }),
      );
    // Illustration 12: 6 prior periods, first period here → 7.
    expect(withPrior(6, 0)).toBe(7);
    expect(withPrior(6, 4)).toBe(11);
  });

  it("diverges from the calendar position across an employment gap", () => {
    // Mr. Gerry (Illustration 15 case 2): prior employer January to May, hired
    // 1 July, June unemployed. The aggregate spans 6 periods; July's calendar
    // index is 7. Dividing by 7 understates the tax.
    const gerry = state({
      periodsElapsed: 0,
      previousEmployer: {
        taxableCompensation: "125000",
        taxWithheld: "4167.00",
        periodsCovered: 5,
        employmentFrom: "2018-01-01",
        employmentTo: "2018-05-31",
      },
    });
    expect(periodsRepresented(gerry)).toBe(6);
    expect(periodsRepresented(gerry)).not.toBe(7);
  });
});

/**
 * RR 11-2018 Illustration 10 — trigger 1 (regular below the compensation level,
 * supplementary paid). Ms. Rose, monthly, Annex D, no prior employer.
 *
 * Doubles as proof that this method brackets on regular PLUS supplementary: the
 * January average of ₱35,000 lands in column 3, whereas regular alone (₱15,000)
 * is column 1 and would yield zero.
 */
describe("Illustration 10 — trigger 1, three months (Annex D)", () => {
  const brackets = bracketsFor("monthly", ANNEX_D);

  const months = [
    {
      regular: "15000",
      supplementary: "20000",
      agg: "35000.00",
      avg: "35000.00",
      onAvg: "2916.75",
      cum: "2916.75",
      withhold: "2916.75",
    },
    {
      regular: "15000",
      supplementary: "15000",
      agg: "65000.00",
      avg: "32500.00",
      onAvg: "2333.40",
      cum: "4666.80",
      withhold: "1750.05",
    },
    {
      regular: "15000",
      supplementary: "25000",
      agg: "105000.00",
      avg: "35000.00",
      onAvg: "2916.75",
      cum: "8750.25",
      withhold: "4083.45",
    },
  ];

  it.each(months.map((m, i) => [i + 1, m] as const))("month %i matches the RR", (index, m) => {
    const prior = months.slice(0, index - 1);
    const result = computeCumulativeAverage({
      taxableRegular: toScaled(m.regular),
      taxableSupplementary: toScaled(m.supplementary),
      state: state({
        periodsElapsed: index - 1,
        ytdTaxableRegular: String(prior.reduce((t, p) => t + Number(p.regular), 0)),
        ytdTaxableSupplementary: String(prior.reduce((t, p) => t + Number(p.supplementary), 0)),
        ytdTaxWithheld: index === 1 ? "0" : prior.at(-1)!.cum,
        latchedReason: "regular_below_level_with_supplementary",
      }),
      period: "monthly",
      brackets,
    });

    expect(result.periods).toBe(index);
    expect(toPesoString(result.cumulativeTaxable)).toBe(m.agg);
    expect(toPesoString(result.averageCompensation)).toBe(m.avg);
    expect(toPesoString(result.cumulativeTax)).toBe(m.cum);
    expect(result.taxPesos).toBe(m.withhold);
  });
});

/**
 * RR 11-2018 Illustration 11 — trigger 2 (supplementary at or above regular).
 * Ms. Aimee, monthly, Annex D.
 *
 * This is the ROUNDING vector: ₱95,000 ÷ 3 = 31,666.666… must be carried as
 * ₱31,666.67 for March's excess of ₱10,833.67 × 20% to give ₱2,166.73. Full
 * precision fails it.
 */
describe("Illustration 11 — trigger 2, three months (Annex D)", () => {
  const brackets = bracketsFor("monthly", ANNEX_D);

  const months = [
    {
      regular: "15000",
      supplementary: "15000",
      agg: "30000.00",
      avg: "30000.00",
      cum: "1833.40",
      withhold: "1833.40",
    },
    {
      regular: "15000",
      supplementary: "15000",
      agg: "60000.00",
      avg: "30000.00",
      cum: "3666.80",
      withhold: "1833.40",
    },
    {
      regular: "15000",
      supplementary: "20000",
      agg: "95000.00",
      avg: "31666.67",
      cum: "6500.19",
      withhold: "2833.39",
    },
  ];

  it.each(months.map((m, i) => [i + 1, m] as const))("month %i matches the RR", (index, m) => {
    const prior = months.slice(0, index - 1);
    const result = computeCumulativeAverage({
      taxableRegular: toScaled(m.regular),
      taxableSupplementary: toScaled(m.supplementary),
      state: state({
        periodsElapsed: index - 1,
        ytdTaxableRegular: String(prior.reduce((t, p) => t + Number(p.regular), 0)),
        ytdTaxableSupplementary: String(prior.reduce((t, p) => t + Number(p.supplementary), 0)),
        ytdTaxWithheld: index === 1 ? "0" : prior.at(-1)!.cum,
      }),
      period: "monthly",
      brackets,
    });

    expect(toPesoString(result.cumulativeTaxable)).toBe(m.agg);
    expect(toPesoString(result.averageCompensation)).toBe(m.avg);
    expect(toPesoString(result.cumulativeTax)).toBe(m.cum);
    expect(result.taxPesos).toBe(m.withhold);
  });

  it("carries the average at two decimals, not full precision", () => {
    // The discriminating assertion. 95,000/3 at full precision is
    // 31,666.6666…, which would give an excess of 10,833.6666… and a tax of
    // 2,166.7333… → 2,166.73 by luck. The March OUTPUT of 2,833.39 only falls
    // out if the average itself was rounded first.
    const result = computeCumulativeAverage({
      taxableRegular: toScaled("15000"),
      taxableSupplementary: toScaled("20000"),
      state: state({
        periodsElapsed: 2,
        ytdTaxableRegular: "30000",
        ytdTaxableSupplementary: "30000",
        ytdTaxWithheld: "3666.80",
      }),
      period: "monthly",
      brackets,
    });
    expect(toPesoString(result.averageCompensation)).toBe("31666.67");
  });
});

/**
 * RR 11-2018 Illustration 12 — trigger 3, prior employer, five months.
 * Ms. Leni, hired 6 July 2018 by JPL Corporation; ENA Company January to June,
 * ₱180,000 over 6 periods, ₱11,000.40 withheld.
 *
 * THE KEY VECTOR: trigger 3, prior-employer aggregation and prior-employer tax
 * credit in one. Note it CANNOT discriminate the divisor rule — 6 prior + 1
 * equals July's calendar index of 7 only because the prior employment ran
 * unbroken from January. The gap-month test above is what catches that.
 */
describe("Illustration 12 — trigger 3 with a prior employer (Annex D)", () => {
  const brackets = bracketsFor("monthly", ANNEX_D);
  const previousEmployer = {
    taxableCompensation: "180000",
    taxWithheld: "11000.40",
    periodsCovered: 6,
    employmentFrom: "2018-01-01",
    employmentTo: "2018-06-30",
  };

  /** The RR's own printed intermediates, months July through November. */
  const rr = [
    { agg: "215000.00", avg: "30714.29", divisor: 7 },
    { agg: "250000.00", avg: "31250.00", divisor: 8 },
    { agg: "285000.00", avg: "31666.67", divisor: 9 },
    { agg: "320000.00", avg: "32000.00", divisor: 10 },
    { agg: "355000.00", avg: "32272.73", divisor: 11 },
  ];

  it.each(rr.map((m, i) => [i, m] as const))(
    "month %i reproduces the RR's divisor and average exactly",
    (i, m) => {
      const result = computeCumulativeAverage({
        taxableRegular: toScaled("35000"),
        taxableSupplementary: toScaled("0"),
        state: state({
          periodsElapsed: i,
          ytdTaxableRegular: String(35000 * i),
          previousEmployer,
          latchedReason: "new_hire_with_previous_employer",
        }),
        period: "monthly",
        brackets,
      });

      // The load-bearing assertions: the divisor and the Step 2 average are
      // what the whole method turns on, and both match the RR to the centavo.
      expect(result.periods).toBe(m.divisor);
      expect(toPesoString(result.cumulativeTaxable)).toBe(m.agg);
      expect(toPesoString(result.averageCompensation)).toBe(m.avg);
    },
  );

  it("credits the previous employer's withholding", () => {
    const july = computeCumulativeAverage({
      taxableRegular: toScaled("35000"),
      taxableSupplementary: toScaled("0"),
      state: state({ periodsElapsed: 0, previousEmployer }),
      period: "monthly",
      brackets,
    });
    expect(toPesoString(july.taxAlreadyWithheld)).toBe("11000.40");
  });

  it("diverges from the RR by one centavo in July, because the RR truncates there", () => {
    // A SECOND internal inconsistency in RR 11-2018, alongside Illustration 9's.
    // Within this one illustration:
    //   July      (30,714.29 − 20,833) × 20% = 1,976.258 → RR prints 1,976.25
    //             which is TRUNCATION
    //   November  (32,272.73 − 20,833) × 20% = 2,287.946 → RR prints 2,287.95
    //             which is HALF-UP
    // The two cannot both be the rule. We implement half-up, per the BIR's
    // general practice and DECISIONS D-N6, so July's tax-on-average is 1,976.26
    // rather than the RR's printed 1,976.25 — and that centavo then propagates
    // through Step 4 and Step 5.
    //
    // Documented rather than papered over: matching the RR here would mean
    // truncating, which then breaks November.
    const july = computeCumulativeAverage({
      taxableRegular: toScaled("35000"),
      taxableSupplementary: toScaled("0"),
      state: state({ periodsElapsed: 0, previousEmployer }),
      period: "monthly",
      brackets,
    });

    expect(toPesoString(july.averageCompensation)).toBe("30714.29"); // matches the RR
    expect(toPesoString(july.cumulativeTax)).toBe("13833.82"); // RR prints 13,833.75
    expect(july.taxPesos).toBe("2833.42"); // RR prints 2,833.35
  });

  it("reproduces November's half-up figure exactly", () => {
    // The other side of the same inconsistency: here half-up IS what the RR
    // printed, which is the reason we follow it rather than truncation.
    const november = computeCumulativeAverage({
      taxableRegular: toScaled("35000"),
      taxableSupplementary: toScaled("0"),
      state: state({ periodsElapsed: 4, ytdTaxableRegular: "140000", previousEmployer }),
      period: "monthly",
      brackets,
    });
    expect(toPesoString(november.averageCompensation)).toBe("32272.73");
    // 2,287.95 × 11 — the RR's own Step 4 figure.
    expect(toPesoString(november.cumulativeTax)).toBe("25167.45");
  });
});

describe("computeCumulativeAverage — guards", () => {
  const monthlyE = bracketsFor("monthly", ANNEX_E);

  it("blocker B4: a mid-year hire with no previous employer is withheld the real tax", () => {
    // Hired 1 July 2026, no prior employer. Regular ₱20,000 plus supplementary
    // ₱25,000 latches trigger 2. The aggregate relates to ONE period, so the
    // divisor is 1 — not July's calendar index of 7, which would average to
    // ₱6,428.57, land in the 0% bracket and withhold nothing all year.
    const result = computeCumulativeAverage({
      taxableRegular: toScaled("20000"),
      taxableSupplementary: toScaled("25000"),
      state: state({ periodsElapsed: 0, taxableYear: 2026 }),
      period: "monthly",
      brackets: monthlyE,
    });
    expect(result.periods).toBe(1);
    expect(toPesoString(result.averageCompensation)).toBe("45000.00");
    expect(result.taxPesos).toBe("4208.40");
  });

  it("pins what the wrong divisor would have produced", () => {
    const wrong = computeCumulativeAverage({
      taxableRegular: toScaled("20000"),
      taxableSupplementary: toScaled("25000"),
      state: state({ periodsElapsed: 0, taxableYear: 2026 }),
      period: "monthly",
      brackets: monthlyE,
      periodsOverride: 7,
    });
    expect(wrong.taxPesos).toBe("0.00");
  });

  it("never withholds a negative amount", () => {
    // Step 5 says "the excess, if any". An over-withheld employee is refunded
    // at annualization, not through a mid-year negative withholding.
    const result = computeCumulativeAverage({
      taxableRegular: toScaled("10000"),
      taxableSupplementary: toScaled("0"),
      state: state({ periodsElapsed: 1, ytdTaxableRegular: "10000", ytdTaxWithheld: "50000" }),
      period: "monthly",
      brackets: monthlyE,
    });
    expect(result.taxPesos).toBe("0.00");
    expect(result.overWithheld).toBe(true);
  });

  it("brackets the combined average, unlike the ordinary method", () => {
    // Regular ₱20,833 alone sits in the 15% column under Annex E; combined with
    // ₱25,000 supplementary the average lands in the 20% column instead.
    const result = computeCumulativeAverage({
      taxableRegular: toScaled("20833"),
      taxableSupplementary: toScaled("25000"),
      state: state({ periodsElapsed: 0, taxableYear: 2026 }),
      period: "monthly",
      brackets: monthlyE,
    });
    expect(result.bracket.bracketIndex).toBe(2);
    expect(result.bracket.rateBps).toBe(2000);
  });

  it("throws rather than guessing when no bracket is in force", () => {
    expect(() =>
      computeCumulativeAverage({
        taxableRegular: toScaled("20000"),
        taxableSupplementary: toScaled("0"),
        state: state(),
        period: "monthly",
        brackets: [],
      }),
    ).toThrow(/no withholding bracket/);
  });
});
