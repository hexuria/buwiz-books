/**
 * Withholding tax on compensation — the bracket engine and the method dispatcher.
 *
 * RR 11-2018 §2.79(B) prescribes TWO methods, and which one applies is not a
 * preference:
 *
 *   REGULAR            the ordinary case. Bracket selected by taxable REGULAR
 *                      compensation; supplementary joins the excess term.
 *
 *   CUMULATIVE AVERAGE MANDATORY when any of three §2.79(B)(5)(a) triggers
 *                      fires, and sticky for the rest of the calendar year once
 *                      it does. It brackets on the cumulative AVERAGE of
 *                      regular plus supplementary — a different quantity — so
 *                      one shared bracketing function is the wrong abstraction.
 *                      Two named methods behind one dispatcher.
 *
 * There is deliberately NO configuration switch between them. An org cannot
 * elect a bracketing method; the law picks. See DECISIONS D3.
 *
 * PERIODIC WITHHOLDING IS AN ESTIMATE. The year-end annualization is the
 * authoritative figure and trues it up. Anything presenting a periodic number
 * as final is misrepresenting it.
 */
import {
  addAll,
  applyRateBps,
  clampAtZero,
  roundToCentavos,
  toScaled,
  toPesoString,
  ZERO,
  type ScaledMoney,
} from "./money";
import type { PayrollPeriod, WithholdingAnnex } from "../../db/schema/tax-reference";
import type { SegregatedCompensation } from "./compensation";

/** One bracket row, as resolved from the catalog for a period and an as-of date. */
export interface Bracket {
  bracketIndex: number;
  floorAmount: string;
  prescribedTax: string;
  rateBps: number;
}

export type WithholdingMethod = "regular" | "cumulative_average";

export class NoBracketError extends Error {
  constructor(period: PayrollPeriod, amount: string) {
    super(
      `no withholding bracket in force for ${period} at ${amount} — the reference catalog is ` +
        `missing rows, or the as-of date falls between annex generations`,
    );
    this.name = "NoBracketError";
  }
}

/**
 * Select the bracket whose floor the amount reaches.
 *
 * Brackets are half-open upward: the highest floor at or below the amount wins.
 * Sorted defensively rather than trusting caller order — a mis-ordered table
 * would silently select a lower bracket and under-withhold.
 */
export function selectBracket(brackets: readonly Bracket[], amount: ScaledMoney): Bracket {
  const ordered = [...brackets].sort((a, b) =>
    Number(toScaled(a.floorAmount) - toScaled(b.floorAmount)),
  );
  let chosen: Bracket | null = null;
  for (const bracket of ordered) {
    if (amount >= toScaled(bracket.floorAmount)) chosen = bracket;
    else break;
  }
  return chosen ?? ordered[0];
}

export interface WithholdingComputation {
  method: WithholdingMethod;
  /** The figure that selected the bracket — differs by method. */
  bracketingAmount: ScaledMoney;
  bracket: Bracket;
  /** The amount taxed at the bracket's marginal rate. */
  excessOverFloor: ScaledMoney;
  taxOnExcess: ScaledMoney;
  prescribedTax: ScaledMoney;
  tax: ScaledMoney;
  /** Ready for a return or a payslip. */
  taxPesos: string;
}

/**
 * The bracket arithmetic itself: `prescribed + rate × excess`.
 *
 * Shared by both methods so the rounding happens in exactly one place. The two
 * methods differ in WHICH figure selects the bracket and WHAT the excess is
 * measured against — not in this step.
 */
export function applyBracket(
  bracket: Bracket,
  excessOverFloor: ScaledMoney,
): { prescribedTax: ScaledMoney; taxOnExcess: ScaledMoney; tax: ScaledMoney } {
  const prescribedTax = toScaled(bracket.prescribedTax);
  const taxOnExcess = applyRateBps(excessOverFloor, bracket.rateBps);
  return {
    prescribedTax,
    taxOnExcess,
    tax: clampAtZero(roundToCentavos(addAll(prescribedTax, taxOnExcess))),
  };
}

/**
 * The regular method. RR 11-2018 §2.79(B), Steps 1-5.
 *
 *   tax = prescribed(bracket of REGULAR) + rate × ((REGULAR − floor) + SUPPLEMENTARY)
 *
 * The bracket is chosen by taxable regular compensation ALONE. Supplementary
 * compensation is added into the excess term without moving the column, which
 * is why a small regular salary plus a large commission is taxed at the low
 * bracket's marginal rate.
 *
 * That distortion is real and intended at the periodic stage — but when
 * supplementary is large relative to regular it also TRIPS a cumulative-average
 * trigger, so this method should not be reached for that case at all. The
 * dispatcher enforces that; this function does not second-guess its caller.
 */
