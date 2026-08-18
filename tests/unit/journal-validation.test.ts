import { describe, expect, it } from "vitest";
import { validateBalance } from "@/db/validation/journals";

const acct = () => crypto.randomUUID();

describe("validateBalance", () => {
  it("returns valid when debits equal credits", () => {
    const result = validateBalance([
      { accountId: acct(), debit: "100.00" },
      { accountId: acct(), credit: "100.00" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.totalDebits).toBe(100);
    expect(result.totalCredits).toBe(100);
    expect(result.difference).toBe(0);
  });

  it("sums amounts that float addition gets wrong", () => {
    // 0.10 + 0.20 !== 0.30 in binary floating point. The old implementation
    // survived this by rounding to 2dp before comparing; scaled-integer
    // arithmetic is simply exact.
    const result = validateBalance([
      { accountId: acct(), debit: "0.10" },
      { accountId: acct(), debit: "0.20" },
      { accountId: acct(), credit: "0.30" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.difference).toBe(0);
    expect(result.totalDebitsExact).toBe("0.3");
  });

  it("returns the imbalance when totals do not match", () => {
    const result = validateBalance([
      { accountId: acct(), debit: "150.00" },
      { accountId: acct(), credit: "149.99" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.difference).toBe(0.01);
    expect(result.differenceExact).toBe("0.01");
  });

  describe("what the float implementation let through", () => {
    it("REJECTS a sub-centavo imbalance", () => {
      // The ledger stores decimal(20, 8). The old check rounded both sides to
      // 2dp before comparing, so this passed validation and was posted out of
      // balance — the database (0038) would now reject it at COMMIT with an
      // unexplained constraint violation.
      const result = validateBalance([
        { accountId: acct(), debit: "100" },
        { accountId: acct(), credit: "99.99999999" },
      ]);

      expect(result.valid).toBe(false);
      expect(result.differenceExact).toBe("0.00000001");
    });

    it("does not drift over a long line set", () => {
      // 0.07 repeated accumulates visible float error; scaled integers do not.
      const lines = [
        ...Array.from({ length: 100 }, () => ({ accountId: acct(), debit: "0.07" })),
        { accountId: acct(), credit: "7.00" },
      ];
      const result = validateBalance(lines);

      expect(result.valid).toBe(true);
      expect(result.totalDebitsExact).toBe("7");
    });

    it("keeps full precision in the total written to the header", () => {
      // `totalDebits.toFixed(2)` was used as `journal_headers.total_amount`,
      // truncating a legitimately sub-centavo total before storing it.
      const result = validateBalance([
        { accountId: acct(), debit: "10.123456" },
        { accountId: acct(), credit: "10.123456" },
      ]);

      expect(result.valid).toBe(true);
      expect(result.totalDebitsExact).toBe("10.123456");
      // The float field would have rendered this as "10.12".
      expect(result.totalDebits.toFixed(2)).toBe("10.12");
    });
  });

  it("rejects a malformed amount rather than coercing it to NaN", () => {
    // `Number.parseFloat("abc")` is NaN, and NaN !== NaN made `valid` false
    // with a `difference` of NaN — an unbalanced-entry message that named no
    // amounts. This fails with the offending value instead.
    expect(() => validateBalance([{ accountId: acct(), debit: "abc" }])).toThrow(
      /Invalid money amount/,
    );
  });

  it("rejects an amount finer than the ledger can store", () => {
    expect(() => validateBalance([{ accountId: acct(), debit: "1.123456789" }])).toThrow(
      /more than 8 decimal places/,
    );
  });

  it("treats an empty line set as balanced at zero", () => {
    const result = validateBalance([]);
    expect(result.valid).toBe(true);
    expect(result.totalDebitsExact).toBe("0");
  });
});
