/**
 * Statutory contributions — SSS, PhilHealth and Pag-IBIG.
 *
 * These matter for TAX because the EMPLOYEE share is deducted from gross
 * compensation before the withholding bracket is selected. A wrong contribution
 * figure therefore mis-states the taxable base, and the error compounds into
 * every downstream figure including the 2316.
 *
 * The employer share is an employer cost. It never reduces the employee's
 * taxable base and never appears in the withholding computation.
 *
 * ── THREE AGENCIES, THREE GENUINELY DIFFERENT SHAPES ─────────────────────────
 * There is no single "contribution rate" abstraction that fits all of these,
 * and forcing one is how the wrong number gets computed:
 *
 *   SSS         BRACKETED. Compensation selects a Monthly Salary Credit from a
 *               61-row table, and contributions are computed on the MSC — not
 *               on actual pay. Employer adds a flat Employees' Compensation
 *               amount on top that the headline 15% excludes.
 *
 *   PhilHealth  RATE with a floor AND a ceiling, on a NARROWER base than the
 *               others: the fixed basic rate only, excluding commission,
 *               overtime, allowances, 13th month and bonuses — and NOT reduced
 *               by undertime, tardiness or absences.
 *
 *   Pag-IBIG    TIERED and ASYMMETRIC. The employee rate steps 1% → 2% at
 *               ₱1,500 while the employer stays flat 2% on BOTH tiers. Encoding
 *               the low tier as 1%/1% is the most common error in the wild.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  applyRateBps,
  clampAtZero,
  minOf,
  toPesoString,
  toScaled,
  type ScaledMoney,
} from "./money";
import { SSS_MSC_BRACKETS } from "./sss-brackets";

export interface ContributionShare {
  employee: ScaledMoney;
  employer: ScaledMoney;
  employeePesos: string;
  employerPesos: string;
}

function share(employee: ScaledMoney, employer: ScaledMoney): ContributionShare {
  return {
    employee,
    employer,
    employeePesos: toPesoString(employee),
    employerPesos: toPesoString(employer),
  };
}

// ─── SSS ─────────────────────────────────────────────────────────────────────

/** SSS Circular No. 2024-006, effective January 2025. */
export const SSS_CITATION = "SSS Circular No. 2024-006 (effective January 2025)";
export const SSS_MSC_FLOOR = "5000";
export const SSS_MSC_CEILING = "35000";
/** Contributions on MSC above this go to the Mandatory Provident Fund instead of Regular SS. */
export const SSS_REGULAR_MSC_CAP = "20000";

export interface SssContribution extends ContributionShare {
  /** The bracketed salary credit the contribution was computed on, not actual pay. */
  monthlySalaryCredit: ScaledMoney;
  /** Employer-only, flat, and NOT part of the 15% headline rate. */
  employeesCompensation: ScaledMoney;
  /** The portion of the MSC in the Regular SS programme — min(MSC, 20,000). */
  regularSsMsc: ScaledMoney;
  /** The portion in the Mandatory Provident Fund — max(0, MSC − 20,000). */
  providentFundMsc: ScaledMoney;
}

/**
 * Select the MSC bracket for a month's compensation.
 *
 * The brackets are [MSC − 250, MSC + 249.99]: the first row catches everything
 * below ₱5,250 and the last everything from ₱34,750 up, so every compensation
 * lands somewhere and the floor and ceiling need no special case.
 */
export function selectSssBracket(compensation: ScaledMoney): (typeof SSS_MSC_BRACKETS)[number] {
  const first = SSS_MSC_BRACKETS[0];
  const last = SSS_MSC_BRACKETS[SSS_MSC_BRACKETS.length - 1];
  for (const bracket of SSS_MSC_BRACKETS) {
    const msc = toScaled(bracket[0]);
    // Upper edge: strictly below MSC + 250. The circular prints the ranges
    // as "... to MSC + 249.99" in centavos, but our amounts carry 8 decimals
    // — a prorated 5,249.995 belongs to THIS bracket, and "<= 249.99"
    // wrongly promoted anything in the (249.99, 250) sliver.
    const upper = (msc + toScaled("250")) as ScaledMoney;
    if (compensation < upper) return bracket;
  }
  return compensation < toScaled(first[0]) ? first : last;
}

export function computeSss(monthlyCompensation: string): SssContribution {
  const compensation = clampAtZero(toScaled(monthlyCompensation));
  const [msc, employerTotal, employeeTotal, ec] = selectSssBracket(compensation);

  const mscScaled = toScaled(msc);
  const regularCap = toScaled(SSS_REGULAR_MSC_CAP);

  return {
    ...share(toScaled(employeeTotal), toScaled(employerTotal)),
    monthlySalaryCredit: mscScaled,
    employeesCompensation: toScaled(ec),
    regularSsMsc: minOf(mscScaled, regularCap),
    providentFundMsc: clampAtZero((mscScaled - regularCap) as ScaledMoney),
  };
}

// ─── PhilHealth ──────────────────────────────────────────────────────────────

