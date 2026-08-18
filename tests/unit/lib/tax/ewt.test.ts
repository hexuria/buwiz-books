import { describe, expect, it } from "vitest";
import {
  assessEwt,
  buildQap,
  computeEwt,
  reconcileQuarter,
  remittanceObligationsFor,
} from "@/lib/tax/ewt";

/**
 * The mirror of Stage 3a: here we are the withholding agent.
 *
 * The risk is asymmetric and personal. An agent who fails to withhold is liable
 * for the tax it should have withheld, plus penalties, and the expense becomes
 * non-deductible. So "we could not tell" must never be presented as "nothing to
 * withhold".
 */
describe("assessEwt", () => {
  it("requires withholding on professional fees regardless of agent status", () => {
    // The duty attaches to the payment type, not to who is paying.
    const assessment = assessEwt({
      isTopWithholdingAgent: false,
      payeeType: "corporate",
      paymentType: "professional_fees",
    });
    expect(assessment.required).toBe(true);
    expect(assessment.basis).toBe("payment_type");
    expect(assessment.atc).toBe("WC010");
  });

  it("applies the lower individual rate only with a sworn declaration", () => {
    // A declaration of gross receipts ≤ ₱3M lowers the rate; without it the
    // higher code applies.
    const withDeclaration = assessEwt({
      isTopWithholdingAgent: false,
      payeeType: "individual",
      paymentType: "professional_fees",
      hasSwornDeclaration: true,
    });
    const without = assessEwt({
      isTopWithholdingAgent: false,
      payeeType: "individual",
      paymentType: "professional_fees",
    });
    expect(withDeclaration.atc).toBe("WI010");
    expect(withDeclaration.rateBps).toBe(500);
    expect(without.atc).toBe("WI011");
    expect(without.rateBps).toBe(1000);
  });

  it("does not apply the individual threshold to a corporate payee", () => {
    const corporate = assessEwt({
      isTopWithholdingAgent: false,
      payeeType: "corporate",
      paymentType: "professional_fees",
      hasSwornDeclaration: false,
    });
    expect(corporate.atc).toBe("WC010");
  });

  it("requires withholding on ordinary purchases only while a designated agent", () => {
    // Withholding when not required short-pays the supplier and hands them a
    // certificate for tax we had no duty to deduct.
    const asAgent = assessEwt({
      isTopWithholdingAgent: true,
      payeeType: "corporate",
      paymentType: "goods",
    });
    const notAgent = assessEwt({
      isTopWithholdingAgent: false,
      payeeType: "corporate",
      paymentType: "goods",
    });

    expect(asAgent.required).toBe(true);
    expect(asAgent.basis).toBe("agent_status");
    expect(asAgent.atc).toBe("WC158");
    expect(notAgent.required).toBe(false);
    expect(notAgent.reason).toMatch(/designated top withholding agent/);
  });

  it("distinguishes goods from services for a top withholding agent", () => {
    expect(
      assessEwt({ isTopWithholdingAgent: true, payeeType: "corporate", paymentType: "services" })
        .atc,
    ).toBe("WC160");
  });

  it("says it could not determine the duty rather than answering no", () => {
    // The load-bearing case. Silently returning "not required" for an
    // unrecognised category is how a genuine obligation gets missed, and the
    // penalty falls on us.
    const assessment = assessEwt({
      isTopWithholdingAgent: true,
      payeeType: "corporate",
      paymentType: "consulting_retainer_thing",
    });
    expect(assessment.required).toBe(false);
    expect(assessment.reason).toMatch(/could NOT be determined/);
    expect(assessment.reason).toMatch(/liable for the tax plus penalties/);
  });

  it("gives a reason even when nothing is required", () => {
    // "No withholding" and "we could not tell" must not look alike to a
    // reviewer.
    for (const paymentType of ["goods", "mystery_category"]) {
      const assessment = assessEwt({
        isTopWithholdingAgent: false,
        payeeType: "corporate",
        paymentType,
      });
      expect(assessment.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("computeEwt", () => {
  it("withholds on the amount NET of VAT", () => {
    // Withholding on the VAT-inclusive amount over-withholds; the supplier is
    // short-paid and the certificate overstates what we remitted.
    const result = computeEwt({
      grossAmount: "112000",
      vatAmount: "12000",
      atc: "WC010",
      rateBps: 1000,
    });
    expect(result.taxBase).toBe("100000");
    expect(result.taxWithheld).toBe("10000");
    // The supplier receives the gross less the withholding.
    expect(result.netPayable).toBe("102000");
  });

  it("uses the whole amount when there is no VAT", () => {
    const result = computeEwt({ grossAmount: "50000", atc: "WC120", rateBps: 200 });
    expect(result.taxBase).toBe("50000");
    expect(result.taxWithheld).toBe("1000");
    expect(result.netPayable).toBe("49000");
  });

  it("rounds once, at the end", () => {
    const result = computeEwt({ grossAmount: "33333.33", atc: "WC120", rateBps: 200 });
    expect(result.taxWithheld).toBe("666.67");
  });

  it("refuses a VAT amount larger than the payment", () => {
    expect(() =>
      computeEwt({ grossAmount: "100", vatAmount: "200", atc: "WC010", rateBps: 1000 }),
    ).toThrow(/would be negative/);
  });
});

describe("remittanceObligationsFor", () => {
  it("puts months 1 and 2 of a quarter on 0619-E", () => {
    for (const month of [1, 2, 4, 5, 7, 8, 10, 11]) {
      const obligations = remittanceObligationsFor(month, 2026);
      expect(obligations).toHaveLength(1);
      expect(obligations[0].formCode).toBe("0619E");
    }
  });

  it("puts the third month on 1601-EQ and issues NO 0619-E", () => {
    // Filing a 0619-E for the third month double-remits.
    for (const month of [3, 6, 9, 12]) {
      const obligations = remittanceObligationsFor(month, 2026);
      expect(obligations).toHaveLength(1);
      expect(obligations[0].formCode).toBe("1601EQ");
    }
  });

  it("covers the WHOLE quarter on the quarterly return, not just the third month", () => {
    // Filing only the third month's figure under-reports by two thirds.
    const q2 = remittanceObligationsFor(6, 2026)[0];
    expect(q2.periodStart).toBe("2026-04-01");
    expect(q2.periodEnd).toBe("2026-06-30");
  });

  it("dues 0619-E on the 10th of the following month", () => {
    expect(remittanceObligationsFor(4, 2026)[0].dueDate).toBe("2026-05-10");
  });

  it("dues 1601-EQ on the last day of the month following the quarter", () => {
    expect(remittanceObligationsFor(3, 2026)[0].dueDate).toBe("2026-04-30");
    expect(remittanceObligationsFor(6, 2026)[0].dueDate).toBe("2026-07-31");
  });

  it("rolls the year over for the December quarter", () => {
    const q4 = remittanceObligationsFor(12, 2026)[0];
    expect(q4.periodStart).toBe("2026-10-01");
    expect(q4.dueDate).toBe("2027-01-31");
  });

  it("rejects an impossible month", () => {
    expect(() => remittanceObligationsFor(0, 2026)).toThrow(/Invalid month/);
    expect(() => remittanceObligationsFor(13, 2026)).toThrow(/Invalid month/);
  });
});

describe("buildQap", () => {
  const payment = (over: Partial<Parameters<typeof buildQap>[0]["payments"][number]> = {}) => ({
    payeeTin: "123456789000",
    payeeRegisteredName: "SUPPLIER INC",
    atc: "WC158",
    incomePayment: "100000",
    taxWithheld: "1000",
    certificateIssued: true,
    ...over,
  });

  it("groups by payee AND ATC", () => {
    const qap = buildQap({
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      payments: [payment(), payment({ atc: "WC160", taxWithheld: "2000" })],
    });
    expect(qap.lines).toHaveLength(2);
  });

  it("merges repeat payments to one payee under one ATC", () => {
    const qap = buildQap({
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      payments: [payment(), payment()],
    });
    expect(qap.lines).toHaveLength(1);
    expect(qap.lines[0].incomePayment).toBe("200000");
    expect(qap.lines[0].paymentCount).toBe(2);
  });

  it("blocks when we have not issued a payee their certificate", () => {
    // Our obligation. Without it the payee cannot claim credit for tax we
    // already deducted from them.
    const qap = buildQap({
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      payments: [payment(), payment({ certificateIssued: false })],
    });
    expect(qap.certificatesNotIssued).toBe(1);
    expect(qap.blockingIssues.join(" ")).toMatch(/cannot claim the credit/);
  });

  it("orders rows deterministically", () => {
    const payments = [payment({ payeeTin: "999999999000" }), payment({ payeeTin: "111111111000" })];
    const a = buildQap({ periodStart: "x", periodEnd: "y", payments });
    const b = buildQap({ periodStart: "x", periodEnd: "y", payments: [...payments].reverse() });
    expect(a.lines.map((l) => l.payeeTin)).toEqual(b.lines.map((l) => l.payeeTin));
  });

  it("flags an empty quarter as needing deliberate confirmation", () => {
    const qap = buildQap({ periodStart: "x", periodEnd: "y", payments: [] });
    expect(qap.blockingIssues.join(" ")).toMatch(/nil QAP should be deliberate/);
  });
});

describe("reconcileQuarter", () => {
  it("credits the two monthly remittances against the quarter", () => {
    const result = reconcileQuarter({
      quarterWithheld: "30000",
      remittedMonth1: "10000",
      remittedMonth2: "12000",
    });
    expect(result.stillDue).toBe("8000");
    expect(result.reconciled).toBe(true);
  });

  it("flags remittances that exceed the quarter's withholding", () => {
    // Either a month was over-remitted or a payment is missing from the
    // quarter — both need explaining before the return is filed.
    const result = reconcileQuarter({
      quarterWithheld: "10000",
      remittedMonth1: "8000",
      remittedMonth2: "8000",
    });
    expect(result.reconciled).toBe(false);
    expect(result.issues.join(" ")).toMatch(/exceed the quarter's withholding/);
  });

  it("handles a quarter with nothing remitted yet", () => {
    const result = reconcileQuarter({
      quarterWithheld: "5000",
      remittedMonth1: "0",
      remittedMonth2: "0",
    });
    expect(result.stillDue).toBe("5000");
  });

  it("keeps sub-centavo precision", () => {
    const result = reconcileQuarter({
      quarterWithheld: "0.00000003",
      remittedMonth1: "0.00000001",
      remittedMonth2: "0",
    });
    expect(result.stillDue).toBe("0.00000002");
  });
});
