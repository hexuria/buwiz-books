import { describe, it, expect } from "vitest";
import { asOf, isInForce } from "@/lib/tax/as-of";
import { segregate } from "@/lib/tax/compensation";
import { toPesoString as toPesoStringOf, toScaled } from "@/lib/tax/money";
import { WITHHOLDING_BRACKETS } from "@/lib/tax/reference-catalog";
import {
  annexFor,
  computeRegular,
  evaluateTriggers,
  selectBracket,
  type Bracket,
} from "@/lib/tax/withholding";
import type { PayrollPeriod } from "@/db/schema/tax-reference";

/** Resolve the bracket table the way production will: from the catalog, by as-of date. */
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

const ANNEX_E_DATE = "2026-06-30";

describe("annexFor", () => {
  it("splits the two generations at 1 January 2023", () => {
    expect(annexFor("2022-12-31")).toBe("D");
    expect(annexFor("2023-01-01")).toBe("E");
    expect(annexFor("2026-08-17")).toBe("E");
  });
});

describe("selectBracket", () => {
  const monthly = bracketsFor("monthly", ANNEX_E_DATE);

  it.each([
    ["0", 0],
    ["20832.99", 0],
    ["20833", 1],
    ["33332", 1],
    ["33333", 2],
    ["666667", 5],
    ["10000000", 5],
  ])("puts %s in bracket %i", (amount, expectedIndex) => {
    expect(selectBracket(monthly, toScaled(amount)).bracketIndex).toBe(expectedIndex);
  });

  it("does not depend on the order the rows arrive in", () => {
    // A mis-ordered table would otherwise select a lower bracket and
    // under-withhold, silently.
    const shuffled = [...monthly].reverse();
    expect(selectBracket(shuffled, toScaled("50000")).bracketIndex).toBe(2);
  });
});

/**
 * Golden vectors for the REGULAR method, computed under Annex E.
 *
 * These are the vectors from docs/tax/DECISIONS.md §2.6 that remain valid.
 * Former vector F is deliberately absent: it trips a cumulative-average
 * trigger and therefore must NOT be computed by the regular method at all —
 * see the trigger suite below and IMPLEMENTATION-PLAN.md blocker B4.
 *
 * The RR's own Illustrations 6-15 are the authoritative vectors and compute
 * under ANNEX D; they land once retrieved from primary text (DECISIONS U7).
 */
