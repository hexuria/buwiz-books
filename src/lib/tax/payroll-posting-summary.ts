/**
 * Pure payroll-posting arithmetic.
 *
 * Kept out of payroll-journal.ts so unit tests can load it without pulling
 * the database client (and DATABASE_URL) into the hermetic unit project.
 */
import { addAll, clampAtZero, fromScaled, toScaled, ZERO, type ScaledMoney } from "./money";

export interface PayrollPostingLine {
  basicSalary: string | null;
  representationAllowance: string | null;
  transportationAllowance: string | null;
  costOfLivingAllowance: string | null;
  fixedHousingAllowance: string | null;
  otherTaxableRegular: string | null;
  commission: string | null;
  profitSharing: string | null;
  directorsFees: string | null;
  overtimePay: string | null;
  hazardPay: string | null;
  otherTaxableSupplementary: string | null;
  basicSalaryMwe: string | null;
  holidayPayMwe: string | null;
  overtimePayMwe: string | null;
  nightShiftDifferentialMwe: string | null;
  hazardPayMwe: string | null;
  thirteenthMonthAndOtherBenefits: string | null;
  deMinimisBenefits: string | null;
  nonTaxableRetirementSeparation: string | null;
  otherExempt: string | null;
  sssEmployeeShare: string | null;
  philHealthEmployeeShare: string | null;
  pagIbigEmployeeShare: string | null;
  unionDues: string | null;
  reportedTaxWithheld: string | null;
  computedTaxWithheld: string | null;
  expectedSssEmployerShare: string | null;
  expectedPhilHealthEmployerShare: string | null;
  expectedPagIbigEmployerShare: string | null;
}

function sumField(
  lines: ReadonlyArray<PayrollPostingLine>,
  pick: (line: PayrollPostingLine) => string | null,
): ScaledMoney {
  return lines.reduce<ScaledMoney>(
    (total, line) => addAll(total, toScaled(pick(line) ?? "0")),
    ZERO,
  );
}

export interface PayrollPostingTotals {
  grossCompensation: string;
  taxWithheld: string;
  sssEmployee: string;
  sssEmployer: string;
  philHealthEmployee: string;
  philHealthEmployer: string;
  pagIbigEmployee: string;
  pagIbigEmployer: string;
  unionDues: string;
  netPay: string;
  employerContributionExpense: string;
}

const GROSS_FIELDS: Array<(l: PayrollPostingLine) => string | null> = [
  (l) => l.basicSalary,
  (l) => l.representationAllowance,
  (l) => l.transportationAllowance,
  (l) => l.costOfLivingAllowance,
  (l) => l.fixedHousingAllowance,
  (l) => l.otherTaxableRegular,
  (l) => l.commission,
  (l) => l.profitSharing,
  (l) => l.directorsFees,
  (l) => l.overtimePay,
  (l) => l.hazardPay,
  (l) => l.otherTaxableSupplementary,
  (l) => l.basicSalaryMwe,
  (l) => l.holidayPayMwe,
  (l) => l.overtimePayMwe,
  (l) => l.nightShiftDifferentialMwe,
  (l) => l.hazardPayMwe,
  (l) => l.thirteenthMonthAndOtherBenefits,
  (l) => l.deMinimisBenefits,
  (l) => l.nonTaxableRetirementSeparation,
  // otherExempt exists on payroll_lines and feeds the engine, the 1601-C and
  // the 2316; omitting it here left the salaries debit and the Net Pay
  // Payable credit short by exactly that amount — the journal still balanced,
  // so nothing caught the ledger disagreeing with the payslip.
  (l) => l.otherExempt,
];

export function summarizePayrollPosting(lines: ReadonlyArray<PayrollPostingLine>): {
  totals: PayrollPostingTotals;
} {
  const grossCompensation = GROSS_FIELDS.reduce<ScaledMoney>(
    (total, pick) => addAll(total, sumField(lines, pick)),
    ZERO,
  );

  const taxWithheld = sumField(lines, (l) => l.reportedTaxWithheld ?? l.computedTaxWithheld);
  const sssEmployee = sumField(lines, (l) => l.sssEmployeeShare);
  const philHealthEmployee = sumField(lines, (l) => l.philHealthEmployeeShare);
  const pagIbigEmployee = sumField(lines, (l) => l.pagIbigEmployeeShare);
  const unionDues = sumField(lines, (l) => l.unionDues);
  const sssEmployer = sumField(lines, (l) => l.expectedSssEmployerShare);
  const philHealthEmployer = sumField(lines, (l) => l.expectedPhilHealthEmployerShare);
  const pagIbigEmployer = sumField(lines, (l) => l.expectedPagIbigEmployerShare);

  let netPay = ZERO;
  for (const line of lines) {
    const lineGross = GROSS_FIELDS.reduce<ScaledMoney>(
      (total, pick) => addAll(total, toScaled(pick(line) ?? "0")),
      ZERO,
    );
    const deductions = [
      line.sssEmployeeShare,
      line.philHealthEmployeeShare,
      line.pagIbigEmployeeShare,
      line.unionDues,
      line.reportedTaxWithheld ?? line.computedTaxWithheld,
    ].reduce<ScaledMoney>((total, v) => addAll(total, toScaled(v ?? "0")), ZERO);
    const lineNet = (lineGross - deductions) as ScaledMoney;
    if (lineNet < 0n) {
      // Clamping one side while crediting the full deductions produced a
      // journal whose credits exceeded its debits — which then aborted the
      // WHOLE posting at COMMIT as an opaque 0041 violation. A deficiency
      // larger than final pay is a real payroll condition that needs a human
      // decision (collect, absorb, or stagger), so fail with a message.
      throw new Error(
        `Deductions exceed gross pay by ${fromScaled(-lineNet as ScaledMoney)} for one employee — resolve the shortfall (collect, absorb, or stagger) before posting.`,
      );
    }
    netPay = addAll(netPay, lineNet);
  }

  const employerContributionExpense = addAll(sssEmployer, philHealthEmployer, pagIbigEmployer);

  return {
    totals: {
      grossCompensation: fromScaled(grossCompensation),
      taxWithheld: fromScaled(taxWithheld),
      sssEmployee: fromScaled(sssEmployee),
      sssEmployer: fromScaled(sssEmployer),
      philHealthEmployee: fromScaled(philHealthEmployee),
      philHealthEmployer: fromScaled(philHealthEmployer),
      pagIbigEmployee: fromScaled(pagIbigEmployee),
      pagIbigEmployer: fromScaled(pagIbigEmployer),
      unionDues: fromScaled(unionDues),
      netPay: fromScaled(netPay),
      employerContributionExpense: fromScaled(employerContributionExpense),
    },
  };
}
