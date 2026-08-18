import { describe, it, expect } from "vitest";
import { buildForm2316, type Form2316Input } from "@/lib/tax/form-2316";

const ZERO_COMPENSATION = {
  basicSalaryMwe: "0",
  holidayPayMwe: "0",
  overtimePayMwe: "0",
  nightShiftDifferentialMwe: "0",
  hazardPayMwe: "0",
  thirteenthMonthAndOtherBenefits: "0",
  deMinimisBenefits: "0",
  mandatoryContributions: "0",
  otherNonTaxable: "0",
  basicSalary: "0",
  representationAllowance: "0",
  transportationAllowance: "0",
  costOfLivingAllowance: "0",
  fixedHousingAllowance: "0",
  otherTaxableRegular: "0",
  commission: "0",
  profitSharing: "0",
  directorsFees: "0",
  taxableThirteenthMonthAndOtherBenefits: "0",
  hazardPay: "0",
  overtimePay: "0",
  otherTaxableSupplementary: "0",
};

function input(overrides: Partial<Form2316Input> = {}): Form2316Input {
  return {
    taxableYear: 2018,
    employer: {
      tin: "123456789",
      branchCode: "00000",
      registeredName: "EBQ COMPANY",
      address: "Makati City",
      isMainEmployer: true,
    },
    employee: {
      tin: "987654321",
      lastName: "GRACE",
      firstName: "MARIA",
      middleName: "S",
      address: "Quezon City",
      birthDate: "1990-01-01",
      dateHired: "2015-06-01",
      dateSeparated: null,
      isMinimumWageEarner: false,
      substitutedFilingEligible: true,
    },
    compensation: { ...ZERO_COMPENSATION },
    previousEmployer: null,
    taxWithheldByThisEmployer: "0",
    taxDue: "0",
    ...overrides,
  };
}

describe("buildForm2316 — Illustration 15 case 1 (Ms. Grace)", () => {
  const form = buildForm2316(
    input({
      compensation: {
        ...ZERO_COMPENSATION,
        basicSalary: "600000",
        overtimePay: "10000",
        thirteenthMonthAndOtherBenefits: "60000",
      },
      taxWithheldByThisEmployer: "82500",
      taxDue: "82500",
    }),
  );

  it("totals the taxable buckets the way the RR does", () => {
    expect(form.totalTaxableRegular).toBe("600000.00");
    expect(form.totalTaxableSupplementary).toBe("10000.00"); // overtime is supplementary
    expect(form.grossTaxableIncome).toBe("610000.00");
  });

  it("keeps the ₱90,000-exempt benefits out of the taxable total", () => {
    expect(form.totalNonTaxable).toBe("60000.00");
  });

  it("balances to zero once the December deficiency is withheld", () => {
    expect(form.taxDue).toBe("82500.00");
    expect(form.totalTaxWithheld).toBe("82500.00");
    expect(form.refundOrDeficiency).toBe("0.00");
  });
});

describe("buildForm2316 — Illustration 15 case 2 (Mr. Gerry)", () => {
  const form = buildForm2316(
    input({
      employee: { ...input().employee, dateHired: "2018-07-01", substitutedFilingEligible: false },
      compensation: {
        ...ZERO_COMPENSATION,
        basicSalary: "150000",
        thirteenthMonthAndOtherBenefits: "30000",
      },
      previousEmployer: {
        tin: "111111111",
        registeredName: "PRIOR CORP",
        taxableCompensation: "125000",
        taxWithheld: "4167.00",
      },
      taxWithheldByThisEmployer: "4167.00",
      taxDue: "5000",
    }),
  );

  it("adds the previous employer's compensation into gross taxable income", () => {
    expect(form.totalTaxableFromPresentEmployer).toBe("150000.00");
    expect(form.grossTaxableIncome).toBe("275000.00");
  });

  it("credits both employers' withholding and shows the refund", () => {
    expect(form.totalTaxWithheld).toBe("8334.00");
    // Positive means owed to the employee.
    expect(form.refundOrDeficiency).toBe("3334.00");
  });
});

describe("buildForm2316 — deadlines", () => {
  it("is due the following 31 January for a continuing employee", () => {
    const form = buildForm2316(input());
    expect(form.furnishBy).toBe("31 January 2019");
  });

  it("is due at the last pay on separation, not the following January", () => {
    // The employee needs it to hand to their next employer, so waiting until
    // January would defeat its purpose.
    const form = buildForm2316(
      input({ employee: { ...input().employee, dateSeparated: "2018-06-30" } }),
    );
    expect(form.furnishBy).toBe("on the day the last compensation is paid");
  });

  it("requires the BIR duplicate by 28 February only under substituted filing", () => {
    const eligible = buildForm2316(input());
    expect(eligible.birCopyRequired).toBe(true);
    expect(eligible.birCopyDueBy).toBe("28 February 2019");

    const notEligible = buildForm2316(
      input({ employee: { ...input().employee, substitutedFilingEligible: false } }),
    );
    expect(notEligible.birCopyRequired).toBe(false);
    expect(notEligible.birCopyDueBy).toBeNull();
  });
});

describe("buildForm2316 — blocking issues", () => {
  it("issues cleanly when everything is present", () => {
    expect(buildForm2316(input()).blockingIssues).toEqual([]);
  });

  it("blocks on a missing employee TIN", () => {
    // An alphalist row without a TIN is rejected, and RMC 5-2014 bans dummy
    // TINs — so this must surface at issue time, not at submission.
    const form = buildForm2316(input({ employee: { ...input().employee, tin: "" } }));
    expect(form.blockingIssues.join(" ")).toMatch(/employee has no TIN/);
  });

  it("catches substituted filing claimed alongside a previous employer", () => {
    // §2.83.4 disqualifies successive employment. Illustration 14's Mr. Joey
    // ends with tax due exactly equal to tax withheld and is STILL
    // disqualified, so a zero balance proves nothing — the flag cannot be
    // inferred from the arithmetic.
    const form = buildForm2316(
      input({
        previousEmployer: {
          tin: "111111111",
          registeredName: "PRIOR CORP",
          taxableCompensation: "100000",
          taxWithheld: "5000",
        },
      }),
    );
    expect(form.blockingIssues.join(" ")).toMatch(/successive employment disqualifies/);
  });

  it("catches an MWE flag alongside taxable basic salary", () => {
    const form = buildForm2316(
      input({
        employee: { ...input().employee, isMinimumWageEarner: true },
        compensation: { ...ZERO_COMPENSATION, basicSalary: "600000" },
      }),
    );
    expect(form.blockingIssues.join(" ")).toMatch(/mutually exclusive/);
  });

  it("reports every issue in one pass", () => {
    const form = buildForm2316(
      input({
        employee: { ...input().employee, tin: "", lastName: "" },
        employer: { ...input().employer, tin: "" },
      }),
    );
    expect(form.blockingIssues.length).toBeGreaterThanOrEqual(3);
  });
});
