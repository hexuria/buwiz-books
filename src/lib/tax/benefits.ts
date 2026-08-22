/**
 * De minimis ceilings and the ₱90,000 benefits ceiling.
 *
 * ── THE MECHANIC, WHICH IS AGGREGATION AND NOT A WATERFALL ───────────────────
 * The BIR calculator tells its user to compute the total de minimis excess, then
 * "deduct the excess from the difference between the prescribed ₱90,000 ceiling
 * over the non-taxable 13th month pay", then type any remainder into "Other
 * Taxable Supplementary". That reads like an ordered absorption with a
 * priority between the two pools.
 *
 * It is not. RMC 50-2018 A5 shows a single AGGREGATION: excess de minimis is
 * added INTO "other benefits", and the ₱90,000 is applied to the resulting
 * total. Arithmetically equivalent, but the framing matters — modelled as a
 * waterfall you build an allocator, decide an ordering, and acquire a bug.
 * See DECISIONS A6.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things make this stateful rather than a pure per-period calculation:
 *
 *  1. The ₱90,000 ceiling is ANNUAL. It must be tested against year-to-date
 *     totals, not the current period, or an employee crossing it in November is
 *     never taxed on the excess. The BIR calculator gets this wrong — it
 *     compares one input box against ₱90,000 with no YTD awareness at all.
 *
 *  2. Each of the eleven de minimis types carries its OWN ceiling with its own
 *     accumulation window, so a single lumped "de minimis" figure cannot produce
 *     the per-type excess the ₱90,000 pool needs.
 */
import {
  addAll,
  applyPercent,
  clampAtZero,
  maxOf,
  minOf,
  toScaled,
  ZERO,
  type ScaledMoney,
} from "./money";
import type { DeMinimisLimitKind } from "../../db/schema/tax-reference";

/** The statutory ceiling on 13th month pay and other benefits. NIRC §32(B)(7)(e) as amended by TRAIN. */
export const BENEFITS_CEILING_PESOS = "90000";

/** A de minimis ceiling row, as resolved from the catalog for a given as-of date. */
export interface ResolvedCeiling {
  benefitType: string;
  limitKind: DeMinimisLimitKind;
  /** Null only when `limitKind` is `uncapped`. */
  limitAmount: string | null;
  permittedForms: string[] | null;
  /**
   * Non-amount conditions the benefit must ALSO satisfy to be de minimis at all.
   *
   * The employee achievement award is the case that forces this: the exemption
   * is subject to three cumulative conditions, not one — the form, the occasion
   * ("for length of service or safety achievement"), and receipt "under an
   * established written plan which does not discriminate in favor of highly
   * paid employees". RR 4-2025 relaxed only the form limb and expressly kept
   * the other two.
   *
   * Failing ANY of them takes the whole award out of de minimis — it does not
   * merely create an excess.
   */
  qualifyingConditions: string[] | null;
  citation: string;
}

/**
 * What the employee received of one de minimis type, within that type's own
 * accumulation window.
 *
 * The window is implied by `limitKind`: a monthly ceiling accumulates per
 * calendar month, a semestral one per semester, an annual one per taxable year.
 * The caller supplies the amount for the correct window — the engine does not
 * guess a window from a date, because payroll periods and ceiling windows do
 * not align (a semi-monthly run sits inside a monthly rice-subsidy ceiling).
 */
export interface DeMinimisItemInput {
  benefitType: string;
  /** Peso amount received within this type's accumulation window, to date. */
  amountInWindow: string;
  /**
   * For `days_per_year` ceilings (monetized leave): days credited in the year.
   * The ceiling is a DAY COUNT, so the excess is measured in days and valued at
   * `dailyRate` — comparing pesos against a day count would be meaningless.
   */
  daysInWindow?: number;
  /** Required when `limitKind` is `days_per_year`. */
  dailyRate?: string;
  /**
   * Required when `limitKind` is `pct_of_regional_smw` (the OT / night-shift
   * meal allowance, capped at a percentage of the regional basic minimum wage).
   * A stale regional wage table silently corrupts this ceiling — see DECISIONS D4.
   */
  regionalDailyMinimumWage?: string;
  /**
   * The form the benefit took. RR 4-2025 changed the permitted FORM of employee
   * achievement awards without changing the amount, so a benefit in a
   * disallowed form is fully taxable regardless of how small it is.
   *
   * REQUIRED whenever the ceiling restricts forms. Omitting it fails CLOSED —
   * see `evaluateDeMinimisItem`.
   */
  form?: string;
  /**
   * Attestation that the ceiling's non-amount `qualifyingConditions` are met.
   *
   * Required whenever the ceiling declares any. Like `form`, omitting it fails
   * closed: the regulation's conditions are exclusionary on their face, so an
   * unasserted condition is an unmet one.
   */
  conditionsAttested?: boolean;
}

