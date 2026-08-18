/**
 * The annualized withholding tax method — RR 11-2018 §2.79(B), Steps 1-4.
 *
 * This is the THIRD computation path, not a variant of the other two. It runs
 * in exactly two situations, and in both it replaces the per-period table
 * entirely:
 *
 *   TERMINATION   the employer-employee relationship ends before December
 *   YEAR-END      the December adjustment
 *
 * It uses the ANNUAL NIRC Sec. 24(A)(2) schedule, not the per-period Annex D/E
 * table, regardless of which method ran in the periods before it. That is why
 * RR 11-2018's Illustration 12 stops its step-by-step at November even though
 * its own fact table lists a December row — December belongs here.
 *
 * The annualized figure is the AUTHORITATIVE one. Everything withheld during
 * the year was an estimate, and this is the true-up. It is also what feeds the
 * alphabetical list attached to BIR Form 1604-C, which the RR states expressly.
 *
 * ── THE OUTCOME IS A POSTING, NOT A NUMBER ───────────────────────────────────
 * Step 4 produces one of three results, and two of them move money:
 *
 *   EXACT       nothing further to withhold
 *   DEFICIENCY  withheld from the last compensation payment of the year. If it
 *               EXCEEDS that last payment, the employer must pay the shortfall
 *               itself and recover from the employee — the RR calls that "a
 *               matter of settlement between the employee and employer", which
 *               in ledger terms is an employer expense plus an employee
 *               receivable, not a silent zero.
 *   EXCESS      refunded to the employee, and the employer recovers it by
 *               DEDUCTING the refund from its own remittance for that month and
 *               succeeding months until fully repaid. So the control account
 *               will legitimately diverge from the period's computed
 *               withholding, and the reconciliation invariant must expect it.
 *
 * The refund deadline differs by branch, which is easy to get wrong:
 *   year-end     not later than 25 JANUARY of the following year
 *   termination  at the payment of the LAST COMPENSATION during the year
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  addAll,
  applyRateBps,
  clampAtZero,
  roundToCentavos,
  toPesoString,
  toScaled,
  ZERO,
  type ScaledMoney,
} from "./money";
import { selectBracket, type Bracket } from "./withholding";

export type AnnualizationTrigger = "year_end" | "termination";

export interface AnnualizationInput {
  trigger: AnnualizationTrigger;
  /**
   * Taxable regular compensation paid by THIS employer for the whole period
   * covered — start of the calendar year to December, or to termination.
   */
  taxableRegular: string;
  /** Taxable supplementary compensation paid by this employer for the same span. */
  taxableSupplementary: string;
  /**
   * Taxable compensation from previous employers in the same calendar year,
   * per the employee's 2316. Step 2 adds it to the present employer's figures.
   */
  previousEmployerTaxable?: string;
  /** Tax withheld by this employer since the beginning of the year. */
  taxWithheldByThisEmployer: string;
  /** Tax withheld by previous employers in the same year, per the 2316. */
  taxWithheldByPreviousEmployer?: string;
  /**
   * The last compensation payment available to withhold a deficiency from.
   * Omit it and a deficiency is assumed fully collectible; supply it and the
   * engine reports the uncollectible remainder the employer must advance.
   */
  lastCompensationPayment?: string;
  /** The ANNUAL schedule in force for the taxable year. */
  annualBrackets: readonly Bracket[];
}

export type AnnualizationOutcome = "exact" | "deficiency" | "excess";

