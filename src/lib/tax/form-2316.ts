/**
 * BIR Form 2316 — Certificate of Compensation Payment / Tax Withheld.
 *
 * One per employee per calendar year, and half of the January deliverable. It
 * is a pure projection: everything on it comes from the year's payroll lines,
 * the employee's tax profile, the employer's tax profile, and any previous
 * employer's 2316. Nothing here reads the general ledger, which is what keeps
 * the January slice off Stage 0's critical path.
 *
 * DEADLINES, which differ by situation and are easy to conflate:
 *   - to the employee, on or before 31 JANUARY of the following year
 *   - the employee-signed duplicate to the BIR by 28 FEBRUARY, for employees
 *     covered by substituted filing
 *   - on SEPARATION, on the day the last compensation is paid — not the
 *     following January
 *
 * The form's own numbering is preserved in the field names below. A bookkeeper
 * checking our output against the printed form should not have to translate.
 */
import { addAll, toPesoString, toScaled, type ScaledMoney } from "./money";

export interface Form2316Employer {
  tin: string;
  branchCode: string;
  registeredName: string;
  address: string;
  /** True when the employer is the one doing the year-end annualization. */
  isMainEmployer: boolean;
}

export interface Form2316Employee {
  tin: string;
  lastName: string;
  firstName: string;
  middleName: string;
  address: string;
  birthDate: string | null;
  dateHired: string | null;
  dateSeparated: string | null;
  isMinimumWageEarner: boolean;
  /** Never inferred from a zero balance — see `substitutedFilingEligible`. */
  substitutedFilingEligible: boolean;
}

/** Year-to-date compensation, already segregated into the three buckets. */
export interface Form2316Compensation {
  // Non-taxable / exempt (Part IV-A)
  basicSalaryMwe: string;
  holidayPayMwe: string;
  overtimePayMwe: string;
  nightShiftDifferentialMwe: string;
  hazardPayMwe: string;
  thirteenthMonthAndOtherBenefits: string;
  deMinimisBenefits: string;
  /** Employee share of SSS, PhilHealth, Pag-IBIG and union dues. */
  mandatoryContributions: string;
  otherNonTaxable: string;

  // Taxable (Part IV-B)
  basicSalary: string;
  representationAllowance: string;
  transportationAllowance: string;
  costOfLivingAllowance: string;
  fixedHousingAllowance: string;
  otherTaxableRegular: string;
  commission: string;
  profitSharing: string;
  directorsFees: string;
  taxableThirteenthMonthAndOtherBenefits: string;
  hazardPay: string;
  overtimePay: string;
  otherTaxableSupplementary: string;
}

export interface Form2316PreviousEmployer {
  tin: string;
  registeredName: string;
  taxableCompensation: string;
  taxWithheld: string;
}

export interface Form2316Input {
  taxableYear: number;
  employer: Form2316Employer;
  employee: Form2316Employee;
  compensation: Form2316Compensation;
  previousEmployer: Form2316PreviousEmployer | null;
  /** Tax withheld by THIS employer for the year, after any annualization true-up. */
  taxWithheldByThisEmployer: string;
  /** The annualized tax due for the year. */
  taxDue: string;
}

export interface Form2316 {
  taxableYear: number;
  employer: Form2316Employer;
  employee: Form2316Employee;
  previousEmployer: Form2316PreviousEmployer | null;

  /** Part IV-A totals. */
  totalNonTaxable: string;
  /** Part IV-B totals, present employer only. */
  totalTaxableRegular: string;
  totalTaxableSupplementary: string;
  totalTaxableFromPresentEmployer: string;
  /** Including any previous employer — the figure the annual tax was computed on. */
  grossTaxableIncome: string;

  taxDue: string;
  taxWithheldByPresentEmployer: string;
  taxWithheldByPreviousEmployer: string;
  totalTaxWithheld: string;

  /** Positive when the employee is owed money, negative when tax is still due. */
  refundOrDeficiency: string;

  /** What the employer must do, and by when. */
  furnishBy: string;
  /** Whether the BIR duplicate is required, and its deadline. */
  birCopyRequired: boolean;
  birCopyDueBy: string | null;

  /** Anything that must be resolved before the certificate can be issued. */
  blockingIssues: string[];
}

const s = (v: string) => toScaled(v);

