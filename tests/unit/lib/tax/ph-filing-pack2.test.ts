// Program 2 P13 — the pack-2 M cluster's pure pieces:
//   • the ₱90,000 benefits ceiling is applied against YTD headroom, not
//     against each run in isolation;
//   • the QAP reports the rate actually applied (withheld ÷ base), so the
//     WC011 15% band and corrected withholdings cross-foot;
//   • corporate professional fees over ₱720k gross income move to WC011.
import { describe, expect, it } from "vitest";
import { splitBenefitsAgainstCeiling } from "../../../../src/lib/tax/payroll-run-service";
import { toScaled, type ScaledMoney } from "../../../../src/lib/tax/money";
import { issueQapDat } from "../../../../src/lib/tax/issue-qap-dat";
import { assessEwt } from "../../../../src/lib/tax/ewt";

describe("splitBenefitsAgainstCeiling (annual ₱90k, YTD-aware)", () => {
  it("fully non-taxable while under the ceiling", () => {
    const split = splitBenefitsAgainstCeiling("50000", 0n as ScaledMoney);
    expect(split.nonTaxable).toBe("50000");
    expect(split.taxableExcess).toBe("0");
  });

  it("splits the run that crosses the ceiling", () => {
    const split = splitBenefitsAgainstCeiling("50000", toScaled("60000"));
    expect(split.nonTaxable).toBe("30000");
    expect(split.taxableExcess).toBe("20000");
  });

  it("fully taxable once the year is already over the ceiling", () => {
    const split = splitBenefitsAgainstCeiling("10000", toScaled("95000"));
    expect(split.nonTaxable).toBe("0");
    expect(split.taxableExcess).toBe("10000");
  });

  it("single-period figure over the ceiling splits even with zero YTD (the old bug)", () => {
    const split = splitBenefitsAgainstCeiling("120000", 0n as ScaledMoney);
    expect(split.nonTaxable).toBe("90000");
    expect(split.taxableExcess).toBe("30000");
  });
});

describe("QAP .DAT tax rate", () => {
  const base = {
    payorTin: "123456789",
    payorBranchCode: "0000",
    payorRegisteredName: "TEST PAYOR INC",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
  };

  it("reports the IMPLIED rate, not the ATC table rate", () => {
    // 15% actually withheld on an ATC whose table says 10% (WC010's over-720k
    // sibling): the .DAT must say 15.00 or the BIR cross-foot fails.
    const result = issueQapDat({
      ...base,
      payments: [
        {
          payeeTin: "987654321",
          payeeRegisteredName: "SUPPLIER CORP",
          atc: "WC010",
          incomePayment: "100000",
          taxWithheld: "15000.00",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
        } as never,
      ],
    });
    expect(result.content).toContain("15.00");
    expect(result.content).not.toContain(",10.00,");
  });

  it("runs the alphalist preflight over QAP payees", () => {
    const result = issueQapDat({
      ...base,
      payments: [
        {
          payeeTin: "000000000",
          payeeRegisteredName: "VARIOUS",
          atc: "WC010",
          incomePayment: "100000",
          taxWithheld: "10000.00",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
        } as never,
      ],
    });
    expect(result.blockingIssues.join(" ")).toMatch(/TIN|lump/i);
  });
});

describe("assessEwt WC011 (corporate professional fees over ₱720k)", () => {
  const base = {
    isTopWithholdingAgent: false,
    payeeType: "corporate" as const,
    paymentType: "professional_fees",
  };

  it("stays WC010 at or under ₱720k gross income", () => {
    const assessment = assessEwt(base);
    expect(assessment.atc).toBe("WC010");
    expect(assessment.rateBps).toBe(1000);
  });

  it("moves to WC011 (15%) above ₱720k", () => {
    const assessment = assessEwt({ ...base, grossIncomeOver720k: true });
    expect(assessment.atc).toBe("WC011");
    expect(assessment.rateBps).toBe(1500);
  });

  it("the flag does not touch individuals", () => {
    const assessment = assessEwt({
      ...base,
      payeeType: "individual",
      hasSwornDeclaration: true,
      grossIncomeOver720k: true,
    });
    expect(assessment.atc).toBe("WI010");
  });
});
