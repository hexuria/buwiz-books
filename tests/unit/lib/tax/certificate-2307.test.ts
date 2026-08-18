import { describe, expect, it } from "vitest";
import {
  buildSawt,
  CertificateValidationError,
  certificatesInSawtPeriod,
  impliedRateBps,
  normalizeTin,
  validateReceived2307,
  type Received2307Input,
} from "@/lib/tax/certificate-2307";

/**
 * When a customer withholds EWT from a payment to us, the money is already with
 * the BIR in our name. The certificate is the only evidence that supports
 * claiming it back — without the paper the credit is disallowed at assessment
 * regardless of what the ledger says.
 *
 * So the expensive failures here are: losing the credit entirely (treating the
 * withheld portion as a discount), claiming it twice, and claiming it with no
 * certificate behind it.
 */
const base: Received2307Input = {
  payorTin: "234-567-890",
  payorRegisteredName: "ACME CORPORATION",
  certificateNumber: "2307-0001",
  periodStart: "2026-04-01",
  periodEnd: "2026-06-30",
  atc: "WC010",
  incomePayment: "100000",
  taxWithheld: "10000",
};

describe("normalizeTin", () => {
  it("pads a 9-digit TIN with the head-office branch code", () => {
    expect(normalizeTin("123-456-789")).toBe("123456789000");
  });

  it("keeps a 12-digit TIN as given", () => {
    expect(normalizeTin("123-456-789-002")).toBe("123456789002");
  });

  it("strips punctuation and spaces", () => {
    expect(normalizeTin(" 123 456 789 ")).toBe("123456789000");
  });

  it("rejects a wrong-length TIN rather than padding it", () => {
    // A wrong TIN puts the credit against the wrong taxpayer.
    expect(() => normalizeTin("12345")).toThrow(CertificateValidationError);
    expect(() => normalizeTin("1234567890")).toThrow(/9 \(or 12/);
  });
});

describe("impliedRateBps", () => {
  it("derives the rate the certificate's own figures imply", () => {
    expect(impliedRateBps("100000", "10000")).toBe(1000); // 10%
    expect(impliedRateBps("100000", "2000")).toBe(200); // 2%
  });

  it("returns null for a zero payment rather than dividing by it", () => {
    expect(impliedRateBps("0", "0")).toBeNull();
  });
});

describe("validateReceived2307", () => {
  it("accepts a well-formed certificate with no warnings", () => {
    const { normalized, warnings } = validateReceived2307(base);
    expect(normalized.payorTin).toBe("234567890000");
    expect(warnings).toEqual([]);
  });

  describe("what it refuses outright", () => {
    it("tax withheld exceeding the payment", () => {
      // Usually a transposition, and it would inflate the credit claimed.
      expect(() =>
        validateReceived2307({ ...base, incomePayment: "1000", taxWithheld: "10000" }),
      ).toThrow(/exceeds the income payment/);
    });

    it("negative amounts", () => {
      // A correction is its own reversing certificate. A sign flip would net
      // away silently in every SAWT total.
      expect(() => validateReceived2307({ ...base, taxWithheld: "-100" })).toThrow(
        /cannot be negative/,
      );
    });

    it("a blank payor name", () => {
      expect(() => validateReceived2307({ ...base, payorRegisteredName: "  " })).toThrow(
        /registered name is required/,
      );
    });

    it("a missing ATC", () => {
      expect(() => validateReceived2307({ ...base, atc: "" })).toThrow(/ATC is required/);
    });

    it("a period that ends before it starts", () => {
      expect(() =>
        validateReceived2307({ ...base, periodStart: "2026-06-30", periodEnd: "2026-04-01" }),
      ).toThrow(/ends .* before it starts/);
    });
  });

  describe("what it warns about without blocking", () => {
    it("a rate that disagrees with the ATC", () => {
      // 2% keyed as 20% passes every hard constraint and is still wrong. But a
      // genuine mismatch happens (sworn declarations, mixed engagements), so
      // this must not stop capture.
      const { warnings } = validateReceived2307({ ...base, taxWithheld: "20000" });
      expect(warnings.map((w) => w.code)).toContain("RATE_MISMATCH");
      expect(warnings[0].message).toMatch(/20\.00%.*WC010.*10\.00%/);
    });

    it("an unknown ATC, without inventing an expected rate", () => {
      // Guessing a rate would produce a confident warning about a correct
      // certificate.
      const { warnings } = validateReceived2307({ ...base, atc: "WX999" });
      expect(warnings.map((w) => w.code)).toEqual(["UNKNOWN_ATC"]);
    });

    it("a missing certificate number", () => {
      const { warnings } = validateReceived2307({ ...base, certificateNumber: null });
      expect(warnings.map((w) => w.code)).toContain("NO_CERTIFICATE_NUMBER");
    });
  });

  it("upper-cases the ATC so lookups and grouping are stable", () => {
    expect(validateReceived2307({ ...base, atc: "wc010" }).normalized.atc).toBe("WC010");
  });

  it("refuses a dummy TIN instead of storing a placeholder credit", () => {
    expect(() => validateReceived2307({ ...base, payorTin: "123-456-789" })).toThrow(/placeholder/);
    expect(() => validateReceived2307({ ...base, payorTin: "000000000" })).toThrow(/placeholder/);
  });
});

describe("buildSawt", () => {
  const cert = (over: Partial<Parameters<typeof buildSawt>[0]["certificates"][number]> = {}) => ({
    payorTin: "123456789000",
    payorRegisteredName: "ACME CORPORATION",
    atc: "WC010",
    incomePayment: "100000",
    taxWithheld: "10000",
    certificateStatus: "received",
    ...over,
  });

  it("groups by payor AND ATC, which is the SAWT's own grain", () => {
    // One payee can withhold under two ATCs in a quarter; those are separate
    // lines, not one merged row.
    const sawt = buildSawt({
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      certificates: [cert(), cert({ atc: "WC100", taxWithheld: "5000" })],
    });
    expect(sawt.lines).toHaveLength(2);
    expect(sawt.lines.map((l) => l.atc)).toEqual(["WC010", "WC100"]);
  });

  it("merges repeat certificates from the same payor under one ATC", () => {
    const sawt = buildSawt({
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      certificates: [cert(), cert()],
    });
    expect(sawt.lines).toHaveLength(1);
    expect(sawt.lines[0].incomePayment).toBe("200000");
    expect(sawt.lines[0].taxWithheld).toBe("20000");
    expect(sawt.lines[0].certificateCount).toBe(2);
  });

  it("orders rows deterministically", () => {
    // A SAWT whose row order drifts between runs cannot be diffed against the
    // previous quarter.
    const certs = [
      cert({ payorTin: "999999999000" }),
      cert({ payorTin: "111111111000" }),
      cert({ payorTin: "555555555000" }),
    ];
    const first = buildSawt({ periodStart: "a", periodEnd: "b", certificates: certs });
    const second = buildSawt({
      periodStart: "a",
      periodEnd: "b",
      certificates: [...certs].reverse(),
    });
    expect(first.lines.map((l) => l.payorTin)).toEqual(second.lines.map((l) => l.payorTin));
    expect(first.lines[0].payorTin).toBe("111111111000");
  });

  it("totals across every certificate", () => {
    const sawt = buildSawt({
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      certificates: [cert(), cert({ atc: "WC100", incomePayment: "50000", taxWithheld: "2500" })],
    });
    expect(sawt.totalIncomePayment).toBe("150000");
    expect(sawt.totalTaxWithheld).toBe("12500");
    expect(sawt.certificateCount).toBe(2);
  });

  describe("credits at risk", () => {
    it("blocks on certificates that are not in hand", () => {
      // The BIR disallows a credit with no certificate behind it regardless of
      // the ledger, so this must surface before filing rather than at audit.
      const sawt = buildSawt({
        periodStart: "2026-04-01",
        periodEnd: "2026-06-30",
        certificates: [cert(), cert({ certificateStatus: "pending", taxWithheld: "3000" })],
      });
      expect(sawt.pendingCertificateCount).toBe(1);
      expect(sawt.pendingTaxWithheld).toBe("3000");
      expect(sawt.blockingIssues.join(" ")).toMatch(/not in hand/);
    });

    it("counts lost and disputed as not in hand", () => {
      const sawt = buildSawt({
        periodStart: "2026-04-01",
        periodEnd: "2026-06-30",
        certificates: [
          cert({ certificateStatus: "lost" }),
          cert({ certificateStatus: "disputed" }),
        ],
      });
      expect(sawt.pendingCertificateCount).toBe(2);
    });

    it("raises nothing when every certificate is in hand", () => {
      const sawt = buildSawt({
        periodStart: "2026-04-01",
        periodEnd: "2026-06-30",
        certificates: [cert(), cert()],
      });
      expect(sawt.blockingIssues).toEqual([]);
    });

    it("still counts a pending certificate in the totals", () => {
      // It IS claimable — the paper may yet arrive. The risk is flagged, not
      // the amount removed.
      const sawt = buildSawt({
        periodStart: "2026-04-01",
        periodEnd: "2026-06-30",
        certificates: [cert({ certificateStatus: "pending" })],
      });
      expect(sawt.totalTaxWithheld).toBe("10000");
    });
  });

  it("flags an empty period as needing deliberate confirmation", () => {
    const sawt = buildSawt({ periodStart: "a", periodEnd: "b", certificates: [] });
    expect(sawt.blockingIssues.join(" ")).toMatch(/nil SAWT should be deliberate/);
  });

  it("keeps sub-centavo precision in the totals", () => {
    const sawt = buildSawt({
      periodStart: "a",
      periodEnd: "b",
      certificates: [cert({ incomePayment: "0.00000003", taxWithheld: "0.00000001" })],
    });
    expect(sawt.totalTaxWithheld).toBe("0.00000001");
  });
});

describe("certificatesInSawtPeriod", () => {
  const q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };
  const q2 = { periodStart: "2026-04-01", periodEnd: "2026-06-30" };

  it("keeps only certificates whose own quarter sits inside the SAWT period", () => {
    expect(certificatesInSawtPeriod([q1, q2], "2026-04-01", "2026-06-30")).toEqual([q2]);
  });

  it("does not pull a prior quarter in just because it overlaps the window", () => {
    expect(certificatesInSawtPeriod([q1], "2026-03-01", "2026-06-30")).toEqual([]);
  });

  it("refuses a window that ends before it starts", () => {
    expect(() => certificatesInSawtPeriod([q2], "2026-06-30", "2026-04-01")).toThrow(
      /ends .* before it starts/,
    );
  });
});