export function buildForm2316(input: Form2316Input): Form2316 {
  const c = input.compensation;

  const totalNonTaxable = addAll(
    s(c.basicSalaryMwe),
    s(c.holidayPayMwe),
    s(c.overtimePayMwe),
    s(c.nightShiftDifferentialMwe),
    s(c.hazardPayMwe),
    s(c.thirteenthMonthAndOtherBenefits),
    s(c.deMinimisBenefits),
    s(c.mandatoryContributions),
    s(c.otherNonTaxable),
  );

  const totalTaxableRegular = addAll(
    s(c.basicSalary),
    s(c.representationAllowance),
    s(c.transportationAllowance),
    s(c.costOfLivingAllowance),
    s(c.fixedHousingAllowance),
    s(c.otherTaxableRegular),
  );

  const totalTaxableSupplementary = addAll(
    s(c.commission),
    s(c.profitSharing),
    s(c.directorsFees),
    s(c.taxableThirteenthMonthAndOtherBenefits),
    s(c.hazardPay),
    s(c.overtimePay),
    s(c.otherTaxableSupplementary),
  );

  const fromPresent = addAll(totalTaxableRegular, totalTaxableSupplementary);
  const fromPrevious = s(input.previousEmployer?.taxableCompensation ?? "0");
  const grossTaxable = addAll(fromPresent, fromPrevious);

  const withheldPresent = s(input.taxWithheldByThisEmployer);
  const withheldPrevious = s(input.previousEmployer?.taxWithheld ?? "0");
  const totalWithheld = addAll(withheldPresent, withheldPrevious);
  const taxDue = s(input.taxDue);

  // Positive = owed to the employee. The form shows one signed figure rather
  // than two boxes, so the sign carries the meaning.
  const refundOrDeficiency = (totalWithheld - taxDue) as ScaledMoney;

  const separated = input.employee.dateSeparated != null;

  return {
    taxableYear: input.taxableYear,
    employer: input.employer,
    employee: input.employee,
    previousEmployer: input.previousEmployer,

    totalNonTaxable: toPesoString(totalNonTaxable),
    totalTaxableRegular: toPesoString(totalTaxableRegular),
    totalTaxableSupplementary: toPesoString(totalTaxableSupplementary),
    totalTaxableFromPresentEmployer: toPesoString(fromPresent),
    grossTaxableIncome: toPesoString(grossTaxable),

    taxDue: toPesoString(taxDue),
    taxWithheldByPresentEmployer: toPesoString(withheldPresent),
    taxWithheldByPreviousEmployer: toPesoString(withheldPrevious),
    totalTaxWithheld: toPesoString(totalWithheld),
    refundOrDeficiency: toPesoString(refundOrDeficiency),

    // On separation the certificate is due with the last pay, not the following
    // January — the employee needs it to give their next employer.
    furnishBy: separated
      ? "on the day the last compensation is paid"
      : `31 January ${input.taxableYear + 1}`,
    birCopyRequired: input.employee.substitutedFilingEligible,
    birCopyDueBy: input.employee.substitutedFilingEligible
      ? `28 February ${input.taxableYear + 1}`
      : null,

    blockingIssues: findBlockingIssues(input),
  };
}

/**
 * Everything that must be fixed before this certificate can be issued.
 *
 * Returned rather than thrown so one pass tells the bookkeeper the whole list.
 * An issued 2316 is a legal document the employee relies on and may hand to
 * their next employer, so a missing TIN is a defect at issue time, not a
 * problem to discover at alphalist submission.
 */
function findBlockingIssues(input: Form2316Input): string[] {
  const issues: string[] = [];
  const { employee, employer } = input;

  if (!employee.tin) issues.push("employee has no TIN — the alphalist rejects a row without one");
  if (!employee.lastName) issues.push("employee has no surname");
  if (!employer.tin) issues.push("employer has no TIN");
  if (!employer.registeredName) issues.push("employer has no registered name");

  // §2.83.4 disqualifies an employee with two or more employers in the year,
  // "concurrently or successively". Illustration 14's Mr. Joey ends with tax
  // due exactly equal to tax withheld and is still disqualified, so a zero
  // balance proves nothing — the flag must not be inferred.
  if (employee.substitutedFilingEligible && input.previousEmployer != null) {
    issues.push(
      "employee is marked eligible for substituted filing but had a previous employer this year — " +
        "successive employment disqualifies them under §2.83.4",
    );
  }

  if (input.previousEmployer != null && !input.previousEmployer.tin) {
    issues.push("previous employer has no TIN, which the certificate must show");
  }

  if (employee.isMinimumWageEarner && Number(input.compensation.basicSalary) > 0) {
    issues.push(
      "employee is flagged a minimum wage earner but has taxable basic salary — " +
        "the MWE exemption and taxable basic pay are mutually exclusive for the same wage",
    );
  }

  return issues;
}