export interface DeMinimisItemResult {
  benefitType: string;
  exempt: ScaledMoney;
  excess: ScaledMoney;
  /**
   * Set when the WHOLE amount is taxable because the benefit failed a
   * qualifying condition rather than merely exceeding its ceiling. These are
   * different outcomes and a payslip should be able to say which happened.
   */
  disqualifiedReason?: "form_not_permitted" | "form_not_stated" | "conditions_not_attested";
}

/**
 * A capped ceiling arrived with no limit amount.
 *
 * Its own class rather than a generic error because the failure it prevents is
 * specific: treating the null as zero makes the entire benefit an excess and
 * taxes it in full, which reads as a rule rather than corrupt data.
 */
export class CorruptCeilingError extends Error {
  constructor(benefitType: string, limitKind: string) {
    super(
      `de minimis "${benefitType}" is ${limitKind} but its catalog row carries no limit amount — ` +
        `a null amount is legal only with "uncapped"`,
    );
    this.name = "CorruptCeilingError";
  }
}

export class MissingCeilingContextError extends Error {
  constructor(benefitType: string, needs: string) {
    super(
      `de minimis "${benefitType}" has a ${needs} ceiling but the input omits the context it needs`,
    );
    this.name = "MissingCeilingContextError";
  }
}

/**
 * The ceiling for one item, in pesos, for its accumulation window.
 *
 * Returns null for `uncapped` — the government leave-monetization benefit has
 * no ceiling at all, which an amount-only model cannot express.
 */
function ceilingInPesos(ceiling: ResolvedCeiling, item: DeMinimisItemInput): ScaledMoney | null {
  switch (ceiling.limitKind) {
    case "uncapped":
      return null;

    case "peso_per_month":
    case "peso_per_semester":
    case "peso_per_year":
      return toScaled(requireLimit(ceiling));

    case "days_per_year": {
      if (item.dailyRate == null)
        throw new MissingCeilingContextError(item.benefitType, "day-count");
      // A day count valued at the employee's daily rate.
      const days = BigInt(Math.trunc(Number(requireLimit(ceiling))));
      return (toScaled(item.dailyRate) * days) as ScaledMoney;
    }

    case "pct_of_regional_smw": {
      if (item.regionalDailyMinimumWage == null) {
        throw new MissingCeilingContextError(item.benefitType, "percentage-of-minimum-wage");
      }
      return applyPercent(toScaled(item.regionalDailyMinimumWage), Number(requireLimit(ceiling)));
    }
  }
}

/**
 * A capped ceiling with no amount is corrupt reference data, not a zero ceiling.
 *
 * Treating a null as "0" would make the entire benefit an excess and quietly
 * tax it in full — the failure mode looks like a rule, not a bug. The catalog's
 * own invariant is that a null amount is legal only with `uncapped`.
 */
function requireLimit(ceiling: ResolvedCeiling): string {
  if (ceiling.limitAmount == null) {
    throw new CorruptCeilingError(ceiling.benefitType, ceiling.limitKind);
  }
  return ceiling.limitAmount;
}

/**
 * Whether the benefit fails a non-amount condition outright.
 *
 * Returns the reason, or null when every declared condition is satisfied.
 */
function disqualify(
  item: DeMinimisItemInput,
  ceiling: ResolvedCeiling,
): DeMinimisItemResult["disqualifiedReason"] | null {
  if (ceiling.permittedForms != null) {
    if (item.form == null) return "form_not_stated";
    if (!ceiling.permittedForms.includes(item.form)) return "form_not_permitted";
  }
  if (ceiling.qualifyingConditions != null && ceiling.qualifyingConditions.length > 0) {
    if (item.conditionsAttested !== true) return "conditions_not_attested";
  }
  return null;
}