export interface AnnualizationResult {
  trigger: AnnualizationTrigger;
  /** Step 2 — the whole year's taxable compensation, both employers. */
  totalTaxableCompensation: ScaledMoney;
  /** Step 3 — tax on the annual schedule. The authoritative figure for the year. */
  taxDue: ScaledMoney;
  /** Step 4 — everything already withheld, both employers. */
  totalTaxWithheld: ScaledMoney;
  outcome: AnnualizationOutcome;
  /** Positive when tax is still owed. Zero otherwise. */
  deficiency: ScaledMoney;
  /** Positive when the employee is owed a refund. Zero otherwise. */
  excess: ScaledMoney;
  /**
   * The part of a deficiency that exceeds the last compensation payment. The
   * employer must pay this itself and settle with the employee — it is an
   * employer expense and an employee receivable, not a rounding remainder.
   */
  uncollectibleDeficiency: ScaledMoney;
  /** What the RR requires be done, and by when. */
  settlement: {
    /** `refund_by_jan_25`, `refund_at_last_pay`, `withhold_from_last_pay`, or `none`. */
    action: "none" | "withhold_from_last_pay" | "refund_by_jan_25" | "refund_at_last_pay";
    /** Verbatim-ish statement of the deadline, for surfacing to a bookkeeper. */
    deadline: string;
  };
  taxDuePesos: string;
  amountPesos: string;
}

/**
 * Tax on the annual NIRC Sec. 24(A)(2) schedule.
 *
 * Structurally the same arithmetic as a per-period bracket — basic amount plus
 * a rate on the excess — but over a different table, and with no
 * regular/supplementary split: annualization works on one combined figure.
 */
export function annualTax(
  totalTaxable: ScaledMoney,
  annualBrackets: readonly Bracket[],
): { bracket: Bracket; tax: ScaledMoney } {
  const bracket = selectBracket(annualBrackets, totalTaxable);
  const excess = clampAtZero((totalTaxable - toScaled(bracket.floorAmount)) as ScaledMoney);
  const tax = clampAtZero(
    roundToCentavos(addAll(toScaled(bracket.prescribedTax), applyRateBps(excess, bracket.rateBps))),
  );
  return { bracket, tax };
}

export function annualize(input: AnnualizationInput): AnnualizationResult {
  // Steps 1 and 2 — this employer's figures plus any previous employer's.
  const totalTaxableCompensation = addAll(
    toScaled(input.taxableRegular),
    toScaled(input.taxableSupplementary),
    toScaled(input.previousEmployerTaxable ?? "0"),
  );

  // Step 3 — the annual schedule.
  const { tax: taxDue } = annualTax(totalTaxableCompensation, input.annualBrackets);

  // Step 4 — compare against everything already withheld, by BOTH employers.
  const totalTaxWithheld = addAll(
    toScaled(input.taxWithheldByThisEmployer),
    toScaled(input.taxWithheldByPreviousEmployer ?? "0"),
  );

  const difference = (taxDue - totalTaxWithheld) as ScaledMoney;
  const deficiency = clampAtZero(difference);
  const excess = clampAtZero(-difference as ScaledMoney);

  const outcome: AnnualizationOutcome =
    difference === ZERO ? "exact" : difference > ZERO ? "deficiency" : "excess";

  // A deficiency larger than the final payment cannot be withheld. The RR makes
  // the employer liable for the shortfall and leaves recovery to be settled
  // with the employee — so it must surface as its own figure rather than
  // silently reducing the deficiency.
  let uncollectibleDeficiency = ZERO;
  if (outcome === "deficiency" && input.lastCompensationPayment != null) {
    const lastPay = toScaled(input.lastCompensationPayment);
    uncollectibleDeficiency = clampAtZero((deficiency - lastPay) as ScaledMoney);
  }

  const settlement: AnnualizationResult["settlement"] =
    outcome === "exact"
      ? { action: "none", deadline: "no adjustment required" }
      : outcome === "deficiency"
        ? {
            action: "withhold_from_last_pay",
            deadline:
              "withhold from the last compensation payment for the calendar year; any part " +
              "exceeding that payment is advanced by the employer and settled with the employee",
          }
        : input.trigger === "termination"
          ? {
              action: "refund_at_last_pay",
              deadline: "refund at the payment of the last compensation during the year",
            }
          : {
              action: "refund_by_jan_25",
              deadline: "refund not later than 25 January of the following year",
            };

  return {
    trigger: input.trigger,
    totalTaxableCompensation,
    taxDue,
    totalTaxWithheld,
    outcome,
    deficiency,
    excess,
    uncollectibleDeficiency,
    settlement,
    taxDuePesos: toPesoString(taxDue),
    amountPesos: toPesoString(outcome === "excess" ? excess : deficiency),
  };
}
