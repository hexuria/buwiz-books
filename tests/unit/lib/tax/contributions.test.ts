import { describe, it, expect } from "vitest";
import {
  computePagIbig,
  computePhilHealth,
  computeSss,
  computeStatutoryContributions,
  selectSssBracket,
  PAGIBIG_LOW_TIER_CEILING,
} from "@/lib/tax/contributions";
import { toPesoString, toScaled } from "@/lib/tax/money";
import { SSS_MSC_BRACKETS } from "@/lib/tax/sss-brackets";

describe("SSS bracket table (Circular 2024-006)", () => {
  it("has 61 rows spanning ₱5,000 to ₱35,000 in ₱500 steps", () => {
    expect(SSS_MSC_BRACKETS).toHaveLength(61);
    expect(SSS_MSC_BRACKETS[0][0]).toBe("5000.00");
    expect(SSS_MSC_BRACKETS.at(-1)![0]).toBe("35000.00");
    const steps = new Set(
      SSS_MSC_BRACKETS.slice(1).map((b, i) => Number(b[0]) - Number(SSS_MSC_BRACKETS[i][0])),
    );
    expect([...steps]).toEqual([500]);
  });

  it("re-derives every row from the circular's own arithmetic", () => {
    // The table was read visually off a scanned PDF with no text layer, so this
    // is the check that a transcription slip fails the build rather than
    // quietly mis-deducting someone's pay. Employer = 10% of MSC PLUS the flat
    // EC; employee = 5% of MSC with no EC.
    const wrong: string[] = [];
    for (const [msc, employer, employee, ec] of SSS_MSC_BRACKETS) {
      const m = Number(msc);
      if (Math.abs(Number(employer) - (m * 0.1 + Number(ec))) > 0.005) {
        wrong.push(`MSC ${msc}: employer ${employer}`);
      }
      if (Math.abs(Number(employee) - m * 0.05) > 0.005) {
        wrong.push(`MSC ${msc}: employee ${employee}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("steps the employer-only EC from ₱10 to ₱30 at MSC 15,000", () => {
    // EC is a flat peso amount, never a percentage, and the 15% headline rate
    // excludes it — it sits on top of the employer's 10%.
    for (const [msc, , , ec] of SSS_MSC_BRACKETS) {
      expect(ec, `MSC ${msc}`).toBe(Number(msc) <= 14500 ? "10.00" : "30.00");
    }
  });
});

describe("computeSss", () => {
  it("computes on the salary CREDIT, not on actual pay", () => {
    // Everything from ₱14,750 to ₱15,249.99 maps to MSC 15,000 and therefore to
    // an identical contribution.
    for (const pay of ["14750", "15000", "15249.99"]) {
      const result = computeSss(pay);
      expect(toPesoString(result.monthlySalaryCredit), pay).toBe("15000.00");
      expect(result.employeePesos, pay).toBe("750.00");
      expect(result.employerPesos, pay).toBe("1530.00");
    }
  });

  it("catches everything below the first bracket on the floor", () => {
    const result = computeSss("3000");
    expect(toPesoString(result.monthlySalaryCredit)).toBe("5000.00");
    expect(result.employeePesos).toBe("250.00");
  });

  it("caps at the ceiling", () => {
    // The circular's own checksum row: employer ₱3,530.00, employee ₱1,750.00.
    const result = computeSss("500000");
    expect(toPesoString(result.monthlySalaryCredit)).toBe("35000.00");
    expect(result.employerPesos).toBe("3530.00");
    expect(result.employeePesos).toBe("1750.00");
  });

  it("splits the MSC between Regular SS and the provident fund at ₱20,000", () => {
    const below = computeSss("18000");
    expect(toPesoString(below.regularSsMsc)).toBe("18000.00");
    expect(toPesoString(below.providentFundMsc)).toBe("0.00");

    const above = computeSss("30000");
    expect(toPesoString(above.regularSsMsc)).toBe("20000.00");
    expect(toPesoString(above.providentFundMsc)).toBe("10000.00");
  });

  it("selects a bracket for every compensation, with no gap between rows", () => {
    // The bracket edges are MSC ± 250 / 249.99, so a value landing between two
    // rows would be a real defect rather than a rounding curiosity.
    for (let pay = 0; pay <= 40000; pay += 137) {
      expect(() => selectSssBracket(toScaled(String(pay))), `pay ${pay}`).not.toThrow();
    }
  });
});

describe("computePhilHealth", () => {
  it("charges 5% split equally", () => {
    const result = computePhilHealth("40000");
    expect(result.employeePesos).toBe("1000.00");
    expect(result.employerPesos).toBe("1000.00");
  });

  it("charges a salary below the floor ON the floor", () => {
    const result = computePhilHealth("8000");
    // 5% of 10,000, not of 8,000.
    expect(result.employeePesos).toBe("250.00");
    expect(result.employerPesos).toBe("250.00");
  });

  it("charges a salary above the ceiling ON the ceiling", () => {
    const result = computePhilHealth("250000");
    // 5% of 100,000 = 5,000, split.
    expect(result.employeePesos).toBe("2500.00");
    expect(result.employerPesos).toBe("2500.00");
  });

  it("keeps the two shares summing to the total on an odd centavo", () => {
    // 5% of 30,001 = 1,500.05, which does not halve evenly. Applying 2.5%
    // twice would round both up and overstate the total by a centavo.
    const result = computePhilHealth("30001");
    const sum = Number(result.employeePesos) + Number(result.employerPesos);
    expect(sum).toBeCloseTo(1500.05, 2);
  });
});

describe("computePagIbig", () => {
  it("uses the asymmetric low tier: 1% employee, 2% employer", () => {
    // The row most often mis-encoded. Circular 460's table shows 2.0% on BOTH
    // rows of the employer column — only the employee rate steps down.
    const result = computePagIbig("1000");
    expect(result.employeePesos).toBe("10.00");
    expect(result.employerPesos).toBe("20.00");
  });

  it("treats the ₱1,500 boundary as inclusive", () => {
    // "₱1,500 and below" — so exactly ₱1,500 is still the 1% tier, and 2%
    // begins one centavo above.
    const atBoundary = computePagIbig(PAGIBIG_LOW_TIER_CEILING);
    expect(atBoundary.employeePesos).toBe("15.00");
    expect(atBoundary.employerPesos).toBe("30.00");

    const justAbove = computePagIbig("1500.01");
    expect(justAbove.employeePesos).toBe("30.00");
  });

  it("charges 2% on both sides above the boundary", () => {
    const result = computePagIbig("5000");
    expect(result.employeePesos).toBe("100.00");
    expect(result.employerPesos).toBe("100.00");
  });

  it("caps the BASE at the maximum fund salary, not the result", () => {
    const atCap = computePagIbig("10000");
    const aboveCap = computePagIbig("80000");
    expect(atCap.employeePesos).toBe("200.00");
    expect(aboveCap.employeePesos).toBe("200.00");
    expect(aboveCap.employerPesos).toBe("200.00");
  });
});

describe("computeStatutoryContributions", () => {
  it("totals the three agencies on each side", () => {
    const result = computeStatutoryContributions({
      monthlyCompensation: "30000",
      monthlyBasicSalary: "30000",
    });
    // SSS employee 1,500.00 + PhilHealth 750.00 + Pag-IBIG 200.00
    expect(result.totalEmployeePesos).toBe("2450.00");
    // SSS employer 3,030.00 + PhilHealth 750.00 + Pag-IBIG 200.00
    expect(result.totalEmployerPesos).toBe("3980.00");
  });

  it("uses the narrower basic-salary base for PhilHealth", () => {
    // An employee on ₱25,000 basic plus ₱10,000 of commission and overtime
    // contributes to SSS on the higher compensation but to PhilHealth on the
    // basic rate alone. Passing gross to both would overstate PhilHealth.
    const result = computeStatutoryContributions({
      monthlyCompensation: "35000",
      monthlyBasicSalary: "25000",
    });
    expect(result.philHealth.employeePesos).toBe("625.00"); // 2.5% of 25,000
    expect(toPesoString(result.sss.monthlySalaryCredit)).toBe("35000.00");
  });

  it("defaults the Pag-IBIG fund salary to the basic salary", () => {
    const result = computeStatutoryContributions({
      monthlyCompensation: "30000",
      monthlyBasicSalary: "8000",
    });
    expect(result.pagIbig.employeePesos).toBe("160.00"); // 2% of 8,000
  });
});
