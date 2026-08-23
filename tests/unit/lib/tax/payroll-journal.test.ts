import { describe, expect, it } from "vitest";
import { summarizePayrollPosting } from "@/lib/tax/payroll-posting-summary";

/**
 * The arithmetic of the payroll entry, tested without a database.
 *
 * The defect this guards is not a crash. Booking the EMPLOYEE's statutory share
 * as an expense overstates payroll cost by roughly the employee contribution
 * every period — and the entry still balances, so nothing downstream notices.
 */
type Line = Parameters<typeof summarizePayrollPosting>[0][number];

function line(overrides: Partial<Line> = {}): Line {
  return {
    employeePartyId: crypto.randomUUID(),
    basicSalary: "30000",
    representationAllowance: null,
    transportationAllowance: null,
    costOfLivingAllowance: null,
    fixedHousingAllowance: null,
    otherTaxableRegular: null,
    commission: null,
    profitSharing: null,
    directorsFees: null,
    overtimePay: null,
    hazardPay: null,
    otherTaxableSupplementary: null,
    basicSalaryMwe: null,
    holidayPayMwe: null,
    overtimePayMwe: null,
    nightShiftDifferentialMwe: null,
    hazardPayMwe: null,
    thirteenthMonthAndOtherBenefits: null,
    deMinimisBenefits: null,
    nonTaxableRetirementSeparation: null,
    sssEmployeeShare: "1350",
    philHealthEmployeeShare: "750",
    pagIbigEmployeeShare: "600",
    unionDues: null,
    reportedTaxWithheld: "1500",
    computedTaxWithheld: "1500",
    expectedSssEmployerShare: "2880",
    expectedPhilHealthEmployerShare: "750",
    expectedPagIbigEmployerShare: "600",
    varianceAmount: "0",
    ...overrides,
  } as Line;
}

describe("summarizePayrollPosting", () => {
  it("balances: debits equal credits", () => {
    const { totals } = summarizePayrollPosting([line(), line()]);
    const debits = Number(totals.grossCompensation) + Number(totals.employerContributionExpense);
    const credits =
      Number(totals.taxWithheld) +
      Number(totals.sssEmployee) +
      Number(totals.sssEmployer) +
      Number(totals.philHealthEmployee) +
      Number(totals.philHealthEmployer) +
      Number(totals.pagIbigEmployee) +
      Number(totals.pagIbigEmployer) +
      Number(totals.unionDues) +
      Number(totals.netPay);
    expect(debits).toBe(credits);
  });

  it("expenses ONLY the employer share, never the employee's", () => {
    // The employee's share is already inside gross compensation and is merely
    // withheld from it. Expensing it too would double-count that cost, and the
    // entry would still balance.
    const { totals } = summarizePayrollPosting([line()]);
    expect(totals.employerContributionExpense).toBe("4230"); // 2880 + 750 + 600
    expect(totals.grossCompensation).toBe("30000");
  });

  it("derives net pay as gross less deductions", () => {
    // 30000 − (1350 + 750 + 600 + 1500) = 25800
    expect(summarizePayrollPosting([line()]).totals.netPay).toBe("25800");
  });

  it("credits each payable with BOTH shares", () => {
    // The employer remits both halves, so the liability carries both.
    const { totals } = summarizePayrollPosting([line()]);
    expect(Number(totals.sssEmployee) + Number(totals.sssEmployer)).toBe(4230);
  });

  it("counts non-taxable pay as compensation cost", () => {
    // Exempt from WITHHOLDING is not the same as absent from payroll expense —
    // de minimis benefits and MWE pay still cost the employer.
    const { totals } = summarizePayrollPosting([
      line({ deMinimisBenefits: "2000", basicSalaryMwe: "5000" }),
    ]);
    expect(totals.grossCompensation).toBe("37000");
    // ...and they raise net pay rather than tax.
    expect(totals.netPay).toBe("32800");
  });

  it("posts the REPORTED tax, not the computed one", () => {
    // The ledger records what was actually withheld from the payslip. Posting
    // the engine's figure instead would make the books disagree with what the
    // employees were handed.
    const { totals } = summarizePayrollPosting([
      line({ reportedTaxWithheld: "1200", computedTaxWithheld: "1500" }),
    ]);
    expect(totals.taxWithheld).toBe("1200");
  });

  it("falls back to the computed figure when the register reported none", () => {
    const { totals } = summarizePayrollPosting([
      line({ reportedTaxWithheld: null, computedTaxWithheld: "1500" }),
    ]);
    expect(totals.taxWithheld).toBe("1500");
  });

  it("takes the employer share from the schedule, not the register", () => {
    // The employer share is never withheld from anyone, so a register has no
    // independent source for it.
    const { totals } = summarizePayrollPosting([
      line({ expectedSssEmployerShare: "2880", sssEmployeeShare: "1350" }),
    ]);
    expect(totals.sssEmployer).toBe("2880");
    expect(totals.sssEmployee).toBe("1350");
  });

  it("refuses a line whose deductions exceed gross pay", () => {
    // Deductions exceeding gross is a data error. Clamping net at zero while
    // crediting the full deductions produced a journal whose credits exceeded
    // its debits — which then aborted the whole posting at COMMIT as an
    // opaque constraint violation. It now fails loudly with the shortfall.
    expect(() =>
      summarizePayrollPosting([
        line({ basicSalary: "1000", sssEmployeeShare: "5000", reportedTaxWithheld: "0" }),
      ]),
    ).toThrow(/Deductions exceed gross pay/);
  });

  it("includes union dues in deductions and as its own payable", () => {
    const { totals } = summarizePayrollPosting([line({ unionDues: "200" })]);
    expect(totals.unionDues).toBe("200");
    expect(totals.netPay).toBe("25600");
  });

  it("sums many employees exactly", () => {
    const { totals } = summarizePayrollPosting(Array.from({ length: 50 }, () => line()));
    expect(totals.grossCompensation).toBe("1500000");
    expect(totals.netPay).toBe("1290000");
  });

  it("handles an empty run without inventing figures", () => {
    const { totals } = summarizePayrollPosting([]);
    expect(totals.grossCompensation).toBe("0");
    expect(totals.netPay).toBe("0");
  });
});