describe("computeRegular — golden vectors (Annex E)", () => {
  it("A: monthly 30,000 regular, no supplementary → 1,375.05", () => {
    const comp = segregate({ regular: { basicSalary: "30000" } });
    const result = computeRegular(comp, bracketsFor("monthly", ANNEX_E_DATE), "monthly");
    // bracket floor 20,833 @ 15%, prescribed 0 → 0.15 × 9,167
    expect(result.bracket.bracketIndex).toBe(1);
    expect(result.taxPesos).toBe("1375.05");
  });

  it("B: monthly 50,000 regular + 10,000 overtime → 7,208.40", () => {
    const comp = segregate({
      regular: { basicSalary: "50000" },
      supplementary: { overtimePay: "10000" },
    });
    const result = computeRegular(comp, bracketsFor("monthly", ANNEX_E_DATE), "monthly");
    // floor 33,333, prescribed 1,875 @ 20% → 1,875 + 0.20 × (16,667 + 10,000)
    expect(result.taxPesos).toBe("7208.40");
  });

  it("C: semi-monthly 20,000 regular + 5,000 commission → 2,604.10", () => {
    const comp = segregate({
      regular: { basicSalary: "20000" },
      supplementary: { commission: "5000" },
    });
    const result = computeRegular(comp, bracketsFor("semi_monthly", ANNEX_E_DATE), "semi_monthly");
    // floor 16,667, prescribed 937.50 @ 20% → 937.50 + 0.20 × (3,333 + 5,000)
    expect(result.taxPesos).toBe("2604.10");
  });

  it("D: daily 600 → 0.00, diverging from the BIR calculator's bug", () => {
    // getDailyZero() returns `(regular - 0) + supplementary` for the 0% bracket
    // instead of 0 — so BIR's own page shows a daily-paid worker earning ₱600
    // a withholding tax of ₱600. Every other period correctly returns 0. We do
    // not replicate it. See DECISIONS §2.5c.
    const comp = segregate({ regular: { basicSalary: "600" } });
    const result = computeRegular(comp, bracketsFor("daily", ANNEX_E_DATE), "daily");
    expect(result.bracket.bracketIndex).toBe(0);
    expect(result.bracket.rateBps).toBe(0);
    expect(result.taxPesos).toBe("0.00");
  });

  it("E: annual 1,200,000 regular + 200,000 supplementary → 252,500.00", () => {
    const comp = segregate({
      regular: { basicSalary: "1200000" },
      supplementary: { otherTaxableSupplementary: "200000" },
    });
    const result = computeRegular(comp, bracketsFor("annual", ANNEX_E_DATE), "annual");
    // floor 800,000, prescribed 102,500 @ 25% → 102,500 + 0.25 × 600,000
    expect(result.taxPesos).toBe("252500.00");
  });

  it("withholds nothing below the 0% bracket in every period", () => {
    const cases: Array<[PayrollPeriod, string]> = [
      ["daily", "684"],
      ["weekly", "4807"],
      ["semi_monthly", "10416"],
      ["monthly", "20832"],
      ["annual", "249999"],
    ];
    for (const [period, amount] of cases) {
      const comp = segregate({ regular: { basicSalary: amount } });
      const result = computeRegular(comp, bracketsFor(period, ANNEX_E_DATE), period);
      expect(result.taxPesos, `${period} @ ${amount}`).toBe("0.00");
    }
  });

  it("resolves a 2019 date to Annex D and produces a different figure", () => {
    // The B3 guard, end to end: the same inputs must not silently compute
    // under the 2023 table when the payroll date is 2019.
    const comp = segregate({ regular: { basicSalary: "30000" } });
    const annexD = computeRegular(comp, bracketsFor("monthly", "2019-06-30"), "monthly");
    const annexE = computeRegular(comp, bracketsFor("monthly", ANNEX_E_DATE), "monthly");
    // Annex D taxes this bracket at 20%, Annex E at 15%.
    expect(annexD.bracket.rateBps).toBe(2000);
    expect(annexE.bracket.rateBps).toBe(1500);
    expect(annexD.taxPesos).not.toBe(annexE.taxPesos);
    expect(annexD.taxPesos).toBe("1833.40");
  });

  it("throws rather than guessing when no bracket is in force", () => {
    const comp = segregate({ regular: { basicSalary: "30000" } });
    expect(() => computeRegular(comp, [], "monthly")).toThrow(/no withholding bracket/);
  });
});

/**
 * RR 11-2018's OWN worked examples for the ordinary method, Illustrations 6-9.
 *
 * All four are 2018 fact patterns and compute under ANNEX D — which is why the
 * catalog seeds both generations. Run at an Annex E date they all fail, and the
 * cheapest way to make them pass would be to edit the live 2026 constants.
 */
const ANNEX_D_DATE = "2018-06-30";