export const PHILHEALTH_CITATION =
  "PhilHealth Circular No. 2020-0005 (Revision 1), rate reaffirmed for 2026 by Advisory No. 2026-0042";
export const PHILHEALTH_RATE_BPS = 500; // 5.00%
export const PHILHEALTH_FLOOR = "10000";
export const PHILHEALTH_CEILING = "100000";

/**
 * PhilHealth premium on the MONTHLY BASIC SALARY.
 *
 * The base is narrower than SSS's and is where payroll practice most often goes
 * wrong. Per Circular 2020-0005 §IV(F) it is "the fixed basic rate of an
 * employee which shall not include sales commission, overtime pay, allowances,
 * thirteenth month pay, bonuses or other gratuity payments", and deductions for
 * "under time, tardiness, leave(s) without pay, absences, or other similar
 * circumstances shall also be excluded" — so an employee docked for absences
 * still contributes on the full basic rate.
 *
 * The caller must pass the monthly basic salary, NOT gross compensation. There
 * is deliberately no gross-pay overload: the two are different numbers and a
 * single permissive parameter would let the wrong one through silently.
 */
export function computePhilHealth(monthlyBasicSalary: string): ContributionShare {
  const basic = clampAtZero(toScaled(monthlyBasicSalary));
  const floor = toScaled(PHILHEALTH_FLOOR);
  const ceiling = toScaled(PHILHEALTH_CEILING);

  // Below the floor is charged ON the floor, above the ceiling ON the ceiling.
  const base = basic < floor ? floor : basic > ceiling ? ceiling : basic;
  const total = applyRateBps(base, PHILHEALTH_RATE_BPS);

  // Shared equally. Halving the total rather than applying 2.5% twice keeps the
  // two sides summing to the total on an odd centavo.
  const employee = applyRateBps(total, 5000);
  const employer = (total - employee) as ScaledMoney;
  return share(employee, employer);
}

// ─── Pag-IBIG ────────────────────────────────────────────────────────────────

export const PAGIBIG_CITATION =
  "HDMF Circular No. 460 (Maximum Fund Salary increase effective February 2024)";
/** Fund Salary at or below this takes the 1% employee rate. Inclusive. */
export const PAGIBIG_LOW_TIER_CEILING = "1500";
export const PAGIBIG_MAX_FUND_SALARY = "10000";

/**
 * Pag-IBIG membership savings.
 *
 * Two things are easy to get wrong and both are asserted in the tests:
 *
 *   The low tier is ASYMMETRIC. The employee rate drops to 1% at or below
 *   ₱1,500 while the employer stays at 2%. Circular 460's own table shows 2.0%
 *   on both rows of the employer column.
 *
 *   The boundary is INCLUSIVE. "₱1,500 and below" means an employee at exactly
 *   ₱1,500.00 is in the 1% tier; 2% begins at ₱1,500.01.
 *
 * The cap applies to the BASE, not the result: contributions are computed on
 * min(fundSalary, ₱10,000), so each side tops out at ₱200.
 */
export function computePagIbig(fundSalary: string): ContributionShare {
  const salary = clampAtZero(toScaled(fundSalary));
  const base = minOf(salary, toScaled(PAGIBIG_MAX_FUND_SALARY));

  const inLowTier = salary <= toScaled(PAGIBIG_LOW_TIER_CEILING);
  const employee = applyRateBps(base, inLowTier ? 100 : 200);
  const employer = applyRateBps(base, 200);
  return share(employee, employer);
}

// ─── All three together ──────────────────────────────────────────────────────

export interface StatutoryContributionsInput {
  /** Total monthly compensation, for the SSS bracket lookup. */
  monthlyCompensation: string;
  /** The fixed basic rate, for PhilHealth. Narrower than compensation. */
  monthlyBasicSalary: string;
  /** Fund Salary for Pag-IBIG. Defaults to the basic salary when omitted. */
  fundSalary?: string;
}

export interface StatutoryContributions {
  sss: SssContribution;
  philHealth: ContributionShare;
  pagIbig: ContributionShare;
  /** The sum deducted from gross compensation before the withholding bracket. */
  totalEmployeePesos: string;
  /** Employer cost. Never reduces the employee's taxable base. */
  totalEmployerPesos: string;
}

export function computeStatutoryContributions(
  input: StatutoryContributionsInput,
): StatutoryContributions {
  const sss = computeSss(input.monthlyCompensation);
  const philHealth = computePhilHealth(input.monthlyBasicSalary);
  const pagIbig = computePagIbig(input.fundSalary ?? input.monthlyBasicSalary);

  const totalEmployee = (sss.employee + philHealth.employee + pagIbig.employee) as ScaledMoney;
  const totalEmployer = (sss.employer + philHealth.employer + pagIbig.employer) as ScaledMoney;

  return {
    sss,
    philHealth,
    pagIbig,
    totalEmployeePesos: toPesoString(totalEmployee),
    totalEmployerPesos: toPesoString(totalEmployer),
  };
}