export function computeRegular(
  comp: Pick<SegregatedCompensation, "taxableRegular" | "taxableSupplementary">,
  brackets: readonly Bracket[],
  period: PayrollPeriod,
): WithholdingComputation {
  if (brackets.length === 0) throw new NoBracketError(period, toPesoString(comp.taxableRegular));

  const bracket = selectBracket(brackets, comp.taxableRegular);
  const floor = toScaled(bracket.floorAmount);

  const excessOverFloor = addAll(
    clampAtZero((comp.taxableRegular - floor) as ScaledMoney),
    comp.taxableSupplementary,
  );
  const { prescribedTax, taxOnExcess, tax } = applyBracket(bracket, excessOverFloor);

  return {
    method: "regular",
    bracketingAmount: comp.taxableRegular,
    bracket,
    excessOverFloor,
    taxOnExcess,
    prescribedTax,
    tax,
    taxPesos: toPesoString(tax),
  };
}

/**
 * The three §2.79(B)(5)(a) triggers for the cumulative average method.
 *
 * Evaluated on EVERY payroll run. Once any fires, the method latches for the
 * remainder of the calendar year — it does not un-latch when the condition
 * stops holding.
 */
export interface TriggerContext {
  /** Taxable regular compensation for the period. */
  taxableRegular: ScaledMoney;
  /** Taxable supplementary compensation for the period. */
  taxableSupplementary: ScaledMoney;
  /** The floor of the bracket the regular compensation falls into. */
  bracketFloor: ScaledMoney;
  /** True when the employee was hired mid-year AND had a previous employer that year. */
  hasPreviousEmployerThisYear: boolean;
  /** Already latched by an earlier period in the same calendar year. */
  alreadyLatched: boolean;
}

export type TriggerReason =
  | "already_latched"
  | "regular_below_level_with_supplementary"
  | "supplementary_at_or_above_regular"
  | "new_hire_with_previous_employer";

export interface TriggerEvaluation {
  method: WithholdingMethod;
  reason: TriggerReason | null;
}

export function evaluateTriggers(ctx: TriggerContext): TriggerEvaluation {
  if (ctx.alreadyLatched) {
    return { method: "cumulative_average", reason: "already_latched" };
  }
  // (iii) newly hired with a previous employer in the same calendar year.
  if (ctx.hasPreviousEmployerThisYear) {
    return { method: "cumulative_average", reason: "new_hire_with_previous_employer" };
  }
  // (ii) supplementary equal to or more than regular.
  if (ctx.taxableSupplementary > ZERO && ctx.taxableSupplementary >= ctx.taxableRegular) {
    return { method: "cumulative_average", reason: "supplementary_at_or_above_regular" };
  }
  // (i) regular below the compensation level, but supplementary paid.
  if (ctx.taxableSupplementary > ZERO && ctx.taxableRegular < ctx.bracketFloor) {
    return { method: "cumulative_average", reason: "regular_below_level_with_supplementary" };
  }
  return { method: "regular", reason: null };
}

/**
 * Per-employee, per-calendar-year withholding state.
 *
 * Stateful because the law is: the method latch, the year-to-date accumulators
 * the cumulative method averages over, and the prior employer's figures all
 * persist across runs. An "engine only, no payroll tables" scope is not
 * achievable — see DECISIONS D2.
 */
export interface EmployeeYearState {
  taxableYear: number;
  method: WithholdingMethod;
  latchedReason: TriggerReason | null;
  latchedAtPeriodEnd: string | null;
  /** Cumulative taxable regular at THIS employer, excluding the current period. */
  ytdTaxableRegular: string;
  /** Cumulative taxable supplementary at THIS employer, excluding the current period. */
  ytdTaxableSupplementary: string;
  /** Tax already withheld by THIS employer this year, excluding the current period. */
  ytdTaxWithheld: string;
  /** Payroll periods already run at THIS employer this year. */
  periodsElapsed: number;
  /** Figures carried in from a prior employer's 2316, if any. */
  previousEmployer: PreviousEmployerFigures | null;
}

/**
 * A prior employer's year-to-date figures, from the employee's 2316.
 *
 * A BLOCKING precondition of the first payroll run for any mid-year hire
 * (DECISIONS D7): without it the cumulative average method has an incomplete
 * numerator and under-withholds for the rest of the year.
 */
export interface PreviousEmployerFigures {
  taxableCompensation: string;
  taxWithheld: string;
  /** Payroll periods the prior employer covered in this calendar year. */
  periodsCovered: number;
  employmentFrom: string;
  employmentTo: string;
}

export const PAYROLL_PERIODS_PER_YEAR: Record<PayrollPeriod, number> = {
  daily: 261,
  weekly: 52,
  semi_monthly: 24,
  monthly: 12,
  annual: 1,
};

/** The bracket generation an as-of date resolves to. Annex D 2018-2022, Annex E 2023-. */
export function annexFor(asOfDate: string): WithholdingAnnex {
  return asOfDate < "2023-01-01" ? "D" : "E";
}