/** Split one de minimis benefit into its exempt portion and its excess. */
export function evaluateDeMinimisItem(
  item: DeMinimisItemInput,
  ceiling: ResolvedCeiling,
): DeMinimisItemResult {
  const amount = toScaled(item.amountInWindow);

  // Qualifying conditions come before the ceiling, and they FAIL CLOSED.
  //
  // The regulation's wording is exclusionary — an achievement award "must be in
  // the form of a tangible personal property other than cash or gift
  // certificate" — so a benefit whose form is not stated is not thereby
  // permitted. Failing open here silently exempts a cash award, which is fully
  // taxable however small.
  //
  // Failing a condition takes the WHOLE amount out of de minimis; it does not
  // merely create an excess over the ceiling.
  const disqualifiedReason = disqualify(item, ceiling);
  if (disqualifiedReason) {
    return { benefitType: item.benefitType, exempt: ZERO, excess: amount, disqualifiedReason };
  }

  const cap = ceilingInPesos(ceiling, item);
  if (cap === null) {
    return { benefitType: item.benefitType, exempt: amount, excess: ZERO };
  }

  // For a day-count ceiling the comparison is in days, then valued.
  if (ceiling.limitKind === "days_per_year" && item.daysInWindow != null) {
    const allowedDays = Math.trunc(Number(ceiling.limitAmount ?? "0"));
    const excessDays = Math.max(0, item.daysInWindow - allowedDays);
    if (excessDays === 0) return { benefitType: item.benefitType, exempt: amount, excess: ZERO };
    const excess = minOf(
      (toScaled(item.dailyRate ?? "0") * BigInt(excessDays)) as ScaledMoney,
      amount,
    );
    return {
      benefitType: item.benefitType,
      exempt: clampAtZero((amount - excess) as ScaledMoney),
      excess,
    };
  }

  return {
    benefitType: item.benefitType,
    exempt: minOf(amount, cap),
    excess: clampAtZero((amount - cap) as ScaledMoney),
  };
}

export interface BenefitsInput {
  /** Every de minimis benefit received, each within its own accumulation window. */
  deMinimis: DeMinimisItemInput[];
  /** Ceilings resolved from the catalog at the payroll period's as-of date. */
  ceilings: ResolvedCeiling[];
  /** Year-to-date 13th month pay and other benefits, INCLUDING this period. */
  thirteenthMonthAndOtherBenefitsYtd: string;
}

export interface BenefitsResult {
  perItem: DeMinimisItemResult[];
  /** De minimis within every per-type ceiling — non-taxable, and not in the pool. */
  deMinimisExempt: ScaledMoney;
  /** Aggregate excess, which joins "other benefits" per RMC 50-2018 A5. */
  deMinimisExcess: ScaledMoney;
  /** 13th month + other benefits + de minimis excess, year to date. */
  otherBenefitsPool: ScaledMoney;
  /** The portion within ₱90,000 — non-taxable. */
  nonTaxableBenefits: ScaledMoney;
  /** The excess over ₱90,000 — taxable SUPPLEMENTARY compensation. */
  taxableBenefits: ScaledMoney;
}

export class MissingCeilingError extends Error {
  constructor(benefitType: string) {
    super(
      `no de minimis ceiling in force for "${benefitType}" — the reference catalog is missing a row, ` +
        `or the as-of date falls in a gap between generations`,
    );
    this.name = "MissingCeilingError";
  }
}

/**
 * Compute the de minimis split and the ₱90,000 benefits ceiling.
 *
 * `thirteenthMonthAndOtherBenefitsYtd` must be YEAR-TO-DATE. The ceiling is
 * annual, so testing a single period against it never taxes an employee who
 * crosses ₱90,000 late in the year.
 */
export function computeBenefits(input: BenefitsInput): BenefitsResult {
  const byType = new Map(input.ceilings.map((c) => [c.benefitType, c]));

  const perItem = input.deMinimis.map((item) => {
    const ceiling = byType.get(item.benefitType);
    // Failing loud beats treating an unknown benefit as fully exempt, which
    // would under-withhold silently.
    if (!ceiling) throw new MissingCeilingError(item.benefitType);
    return evaluateDeMinimisItem(item, ceiling);
  });

  const deMinimisExempt = addAll(...perItem.map((r) => r.exempt));
  const deMinimisExcess = addAll(...perItem.map((r) => r.excess));

  // The aggregation. Excess de minimis is not absorbed against a remaining
  // ₱90,000 headroom in some order — it simply joins the pool, and the ceiling
  // applies to the total.
  const otherBenefitsPool = addAll(
    toScaled(input.thirteenthMonthAndOtherBenefitsYtd),
    deMinimisExcess,
  );

  const ceiling = toScaled(BENEFITS_CEILING_PESOS);
  const nonTaxableBenefits = minOf(otherBenefitsPool, ceiling);
  const taxableBenefits = maxOf(ZERO, (otherBenefitsPool - ceiling) as ScaledMoney);

  return {
    perItem,
    deMinimisExempt,
    deMinimisExcess,
    otherBenefitsPool,
    nonTaxableBenefits,
    taxableBenefits,
  };
}