describe("computeRegular — RR 11-2018 illustrations (Annex D)", () => {
  it("Illustration 6: daily 2,500 → 448.56 (Ms. Joc)", () => {
    // floor 2,192, prescribed 356.16 @ 30%; excess 308.00 × 30% = 92.40
    const comp = segregate({ regular: { basicSalary: "2500" } });
    const result = computeRegular(comp, bracketsFor("daily", ANNEX_D_DATE), "daily");
    expect(result.taxPesos).toBe("448.56");
  });

  it("Illustration 7: weekly 9,500 → 1,028.92 (Ms. Haidee)", () => {
    // floor 7,692, prescribed 576.92 @ 25%; excess 1,808.00 × 25% = 452.00
    const comp = segregate({ regular: { basicSalary: "9500" } });
    const result = computeRegular(comp, bracketsFor("weekly", ANNEX_D_DATE), "weekly");
    expect(result.taxPesos).toBe("1028.92");
  });

  it("Illustration 8: semi-monthly 15,500 → 1,016.60 (Ms. Rose)", () => {
    // floor 10,417, prescribed 0.00 @ 20%; excess 5,083.00 × 20%
    const comp = segregate({ regular: { basicSalary: "15500" } });
    const result = computeRegular(comp, bracketsFor("semi_monthly", ANNEX_D_DATE), "semi_monthly");
    expect(result.taxPesos).toBe("1016.60");
  });

  it("Illustration 9: monthly 165,000 + 5,000 supplementary → 41,833.23 (Ms. Lyn)", () => {
    // The RR states this answer INCONSISTENTLY, in two separate ways, and both
    // errors are in the narrative sentence rather than the tabulation:
    //
    //   (1) the narrative concludes "P43,659.89" while its own tabulation
    //       immediately below totals 10,833.33 + 30,999.90 = 41,833.23;
    //   (2) the narrative states the excess as "P103,833" while the tabulation
    //       gives 103,333 — a digit transposition.
    //
    // The narrative is not even self-consistent: it prints excess 103,833 and
    // then a tax of 30,999.90, which is 103,333 × 30%, not 103,833 × 30%.
    // RMC 1-2018 Example 4 explains where 43,659.89 came from — it is the
    // correct answer to a DIFFERENT fact pattern, asserted separately below.
    //
    // The tabulation is arithmetically correct and is what we assert.
    const comp = segregate({
      regular: { basicSalary: "165000" },
      supplementary: { otherTaxableSupplementary: "5000" },
    });
    const result = computeRegular(comp, bracketsFor("monthly", ANNEX_D_DATE), "monthly");
    expect(result.bracket.bracketIndex).toBe(3); // floor 66,667 @ 30%
    expect(toPesoStringOf(result.excessOverFloor)).toBe("103333.00");
    expect(result.taxPesos).toBe("41833.23");
  });

  it("RMC 1-2018 Example 4: monthly 170,500 + 5,000 → 43,659.89", () => {
    // Rescues the 43,659.89 figure for the fact pattern it actually belongs to,
    // and exercises the 32% column that no RR illustration reaches.
    const comp = segregate({
      regular: { basicSalary: "170500" },
      supplementary: { otherTaxableSupplementary: "5000" },
    });
    const result = computeRegular(comp, bracketsFor("monthly", ANNEX_D_DATE), "monthly");
    expect(result.bracket.rateBps).toBe(3200);
    expect(result.taxPesos).toBe("43659.89");
  });

  it("brackets on REGULAR alone even when supplementary would cross a boundary", () => {
    // SYNTHESIZED, and load-bearing: no RR illustration discriminates the two
    // candidate designs. Illustration 9's regular (165,000) and its
    // regular+supplementary (170,000) fall in the SAME column, so an engine
    // that wrongly brackets on the total still passes it.
    //
    // Here they straddle the 66,667 boundary. Bracketing on regular (65,000)
    // gives 12,916.75; bracketing on the total (75,000) would give 13,333.23.
    // Without this the dual-basis rule — Step 3 brackets on regular, Step 4
    // applies that column's rate to regular PLUS supplementary — is untested,
    // and the bug silently overtaxes anyone whose supplementary pay would have
    // pushed them up a column.
    const comp = segregate({
      regular: { basicSalary: "65000" },
      supplementary: { commission: "10000" },
    });
    const result = computeRegular(comp, bracketsFor("monthly", ANNEX_D_DATE), "monthly");
    expect(result.bracket.bracketIndex).toBe(2); // floor 33,333 — chosen by 65,000
    expect(result.taxPesos).toBe("12916.75");
    expect(result.taxPesos).not.toBe("13333.23");
  });

  it("Illustration 4: an MWE's additional commission does not tax the minimum wage", () => {
    // Ms. Alona. Total received 260,000 EXCEEDS the 250,000 annual threshold,
    // yet nothing is due: only the 20,000 commission enters the taxable base.
    // A naive "gross > 250k therefore taxable" implementation fails this.
    // The MWE rule is a SUBTRACTION, not a cliff — additional compensation does
    // not retroactively tax the statutory minimum wage.
    const comp = segregate({
      regular: { basicSalary: "0" },
      supplementary: { commission: "20000" },
      nonTaxable: {
        basicSalaryMwe: "175000",
        overtimePayMwe: "40000",
        nightShiftDifferentialMwe: "25000",
      },
    });
    expect(toPesoStringOf(comp.grossCompensation)).toBe("260000.00");
    expect(toPesoStringOf(comp.totalTaxable)).toBe("20000.00");

    const result = computeRegular(comp, bracketsFor("annual", ANNEX_D_DATE), "annual");
    expect(result.taxPesos).toBe("0.00");
  });

  it("selects the annex by the date compensation is paid", () => {
    // Blocker B3's guard, and it should be non-negotiable. Every illustration
    // above is pinned to a 2018 as-of; without this assertion a refactor that
    // silently defaulted as-of to "today" would red-build them all, and the
    // cheapest way to green them is to edit the LIVE 2026 constants —
    // re-rating every client.
    const comp = segregate({ regular: { basicSalary: "50000" } });
    const d = computeRegular(comp, bracketsFor("monthly", "2018-06-15"), "monthly");
    const e = computeRegular(comp, bracketsFor("monthly", "2026-06-15"), "monthly");
    expect(d.taxPesos).toBe("6666.75"); // 2,500.00 + 25% × (50,000 − 33,333)
    expect(e.taxPesos).toBe("5208.40"); // 1,875.00 + 20% × (50,000 − 33,333)
  });
});

