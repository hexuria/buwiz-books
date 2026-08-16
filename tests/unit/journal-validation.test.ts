import { describe, expect, it } from "vitest";
import { validateBalance } from "@/db/validation/journals";

describe("validateBalance", () => {
  it("returns valid when debits equal credits", () => {
    const result = validateBalance([
      { accountId: crypto.randomUUID(), debit: "100.00" },
      { accountId: crypto.randomUUID(), credit: "100.00" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.totalDebits).toBe(100);
    expect(result.totalCredits).toBe(100);
    expect(result.difference).toBe(0);
  });

  it("rounds floating point sums to two decimals", () => {
    const result = validateBalance([
      { accountId: crypto.randomUUID(), debit: "0.10" },
      { accountId: crypto.randomUUID(), debit: "0.20" },
      { accountId: crypto.randomUUID(), credit: "0.30" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.difference).toBe(0);
  });

  it("returns the imbalance when totals do not match", () => {
    const result = validateBalance([
      { accountId: crypto.randomUUID(), debit: "150.00" },
      { accountId: crypto.randomUUID(), credit: "149.99" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.difference).toBe(0.01);
  });
});
