import { describe, it, expect } from "vitest";
import { asOf, isInForce } from "@/lib/tax/as-of";
import { runWithholding } from "@/lib/tax/engine";
import { toPesoString } from "@/lib/tax/money";
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

function freshState(overrides: Partial<EmployeeYearState> = {}): EmployeeYearState {
  return {
    taxableYear: 2026,
    method: "regular",
    latchedReason: null,
    latchedAtPeriodEnd: null,
    ytdTaxableRegular: "0",
    ytdTaxableSupplementary: "0",
    ytdTaxWithheld: "0",
    periodsElapsed: 0,
    previousEmployer: null,
    ...overrides,
  };
}

const monthly2026 = bracketsFor("monthly", "2026-06-30");
const annual2026 = bracketsFor("annual", "2026-12-31");

describe("runWithholding — path selection", () => {
  it("takes the regular path for an ordinary salary", () => {
    const result = runWithholding({
      compensation: { regular: { basicSalary: "30000" } },
      period: "monthly",
      periodEnd: "2026-01-31",
      brackets: monthly2026,
      state: freshState(),
    });
    expect(result.path).toBe("regular");
    expect(result.taxPesos).toBe("1375.05");
    expect(result.nextState.method).toBe("regular");
  });

  it("nets mandatory contributions before bracketing", () => {
    // End-to-end proof that gross goes in and the taxable base comes out net —
    // the trap the BIR calculator pushes onto its user.
    const result = runWithholding({
      compensation: {
        regular: { basicSalary: "30000" },
        mandatoryContributions: { sss: "1350", philHealth: "750", pagIbig: "200" },
      },
      period: "monthly",
      periodEnd: "2026-01-31",
      brackets: monthly2026,
      state: freshState(),
    });
    expect(toPesoString(result.segregated.taxableRegular)).toBe("27700.00");
    // 0 + 15% × (27,700 − 20,833)
    expect(result.taxPesos).toBe("1030.05");
  });

  it("switches to the cumulative path when a trigger fires, and records why", () => {
    const result = runWithholding({
      compensation: {
        regular: { basicSalary: "20000" },
        supplementary: { commission: "25000" },
      },
      period: "monthly",
      periodEnd: "2026-07-31",
      brackets: monthly2026,
      state: freshState(),
    });
    expect(result.path).toBe("cumulative_average");
    expect(result.latchedReason).toBe("supplementary_at_or_above_regular");
    expect(result.nextState.method).toBe("cumulative_average");
    expect(result.nextState.latchedAtPeriodEnd).toBe("2026-07-31");
    // The B4 case: divisor 1, not July's calendar index.
    expect(result.taxPesos).toBe("4208.40");
  });

  it("keeps the latch once set, even when the condition stops holding", () => {
    // August: a plain salary with no supplementary. Under the regular method
    // this would be ₱1,375.05; the latch means the cumulative method governs
    // for the rest of the calendar year.
    const july = runWithholding({
      compensation: {
        regular: { basicSalary: "20000" },
        supplementary: { commission: "25000" },
      },
      period: "monthly",
      periodEnd: "2026-07-31",
      brackets: monthly2026,
      state: freshState(),
    });

    const august = runWithholding({
      compensation: { regular: { basicSalary: "30000" } },
      period: "monthly",
      periodEnd: "2026-08-31",
      brackets: monthly2026,
      state: july.nextState,
    });

    expect(august.path).toBe("cumulative_average");
    expect(august.latchedReason).toBe("already_latched");
    expect(august.taxPesos).not.toBe("1375.05");
  });

  it("takes the cumulative path from the first run for a hire with a prior employer", () => {
    const result = runWithholding({
      compensation: { regular: { basicSalary: "35000" } },
      period: "monthly",
      periodEnd: "2018-07-31",
      brackets: bracketsFor("monthly", "2018-07-31"),
      state: freshState({
        taxableYear: 2018,
        previousEmployer: {
          taxableCompensation: "180000",
          taxWithheld: "11000.40",
          periodsCovered: 6,
          employmentFrom: "2018-01-01",
          employmentTo: "2018-06-30",
        },
      }),
    });
    expect(result.path).toBe("cumulative_average");
    expect(result.latchedReason).toBe("new_hire_with_previous_employer");
  });
});

