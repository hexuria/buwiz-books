/**
 * The compensation withholding engine's public entry point.
 *
 * One call per employee per payroll period. It performs the segregation,
 * decides which of the three statutory paths the law requires, computes, and
 * returns the next year-state to persist.
 *
 * The three paths and what selects them:
 *
 *   ANNUALIZED         December, or the last period on termination. Overrides
 *                      everything — it runs on the ANNUAL schedule regardless
 *                      of which method ran in the earlier periods.
 *   CUMULATIVE AVERAGE any §2.79(B)(5)(a) trigger has fired this calendar year.
 *   REGULAR            otherwise.
 *
 * Callers do not choose. There is no configuration switch, because the law does
 * not offer one — see DECISIONS D3.
 *
 * The engine is PURE: it reads reference data passed in, and returns the state
 * to persist rather than persisting it. That is what lets the whole legal
 * correctness surface be tested without a database.
 */
import { annualize, type AnnualizationResult } from "./annualization";
import { segregate, type CompensationInput, type SegregatedCompensation } from "./compensation";
import { computeCumulativeAverage, type CumulativeAverageResult } from "./cumulative-average";
import { toPesoString, toScaled, type ScaledMoney } from "./money";
import type { PayrollPeriod } from "../../db/schema/tax-reference";
import {
  computeRegular,
  evaluateTriggers,
  selectBracket,
  type Bracket,
  type EmployeeYearState,
  type TriggerReason,
  type WithholdingComputation,
} from "./withholding";

export interface WithholdingRunInput {
  compensation: CompensationInput;
  period: PayrollPeriod;
  /** The period's end date. Selects the annex generation. */
  periodEnd: string;
  /** Brackets for `period`, already resolved at `periodEnd`. */
  brackets: readonly Bracket[];
  /** The employee's year-to-date state. */
  state: EmployeeYearState;
  /**
   * Force the annualized path. Set for the December run and for the final
   * period on termination — the two cases RR 11-2018 names.
   */
  annualize?: {
    trigger: "year_end" | "termination";
    /** The ANNUAL schedule for the taxable year. */
    annualBrackets: readonly Bracket[];
    lastCompensationPayment?: string;
  };
}

export interface WithholdingRunResult {
  segregated: SegregatedCompensation;
  path: "regular" | "cumulative_average" | "annualized";
  /** Present on the two per-period paths. */
  computation?: WithholdingComputation | CumulativeAverageResult;
  /** Present on the annualized path. */
  annualization?: AnnualizationResult;
  /** The amount to withhold this period. */
  taxPesos: string;
  /** Persist this — the latch and the accumulators both advance here. */
  nextState: EmployeeYearState;
  /** Why the cumulative method engaged, when it did. */
  latchedReason: TriggerReason | null;
}

export function runWithholding(input: WithholdingRunInput): WithholdingRunResult {
  const segregated = segregate(input.compensation);
  const { state, brackets, period } = input;

  // The annualized path overrides both per-period methods. It is the true-up,
  // and it runs on the annual schedule whatever ran before it.
  if (input.annualize) {
    const annualization = annualize({
      trigger: input.annualize.trigger,
      // Year-to-date INCLUDING this final period.
      taxableRegular: toPesoString(
        (toScaled(state.ytdTaxableRegular) + segregated.taxableRegular) as ScaledMoney,
      ),
      taxableSupplementary: toPesoString(
        (toScaled(state.ytdTaxableSupplementary) + segregated.taxableSupplementary) as ScaledMoney,
      ),
      previousEmployerTaxable: state.previousEmployer?.taxableCompensation,
      taxWithheldByThisEmployer: state.ytdTaxWithheld,
      taxWithheldByPreviousEmployer: state.previousEmployer?.taxWithheld,
      lastCompensationPayment: input.annualize.lastCompensationPayment,
      annualBrackets: input.annualize.annualBrackets,
    });

    // Only a deficiency is withheld here. An excess is refunded to the employee
    // and recovered by the employer against its own remittance — it is not a
    // negative withholding.
    const taxPesos =
      annualization.outcome === "deficiency" ? toPesoString(annualization.deficiency) : "0.00";

    return {
      segregated,
      path: "annualized",
      annualization,
      taxPesos,
      latchedReason: state.latchedReason,
      nextState: advance(
        state,
        segregated,
        taxPesos,
        state.method,
        state.latchedReason,
        input.periodEnd,
      ),
    };
  }

  // Trigger (i) compares regular compensation against the floor of the bracket
  // it falls into, so the bracket must be selected before the triggers can be
  // evaluated.
  const provisionalBracket = selectBracket(brackets, segregated.taxableRegular);

  const evaluation = evaluateTriggers({
    taxableRegular: segregated.taxableRegular,
    taxableSupplementary: segregated.taxableSupplementary,
    bracketFloor: toScaled(provisionalBracket.floorAmount),
    hasPreviousEmployerThisYear: state.previousEmployer != null,
    alreadyLatched: state.method === "cumulative_average",
  });

  const latchedReason = evaluation.reason ?? state.latchedReason;

  const computation =
    evaluation.method === "cumulative_average"
      ? computeCumulativeAverage({
          taxableRegular: segregated.taxableRegular,
          taxableSupplementary: segregated.taxableSupplementary,
          state,
          period,
          brackets,
        })
      : computeRegular(segregated, brackets, period);

  return {
    segregated,
    path: evaluation.method,
    computation,
    taxPesos: computation.taxPesos,
    latchedReason,
    nextState: advance(
      state,
      segregated,
      computation.taxPesos,
      evaluation.method,
      latchedReason,
      input.periodEnd,
    ),
  };
}

/**
 * Roll the year-state forward.
 *
 * The latch is one-way: once `cumulative_average`, it stays so for the rest of
 * the calendar year even if the condition that set it stops holding.
 */
function advance(
  state: EmployeeYearState,
  segregated: SegregatedCompensation,
  taxPesos: string,
  method: EmployeeYearState["method"],
  latchedReason: TriggerReason | null,
  periodEnd: string,
): EmployeeYearState {
  const latching = method === "cumulative_average" && state.method !== "cumulative_average";
  return {
    ...state,
    method: state.method === "cumulative_average" ? "cumulative_average" : method,
    latchedReason,
    latchedAtPeriodEnd: latching ? periodEnd : state.latchedAtPeriodEnd,
    ytdTaxableRegular: toPesoString(
      (toScaled(state.ytdTaxableRegular) + segregated.taxableRegular) as ScaledMoney,
    ),
    ytdTaxableSupplementary: toPesoString(
      (toScaled(state.ytdTaxableSupplementary) + segregated.taxableSupplementary) as ScaledMoney,
    ),
    ytdTaxWithheld: toPesoString(
      (toScaled(state.ytdTaxWithheld) + toScaled(taxPesos)) as ScaledMoney,
    ),
    periodsElapsed: state.periodsElapsed + 1,
  };
}
