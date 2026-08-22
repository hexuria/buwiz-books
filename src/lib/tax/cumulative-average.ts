/**
 * The cumulative average method — RR 11-2018 §2.79(B)(5)(a).
 *
 * MANDATORY, not elective, whenever one of the three triggers in
 * `withholding.ts` fires, and sticky for the rest of the calendar year. It
 * brackets on the cumulative AVERAGE of regular plus supplementary — a
 * different quantity from the regular method's regular-only figure — which is
 * why the two live behind a dispatcher rather than sharing one function.
 *
 * The shape, from the prescribed steps:
 *
 *   1. cumulate  total taxable compensation for the year to date, INCLUDING any
 *                previous employer's figures from the employee's 2316
 *   2. average   divide by the number of payroll periods the cumulated amount
 *                relates to                                         ← see below
 *   3. bracket   look the average up in the table for the payroll period
 *   4. project   multiply the tax on the average back up by the same divisor
 *   5. net       subtract tax already withheld this year, including any
 *                withheld by the previous employer
 *
 * ── THE DIVISOR, WHICH IS WHERE THIS METHOD GOES WRONG ───────────────────────
 * Step 2's divisor is the single value that decides whether this method
 * withholds correctly or withholds nothing, and the calendar position of the
 * period is NEVER the rule. Two failures, both real:
 *
 *   NO PREVIOUS EMPLOYER. An employee hired in July with ₱45,000 of taxable pay
 *   divided by 7 lands in the 0% bracket and is withheld ₱0.00 every month to
 *   December, where ₱4,208.40 a month was due. The year's shortfall then
 *   surfaces as a deficiency the employer must advance.
 *
 *   EMPLOYMENT GAP. Using the RR's own facts for Mr. Gerry (Illustration 15
 *   case 2) — prior employer January to May, hired 1 July, June unemployed —
 *   the aggregate spans 6 periods while the calendar index is 7. Dividing by 7
 *   averages the pay down and understates the tax.
 *
 * The divisor counts the periods actually REPRESENTED IN THE AGGREGATE, in both
 * branches: `previousEmployer.periodsCovered + periods paid here`. RR 11-2018's
 * Illustration 12 cannot discriminate the two readings — Ms. Leni's prior
 * employment ran unbroken from January, so 6 + 1 = 7 = July's calendar index —
 * which is exactly why the wrong reading survives casual checking.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  addAll,
  clampAtZero,
  divideHalfUp,
  multiplyByPeriods,
  roundToCentavos,
  toPesoString,
  toScaled,
  ZERO,
  type ScaledMoney,
} from "./money";
import type { PayrollPeriod } from "../../db/schema/tax-reference";
import {
  NoBracketError,
  selectBracket,
  applyBracket,
  type Bracket,
  type EmployeeYearState,
  type WithholdingComputation,
} from "./withholding";

export interface CumulativeAverageInput {
  /** Taxable regular compensation for the CURRENT period. */
  taxableRegular: ScaledMoney;
  /** Taxable supplementary compensation for the CURRENT period. */
  taxableSupplementary: ScaledMoney;
  /** Year-to-date state carried in from prior runs. */
  state: EmployeeYearState;
  period: PayrollPeriod;
  brackets: readonly Bracket[];
  /**
   * Override the Step 2 divisor.
   *
   * Provided so the one genuinely unsettled value in this method can be pinned
   * by a caller — or by a test asserting the RR's own illustrations — without
   * touching the algorithm.
   */
  periodsOverride?: number;
}

/**
 * The Step 2 divisor: how many payroll periods the cumulated numerator spans.
 *
 * It is the count of periods actually REPRESENTED IN THE AGGREGATE, and it is
 * never the calendar position of the current period. The two coincide in
 * RR 11-2018's Illustration 12 — Ms. Leni's prior employment ran unbroken from
 * January, so 6 prior periods + 1 current = 7 = July's calendar index — which
 * is precisely why that illustration cannot discriminate the two readings, and
 * why the wrong one survives casual checking.
 *
 * They diverge on an EMPLOYMENT GAP. Using the RR's own facts for Mr. Gerry
 * (Illustration 15 case 2): prior employer January to May, hired 1 July, June
 * unemployed. Periods represented = 5 + 1 = 6; the calendar index is 7. Dividing
 * by 7 averages the compensation down and understates the tax.
 *
 * `periodsCovered` must come from an explicit field captured alongside the 2316
 * amounts — never inferred from the calendar, and never derived by dividing the
 * compensation by a guessed rate.
 */