describe("runWithholding — the annualized path", () => {
  it("overrides the per-period method in December", () => {
    const result = runWithholding({
      compensation: { regular: { basicSalary: "50000" }, supplementary: { overtimePay: "10000" } },
      period: "monthly",
      periodEnd: "2018-12-31",
      brackets: bracketsFor("monthly", "2018-12-31"),
      state: freshState({
        taxableYear: 2018,
        ytdTaxableRegular: "550000",
        ytdTaxWithheld: "73334.25",
      }),
      annualize: { trigger: "year_end", annualBrackets: bracketsFor("annual", "2018-12-31") },
    });

    expect(result.path).toBe("annualized");
    // Illustration 15 case 1: ₱600,000 basic + ₱10,000 overtime = ₱610,000.
    expect(toPesoString(result.annualization!.totalTaxableCompensation)).toBe("610000.00");
    expect(result.annualization!.taxDuePesos).toBe("82500.00");
    expect(result.taxPesos).toBe("9165.75");
  });

  it("withholds nothing when annualization produces a refund", () => {
    // An excess is refunded to the employee and recovered by the employer
    // against its own remittance — never a negative withholding.
    const result = runWithholding({
      compensation: { regular: { basicSalary: "25000" } },
      period: "monthly",
      periodEnd: "2018-12-31",
      brackets: bracketsFor("monthly", "2018-12-31"),
      state: freshState({
        taxableYear: 2018,
        ytdTaxableRegular: "125000",
        ytdTaxWithheld: "4167.00",
        previousEmployer: {
          taxableCompensation: "125000",
          taxWithheld: "4167.00",
          periodsCovered: 5,
          employmentFrom: "2018-01-01",
          employmentTo: "2018-05-31",
        },
      }),
      annualize: { trigger: "year_end", annualBrackets: bracketsFor("annual", "2018-12-31") },
    });

    // Illustration 15 case 2 (Mr. Gerry).
    expect(result.annualization!.outcome).toBe("excess");
    expect(result.annualization!.amountPesos).toBe("3334.00");
    expect(result.taxPesos).toBe("0.00");
    expect(result.annualization!.settlement.action).toBe("refund_by_jan_25");
  });

  it("uses the termination refund deadline when employment ends mid-year", () => {
    const result = runWithholding({
      compensation: { regular: { basicSalary: "120000" } },
      period: "monthly",
      periodEnd: "2018-06-30",
      brackets: bracketsFor("monthly", "2018-06-30"),
      state: freshState({
        taxableYear: 2018,
        ytdTaxableRegular: "600000",
        ytdTaxWithheld: "134164.50",
      }),
      annualize: { trigger: "termination", annualBrackets: bracketsFor("annual", "2018-06-30") },
    });
    // Illustration 13 (Mr. Bembem).
    expect(result.annualization!.amountPesos).toBe("24164.50");
    expect(result.annualization!.settlement.action).toBe("refund_at_last_pay");
  });
});

describe("runWithholding — state advance", () => {
  it("accumulates year-to-date figures across periods", () => {
    let state = freshState();
    for (let month = 1; month <= 3; month++) {
      const result = runWithholding({
        compensation: { regular: { basicSalary: "30000" } },
        period: "monthly",
        periodEnd: `2026-0${month}-28`,
        brackets: monthly2026,
        state,
      });
      state = result.nextState;
    }
    expect(state.periodsElapsed).toBe(3);
    expect(state.ytdTaxableRegular).toBe("90000.00");
    expect(state.ytdTaxWithheld).toBe("4125.15"); // 1,375.05 × 3
  });

  it("advances the period count on the annualized path too", () => {
    const result = runWithholding({
      compensation: { regular: { basicSalary: "50000" } },
      period: "monthly",
      periodEnd: "2026-12-31",
      brackets: monthly2026,
      state: freshState({ periodsElapsed: 11, ytdTaxableRegular: "550000" }),
      annualize: { trigger: "year_end", annualBrackets: annual2026 },
    });
    expect(result.nextState.periodsElapsed).toBe(12);
    expect(result.nextState.ytdTaxableRegular).toBe("600000.00");
  });
});
