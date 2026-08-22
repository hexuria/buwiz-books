/**
 * The compensation taxonomy, and the segregation every withholding computation
 * starts from.
 *
 * RR 11-2018 §2.79(B) sorts every peso an employee receives into exactly three
 * buckets, and everything downstream follows from that sort:
 *
 *   REGULAR        taxable, and selects the bracket
 *   SUPPLEMENTARY  taxable, added to the excess but does NOT move the bracket
 *   NON-TAXABLE    excluded entirely
 *
 * ── THE TRAP THIS MODULE EXISTS TO REMOVE ────────────────────────────────────
 * The BIR's own online calculator takes `Basic Salary` ALREADY NET of the
 * employee's mandatory contributions. Its tooltip says so ("...paid less: net
 * of mandatory deductions (GSIS, SSS, Philhealth and Pag-IBIG)"), and its
 * source confirms it: the contributions are subtracted and then added straight
 * back, so they never reduce the tax base — the user was expected to type a
 * pre-reduced figure.
 *
 * Feeding GROSS basic salary into that same arithmetic over-withholds for every
 * employee. So this module takes GROSS and performs the netting itself. The
 * caller cannot get it wrong, because there is no input that means "already
 * netted". See DECISIONS §2.5a.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { addAll, clampAtZero, toScaled, type ScaledMoney } from "./money";

/**
 * Gross regular compensation, before mandatory contributions.
 *
 * "Regular" is compensation paid per payroll period regardless of performance:
 * basic pay and fixed allowances. It is this total — not the total including
 * supplementary — that selects the withholding bracket under §2.79(B) Step 3.
 */
export interface RegularCompensationInput {
  basicSalary: string;
  representationAllowance?: string;
  transportationAllowance?: string;
  costOfLivingAllowance?: string;
  fixedHousingAllowance?: string;
  /** Any other compensation paid every period. */
  otherTaxableRegular?: string;
}

/**
 * Supplementary compensation — paid in addition to the regular amount, with or
 * without regard to a payroll period.
 *
 * `taxableThirteenthMonthAndOtherBenefits` is DERIVED, never entered: it is the
 * excess of year-to-date 13th month pay and other benefits over the ₱90,000
 * statutory ceiling, computed by the de minimis / benefits engine.
 */
export interface SupplementaryCompensationInput {
  commission?: string;
  profitSharing?: string;
  /** Directors who are employees. A non-employee director's fee is EWT, not compensation. */
  directorsFees?: string;
  overtimePay?: string;
  /** Hazard pay that does NOT qualify for the MWE exemption. */
  hazardPay?: string;
  /** Derived from the ₱90,000 ceiling test — see `benefits.ts`. */
  taxableThirteenthMonthAndOtherBenefits?: string;
  /** Taxable retirement pay, taxable separation pay, and excess de minimis. */
  otherTaxableSupplementary?: string;
}

/**
 * Non-taxable and exempt compensation.
 *
 * The MWE items stay exempt even when the employee earns other taxable income —
 * RR 11-2018 §2.78.1(B)(13), which implements Soriano v. Secretary of Finance
 * (G.R. No. 184450). Only the additional compensation is withheld upon. The BIR
 * calculator's tooltip says the opposite and is stale; we implement the
 * regulation. See DECISIONS A3/D4.
 */
export interface NonTaxableCompensationInput {
  /** Statutory minimum wage of a qualified MWE. */
  basicSalaryMwe?: string;
  holidayPayMwe?: string;
  overtimePayMwe?: string;
  nightShiftDifferentialMwe?: string;
  /** Hazard pay that QUALIFIES for the MWE exemption (DOLE certification on file). */
  hazardPayMwe?: string;
  /** The non-taxable portion of 13th month pay and other benefits (≤ ₱90,000). */
  thirteenthMonthAndOtherBenefits?: string;
  /** De minimis benefits within their per-type ceilings. */
  deMinimisBenefits?: string;
  /** Non-taxable retirement and separation benefits. */
  nonTaxableRetirementSeparation?: string;
  /** Remuneration incident to employment, treaty-exempt income, damages, and the like. */
  otherExempt?: string;
}

/**
 * The employee's OWN share of statutory contributions and union dues.
 *
 * These are a deduction from gross compensation, not an employer expense — the
 * employer's share is a separate cost. They reduce the taxable base, which is
 * the whole reason this input is separate from the non-taxable bucket.
 */
export interface MandatoryContributionsInput {
  sss?: string;
  philHealth?: string;
  pagIbig?: string;
  unionDues?: string;
}

export interface CompensationInput {
  regular: RegularCompensationInput;
  supplementary?: SupplementaryCompensationInput;
  nonTaxable?: NonTaxableCompensationInput;
  /** Employee share only. Deducted from gross regular to reach the taxable base. */
  mandatoryContributions?: MandatoryContributionsInput;
}

/** The segregation, with every intermediate the caller might need to show on a 2316. */
export interface SegregatedCompensation {
  grossRegular: ScaledMoney;
  employeeContributions: ScaledMoney;
  /** Gross regular less the employee's mandatory contributions. Selects the bracket. */
  taxableRegular: ScaledMoney;
  taxableSupplementary: ScaledMoney;
  totalNonTaxable: ScaledMoney;
  /** taxableRegular + taxableSupplementary. */
  totalTaxable: ScaledMoney;
  /** Everything the employee received, taxable or not. */
  grossCompensation: ScaledMoney;
}

const s = (value: string | undefined): ScaledMoney => toScaled(value ?? "0");

export function segregate(input: CompensationInput): SegregatedCompensation {
  const r = input.regular;
  const grossRegular = addAll(
    s(r.basicSalary),
    s(r.representationAllowance),
    s(r.transportationAllowance),
    s(r.costOfLivingAllowance),
    s(r.fixedHousingAllowance),
    s(r.otherTaxableRegular),
  );

  const c = input.mandatoryContributions ?? {};
  const employeeContributions = addAll(s(c.sss), s(c.philHealth), s(c.pagIbig), s(c.unionDues));

  // The netting the BIR calculator pushes onto its user. Clamped because
  // contributions exceeding regular pay would otherwise produce a negative
  // base and a nonsensical bracket selection.
  const taxableRegular = clampAtZero((grossRegular - employeeContributions) as ScaledMoney);

  const sup = input.supplementary ?? {};
  const taxableSupplementary = addAll(
    s(sup.commission),
    s(sup.profitSharing),
    s(sup.directorsFees),
    s(sup.overtimePay),
    s(sup.hazardPay),
    s(sup.taxableThirteenthMonthAndOtherBenefits),
    s(sup.otherTaxableSupplementary),
  );

  const nt = input.nonTaxable ?? {};
  const totalNonTaxable = addAll(
    s(nt.basicSalaryMwe),
    s(nt.holidayPayMwe),
    s(nt.overtimePayMwe),
    s(nt.nightShiftDifferentialMwe),
    s(nt.hazardPayMwe),
    s(nt.thirteenthMonthAndOtherBenefits),
    s(nt.deMinimisBenefits),
    s(nt.nonTaxableRetirementSeparation),
    s(nt.otherExempt),
  );

  const totalTaxable = addAll(taxableRegular, taxableSupplementary);

  // Gross is what the employee actually received: the taxable base plus the
  // contributions withheld from them plus everything exempt.
  const grossCompensation = addAll(totalTaxable, employeeContributions, totalNonTaxable);

  return {
    grossRegular,
    employeeContributions,
    taxableRegular,
    taxableSupplementary,
    totalNonTaxable,
    totalTaxable,
    grossCompensation,
  };
}
