import { describe, expect, it } from "vitest";
import {
  addVat,
  assessInputVat,
  buildSlspSection,
  buildVatReturn,
  computeUncollectedDeduction,
  extractVat,
} from "@/lib/tax/vat";

/**
 * The VAT arithmetic is trivial. Everything hard here is timing and
 * eligibility — and EOPT moved the timing for services from collection to
 * billing, which is the change most likely to be missed.
 */
describe("extractVat", () => {
  it("extracts VAT from an inclusive amount rather than adding to it", () => {
    // The common error: 12% OF the gross instead of dividing by 1.12.
    // 1,120 inclusive is 1,000 + 120, not 1,120 + 134.40.
    const split = extractVat("1120");
    expect(split.netAmount).toBe("1000");
    expect(split.vatAmount).toBe("120");
    expect(split.grossAmount).toBe("1120");
  });

  it("reconciles: net + vat equals gross", () => {
    for (const gross of ["1120", "999.99", "1", "3333.33"]) {
      const split = extractVat(gross);
      expect(Number(split.netAmount) + Number(split.vatAmount)).toBeCloseTo(Number(gross), 2);
    }
  });

  it("leaves exempt and zero-rated amounts untaxed", () => {
    for (const treatment of ["exempt", "zero_rated"] as const) {
      const split = extractVat("1120", treatment);
      expect(split.vatAmount).toBe("0");
      expect(split.netAmount).toBe("1120");
    }
  });
});

describe("addVat", () => {
  it("adds 12% to an exclusive amount", () => {
    const split = addVat("1000");
    expect(split.vatAmount).toBe("120");
    expect(split.grossAmount).toBe("1120");
  });

  it("round-trips against extractVat", () => {
    const added = addVat("1000");
    const extracted = extractVat(added.grossAmount);
    expect(extracted.netAmount).toBe("1000");
    expect(extracted.vatAmount).toBe("120");
  });
});

describe("assessInputVat", () => {
  const valid = {
    supplierIsVatRegistered: true,
    hasVatInvoice: true,
    supplierTin: "123456789000",
    vatAmount: "1200",
  };

  it("credits a fully substantiated purchase", () => {
    const result = assessInputVat(valid);
    expect(result.creditable).toBe(true);
    expect(result.creditableAmount).toBe("1200");
    expect(result.nonCreditableAmount).toBe("0");
  });

  it("refuses VAT from a supplier who is not VAT-registered", () => {
    // They cannot pass on VAT at all; the line is part of the price.
    const result = assessInputVat({ ...valid, supplierIsVatRegistered: false });
    expect(result.creditable).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/cannot pass on VAT/);
  });

  it("refuses an unsubstantiated claim", () => {
    const result = assessInputVat({ ...valid, hasVatInvoice: false });
    expect(result.creditable).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/creditable only when substantiated/);
  });

  it("refuses input VAT relating to exempt sales", () => {
    const result = assessInputVat({ ...valid, relatesToExemptSales: true });
    expect(result.creditable).toBe(false);
  });

  it("returns the non-creditable amount rather than discarding it", () => {
    // It is not lost — it becomes part of the cost, and the caller has to post
    // it somewhere.
    const result = assessInputVat({ ...valid, supplierIsVatRegistered: false });
    expect(result.nonCreditableAmount).toBe("1200");
  });

  it("reports every reason, not just the first", () => {
    const result = assessInputVat({
      supplierIsVatRegistered: false,
      hasVatInvoice: false,
      supplierTin: null,
      vatAmount: "100",
    });
    expect(result.reasons.length).toBe(3);
  });
});

