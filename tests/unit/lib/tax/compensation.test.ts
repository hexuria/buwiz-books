import { describe, it, expect } from "vitest";
import { segregate } from "@/lib/tax/compensation";
import { toPesoString } from "@/lib/tax/money";

describe("segregate — the gross-vs-net trap", () => {
  it("nets the employee's mandatory contributions off gross regular", () => {
    // THE trap. The BIR calculator's Basic Salary box expects an amount ALREADY
    // net of SSS/PhilHealth/Pag-IBIG — its own tooltip says so, and its source
    // subtracts the contributions and adds them straight back, so they never
    // reduce the tax base. Feeding GROSS into that arithmetic over-withholds
    // for every employee. This engine takes gross and does the netting itself.
    const result = segregate({
      regular: { basicSalary: "30000" },
      mandatoryContributions: { sss: "1350", philHealth: "750", pagIbig: "200" },
    });

    expect(toPesoString(result.grossRegular)).toBe("30000.00");
    expect(toPesoString(result.employeeContributions)).toBe("2300.00");
    expect(toPesoString(result.taxableRegular)).toBe("27700.00");
  });

  it("clamps a negative taxable base to zero", () => {
    // Contributions exceeding regular pay would otherwise produce a negative
    // base and a nonsensical bracket selection.
    const result = segregate({
      regular: { basicSalary: "1000" },
      mandatoryContributions: { sss: "5000" },
    });
    expect(toPesoString(result.taxableRegular)).toBe("0.00");
  });

  it("sums every regular component into the bracketing figure", () => {
    const result = segregate({
      regular: {
        basicSalary: "30000",
        representationAllowance: "5000",
        transportationAllowance: "3000",
        costOfLivingAllowance: "2000",
        fixedHousingAllowance: "4000",
        otherTaxableRegular: "1000",
      },
    });
    expect(toPesoString(result.taxableRegular)).toBe("45000.00");
  });

  it("keeps supplementary separate from regular", () => {
    // The separation is the whole point: regular selects the bracket,
    // supplementary joins the excess without moving it.
    const result = segregate({
      regular: { basicSalary: "20000" },
      supplementary: { commission: "5000", overtimePay: "2000" },
    });
    expect(toPesoString(result.taxableRegular)).toBe("20000.00");
    expect(toPesoString(result.taxableSupplementary)).toBe("7000.00");
    expect(toPesoString(result.totalTaxable)).toBe("27000.00");
  });

  it("excludes MWE pay from the taxable base entirely", () => {
    // RR 11-2018 §2.78.1(B)(13): an MWE's statutory minimum wage, holiday,
    // overtime, night-shift differential and qualifying hazard pay stay exempt
    // EVEN WHEN the employee earns other taxable income. Only the additional
    // compensation is withheld upon. The BIR calculator's tooltip says the
    // opposite and is stale.
    const result = segregate({
      regular: { basicSalary: "0" },
      supplementary: { commission: "8000" },
      nonTaxable: {
        basicSalaryMwe: "18000",
        holidayPayMwe: "1200",
        overtimePayMwe: "2400",
        nightShiftDifferentialMwe: "600",
        hazardPayMwe: "1000",
      },
    });

    expect(toPesoString(result.totalNonTaxable)).toBe("23200.00");
    expect(toPesoString(result.taxableRegular)).toBe("0.00");
    // Only the commission is taxable.
    expect(toPesoString(result.totalTaxable)).toBe("8000.00");
  });

  it("counts contributions and exempt pay in gross but not in taxable", () => {
    const result = segregate({
      regular: { basicSalary: "30000" },
      supplementary: { overtimePay: "2000" },
      mandatoryContributions: { sss: "1350", philHealth: "750", pagIbig: "200" },
      nonTaxable: { deMinimisBenefits: "3000", thirteenthMonthAndOtherBenefits: "25000" },
    });

    expect(toPesoString(result.totalTaxable)).toBe("29700.00");
    // 27,700 taxable regular + 2,000 supplementary + 2,300 contributions + 28,000 exempt
    expect(toPesoString(result.grossCompensation)).toBe("60000.00");
  });

  it("treats omitted components as zero rather than NaN", () => {
    const result = segregate({ regular: { basicSalary: "1000" } });
    expect(toPesoString(result.taxableSupplementary)).toBe("0.00");
    expect(toPesoString(result.totalNonTaxable)).toBe("0.00");
    expect(toPesoString(result.employeeContributions)).toBe("0.00");
  });
});