/**
 * The three RR 11-2018 §2.79(B)(5)(a) triggers.
 *
 * These decide WHICH method the law requires. Getting a trigger wrong does not
 * produce a slightly-off number — it applies the wrong statutory procedure.
 */
describe("evaluateTriggers", () => {
  const base = {
    bracketFloor: toScaled("20833"),
    hasPreviousEmployerThisYear: false,
    alreadyLatched: false,
  };

  it("stays on the regular method for an ordinary salary", () => {
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("30000"),
      taxableSupplementary: toScaled("0"),
    });
    expect(result.method).toBe("regular");
    expect(result.reason).toBeNull();
  });

  it("stays regular when supplementary is present but small and regular clears the level", () => {
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("50000"),
      taxableSupplementary: toScaled("10000"),
      bracketFloor: toScaled("33333"),
    });
    expect(result.method).toBe("regular");
  });

  it("trigger (ii): supplementary at or above regular", () => {
    // The case former golden vector F described. Under the regular method it
    // would compute ₱75,000 by bracketing ₱500,000 of commission at the 15%
    // column — which is exactly why the law does not permit that method here.
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("20833"),
      taxableSupplementary: toScaled("500000"),
    });
    expect(result.method).toBe("cumulative_average");
    expect(result.reason).toBe("supplementary_at_or_above_regular");
  });

  it("trigger (ii) fires on exact equality, not only above", () => {
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("25000"),
      taxableSupplementary: toScaled("25000"),
    });
    expect(result.method).toBe("cumulative_average");
    expect(result.reason).toBe("supplementary_at_or_above_regular");
  });

  it("trigger (i): regular below the compensation level with supplementary paid", () => {
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("15000"),
      taxableSupplementary: toScaled("3000"),
    });
    expect(result.method).toBe("cumulative_average");
    expect(result.reason).toBe("regular_below_level_with_supplementary");
  });

  it("does not fire trigger (i) when no supplementary is paid", () => {
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("15000"),
      taxableSupplementary: toScaled("0"),
    });
    expect(result.method).toBe("regular");
  });

  it("trigger (iii): new hire with a previous employer this year", () => {
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("30000"),
      taxableSupplementary: toScaled("0"),
      hasPreviousEmployerThisYear: true,
    });
    expect(result.method).toBe("cumulative_average");
    expect(result.reason).toBe("new_hire_with_previous_employer");
  });

  it("stays latched once triggered, even when the condition stops holding", () => {
    // Sticky for the remainder of the calendar year. An employee who received
    // one large commission in March does not revert to the regular method in
    // April.
    const result = evaluateTriggers({
      ...base,
      taxableRegular: toScaled("30000"),
      taxableSupplementary: toScaled("0"),
      alreadyLatched: true,
    });
    expect(result.method).toBe("cumulative_average");
    expect(result.reason).toBe("already_latched");
  });
});