describe("computeUncollectedDeduction — the EOPT deferral", () => {
  const receivable = {
    invoiceId: "inv-1",
    invoiceDate: "2026-01-15",
    dueDate: "2026-02-15",
    outputVat: "1200",
    isServiceSale: true,
    alreadyDeclared: true,
  };

  it("defers VAT on a past-due, already-declared service receivable", () => {
    const result = computeUncollectedDeduction({
      receivables: [receivable],
      periodEnd: "2026-03-31",
    });
    expect(result.eligible).toHaveLength(1);
    expect(result.totalDeduction).toBe("1200");
  });

  it("says plainly that this is a deferral, not forgiveness", () => {
    // Booking the deduction and forgetting the add-back understates VAT in
    // exactly the quarter the cash arrives to pay it.
    const result = computeUncollectedDeduction({
      receivables: [receivable],
      periodEnd: "2026-03-31",
    });
    expect(result.notes.join(" ")).toMatch(/DEFERRAL/);
    expect(result.notes.join(" ")).toMatch(/added back in the quarter its receivable is collected/);
  });

  it("lists eligible invoices individually so the add-back is traceable", () => {
    const result = computeUncollectedDeduction({
      receivables: [receivable, { ...receivable, invoiceId: "inv-2", outputVat: "600" }],
      periodEnd: "2026-03-31",
    });
    expect(result.eligible.map((e) => e.invoiceId)).toEqual(["inv-1", "inv-2"]);
  });

  it("excludes goods — the relief exists only because services moved", () => {
    const result = computeUncollectedDeduction({
      receivables: [{ ...receivable, isServiceSale: false }],
      periodEnd: "2026-03-31",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.ineligible[0].reason).toMatch(/goods were always billed/);
  });

  it("excludes a sale never declared", () => {
    // Deducting VAT that was never declared subtracts something never added.
    const result = computeUncollectedDeduction({
      receivables: [{ ...receivable, alreadyDeclared: false }],
      periodEnd: "2026-03-31",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.ineligible[0].reason).toMatch(/never declared/);
  });

  it("excludes a receivable not yet contractually due", () => {
    const result = computeUncollectedDeduction({
      receivables: [{ ...receivable, dueDate: "2026-06-30" }],
      periodEnd: "2026-03-31",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.ineligible[0].reason).toMatch(/not yet contractually due/);
  });

  it("names the reason for every exclusion", () => {
    const result = computeUncollectedDeduction({
      receivables: [
        { ...receivable, invoiceId: "a", isServiceSale: false },
        { ...receivable, invoiceId: "b", alreadyDeclared: false },
        { ...receivable, invoiceId: "c", dueDate: "2027-01-01" },
      ],
      periodEnd: "2026-03-31",
    });
    expect(result.ineligible).toHaveLength(3);
    for (const item of result.ineligible) expect(item.reason.length).toBeGreaterThan(20);
  });
});

// Deliberate expectation change (audit P13): buildVatReturn now emits FORM
// strings — centavo-rounded toPesoString values — because the 2550Q's fields
// are pesos-and-centavos, not the internal 8-decimal representation. And a
// negative payable is split: input-VAT excess carries over; unused
// credits/payments are reported separately, never converted to input VAT.
describe("buildVatReturn", () => {
  const base = {
    quarter: 1 as const,
    year: 2026,
    outputVat: "120000",
    creditableInputVat: "50000",
  };

  it("computes VAT payable as output less input", () => {
    const ret = buildVatReturn(base);
    expect(ret.vatPayable).toBe("70000.00");
    expect(ret.carryoverToNextQuarter).toBe("0.00");
    expect(ret.unusedTaxCredits).toBe("0.00");
  });

  it("carries excess input VAT forward instead of refunding it", () => {
    // Excess input VAT is never refunded on the return itself.
    const ret = buildVatReturn({ ...base, creditableInputVat: "200000" });
    expect(ret.vatPayable).toBe("0.00");
    expect(ret.carryoverToNextQuarter).toBe("80000.00");
  });

  it("applies a prior quarter's carryover", () => {
    const ret = buildVatReturn({ ...base, inputVatCarryover: "20000" });
    expect(ret.totalInputVat).toBe("70000.00");
    expect(ret.vatPayable).toBe("50000.00");
  });

  it("reduces output VAT by the EOPT deduction", () => {
    const ret = buildVatReturn({ ...base, uncollectedDeduction: "20000" });
    expect(ret.netOutputVat).toBe("100000.00");
    expect(ret.vatPayable).toBe("50000.00");
  });

  it("adds back recovered uncollected VAT", () => {
    // The other half of the deferral: collected later, taxed then.
    const ret = buildVatReturn({ ...base, recoveredUncollected: "15000" });
    expect(ret.netOutputVat).toBe("135000.00");
  });

  it("splits a negative payable: input-VAT excess carries over, unused credits do not", () => {
    // 120k output, 50k input, 100k credits: liability after input is 70k,
    // credits cover it with 30k left over. That 30k is NOT input VAT and
    // must not inflate next quarter's carryover.
    const ret = buildVatReturn({ ...base, taxCreditsPayments: "100000" });
    expect(ret.vatPayable).toBe("0.00");
    expect(ret.carryoverToNextQuarter).toBe("0.00");
    expect(ret.unusedTaxCredits).toBe("30000.00");
  });

  it("blocks a deduction larger than output VAT", () => {
    const ret = buildVatReturn({ ...base, uncollectedDeduction: "200000" });
    expect(ret.blockingIssues.join(" ")).toMatch(/exceeds output VAT/);
  });

  describe("periods and deadlines", () => {
    it("spans the right quarter", () => {
      expect(buildVatReturn({ ...base, quarter: 1 }).periodStart).toBe("2026-01-01");
      expect(buildVatReturn({ ...base, quarter: 1 }).periodEnd).toBe("2026-03-31");
      expect(buildVatReturn({ ...base, quarter: 4 }).periodStart).toBe("2026-10-01");
      expect(buildVatReturn({ ...base, quarter: 4 }).periodEnd).toBe("2026-12-31");
    });

    it("is due 25 days after the quarter closes", () => {
      expect(buildVatReturn({ ...base, quarter: 1 }).dueDate).toBe("2026-04-25");
      expect(buildVatReturn({ ...base, quarter: 2 }).dueDate).toBe("2026-07-25");
      // Q4 crosses the year boundary.
      expect(buildVatReturn({ ...base, quarter: 4 }).dueDate).toBe("2027-01-25");
    });

    it("rejects an impossible quarter", () => {
      expect(() => buildVatReturn({ ...base, quarter: 5 as never })).toThrow(/Invalid quarter/);
    });
  });
});

describe("buildSlspSection", () => {
  const entry = (over: Partial<Parameters<typeof buildSlspSection>[0][number]> = {}) => ({
    tin: "123456789000",
    registeredName: "PARTNER INC",
    netAmount: "10000",
    vatAmount: "1200",
    treatment: "vatable" as const,
    ...over,
  });

  it("groups by TIN", () => {
    const section = buildSlspSection([entry(), entry()]);
    expect(section.lines).toHaveLength(1);
    expect(section.lines[0].netAmount).toBe("20000");
    expect(section.lines[0].transactionCount).toBe(2);
  });

  it("keeps vatable, zero-rated and exempt apart", () => {
    // Separate columns on the submission; merging them misstates all three.
    const section = buildSlspSection([
      entry(),
      entry({ treatment: "exempt", vatAmount: "0" }),
      entry({ treatment: "zero_rated", vatAmount: "0" }),
    ]);
    expect(section.lines).toHaveLength(3);
    expect(section.totalExempt).toBe("10000");
    expect(section.totalZeroRated).toBe("10000");
    expect(section.totalVat).toBe("1200");
  });

  it("orders deterministically", () => {
    const entries = [entry({ tin: "999999999000" }), entry({ tin: "111111111000" })];
    const a = buildSlspSection(entries);
    const b = buildSlspSection([...entries].reverse());
    expect(a.lines.map((l) => l.tin)).toEqual(b.lines.map((l) => l.tin));
  });

  it("totals an empty section as zero rather than failing", () => {
    const section = buildSlspSection([]);
    expect(section.totalNet).toBe("0");
    expect(section.lines).toEqual([]);
  });
});