export function periodsRepresented(state: EmployeeYearState): number {
  const here = state.periodsElapsed + 1;
  const prior = state.previousEmployer?.periodsCovered ?? 0;
  return prior + here;
}

export interface CumulativeAverageResult extends WithholdingComputation {
  cumulativeTaxable: ScaledMoney;
  periods: number;
  averageCompensation: ScaledMoney;
  /** Tax on the whole year to date, before crediting what is already withheld. */
  cumulativeTax: ScaledMoney;
  taxAlreadyWithheld: ScaledMoney;
  /** True when the credit exceeds the cumulative tax — a year-end refund case. */
  overWithheld: boolean;
}

/** Compute withholding under the cumulative average method. */
export function computeCumulativeAverage(input: CumulativeAverageInput): CumulativeAverageResult {
  const { state, brackets, period } = input;
  if (brackets.length === 0) throw new NoBracketError(period, toPesoString(input.taxableRegular));

  // Step 1 — cumulate, including the previous employer's taxable compensation.
  const previousTaxable = toScaled(state.previousEmployer?.taxableCompensation ?? "0");
  const previousWithheld = toScaled(state.previousEmployer?.taxWithheld ?? "0");

  const cumulativeTaxable = addAll(
    toScaled(state.ytdTaxableRegular),
    toScaled(state.ytdTaxableSupplementary),
    input.taxableRegular,
    input.taxableSupplementary,
    previousTaxable,
  );

  // Step 2 — average over the periods the numerator actually spans, carried at
  // TWO DECIMALS. Illustration 12 prints 215,000 ÷ 7 as 30,714.29, and it is
  // that rounding which produces the characteristic centavo jitter in its
  // outputs (2,833.35 / .45 / .37 / .43 / .45). Full precision yields a flat
  // figure every month and is therefore demonstrably not what the RR does.
  const periods = Math.max(1, input.periodsOverride ?? periodsRepresented(state));
  const averageCompensation = divideHalfUp(cumulativeTaxable, periods);

  // Step 3 — bracket the AVERAGE. The regular/supplementary split dies at
  // Step 1 and must not be carried past it: unlike the ordinary method, whose
  // Step 3 brackets on regular alone, this is one combined figure.
  const bracket = selectBracket(brackets, averageCompensation);
  const floor = toScaled(bracket.floorAmount);
  const excessOverFloor = clampAtZero((averageCompensation - floor) as ScaledMoney);
  const { prescribedTax, taxOnExcess, tax: taxOnAverage } = applyBracket(bracket, excessOverFloor);

  // Step 4 — project back up over the same number of periods. An exact integer
  // multiply: the value was already rounded at Step 3 and re-rounding here
  // would move it a second time.
  const cumulativeTax = multiplyByPeriods(taxOnAverage, periods);

  // Step 5 — credit what has already been withheld, here and by the prior employer.
  const taxAlreadyWithheld = addAll(toScaled(state.ytdTaxWithheld), previousWithheld);
  const net = (cumulativeTax - taxAlreadyWithheld) as ScaledMoney;

  // A negative net means the employee has been over-withheld to date. Nothing
  // is withheld this period; the refund is settled at annualization, not by
  // handing money back mid-year through a negative withholding.
  const tax = clampAtZero(roundToCentavos(net));

  return {
    method: "cumulative_average",
    bracketingAmount: averageCompensation,
    bracket,
    excessOverFloor,
    taxOnExcess,
    prescribedTax,
    tax,
    taxPesos: toPesoString(tax),
    cumulativeTaxable,
    periods,
    averageCompensation,
    cumulativeTax,
    taxAlreadyWithheld,
    overWithheld: net < ZERO,
  };
}
