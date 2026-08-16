import { describe, expect, it } from "vitest";
import { detectAnomalies, parseCheckNumber } from "../../../src/lib/reconciliation-anomalies";

const line = (id: string, date: string, amount: number, description: string) => ({
  id,
  transactionDate: date,
  description,
  amount,
});

describe("parseCheckNumber", () => {
  it.each([
    ["CHECK 1042", 1042],
    ["CHK #205", 205],
    ["Cheque 88", 88],
    ["ACH DEPOSIT", null],
  ])("%s → %s", (input, expected) => {
    expect(parseCheckNumber(input)).toBe(expected);
  });
});

describe("detectAnomalies", () => {
  it("flags same-day same-amount duplicates (but not the first occurrence)", () => {
    const found = detectAnomalies([
      line("a", "2026-01-05", -50, "STARBUCKS"),
      line("b", "2026-01-05", -50, "STARBUCKS"),
    ]);
    const dupes = found.filter((f) => f.flagType === "duplicate");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].statementLineId).toBe("b");
  });

  it("does not flag same-amount lines on different days", () => {
    const found = detectAnomalies([
      line("a", "2026-01-05", -50, "STARBUCKS"),
      line("b", "2026-01-06", -50, "STARBUCKS"),
    ]);
    expect(found.filter((f) => f.flagType === "duplicate")).toHaveLength(0);
  });

  it("flags a new payee only when history exists", () => {
    const history = [
      { description: "VERIZON WIRELESS", amount: -80 },
      { description: "VERIZON WIRELESS", amount: -82 },
    ];
    const found = detectAnomalies([line("a", "2026-01-05", -20, "NEW VENDOR LLC")], history);
    expect(found.some((f) => f.flagType === "unmatched_statement")).toBe(true);

    const noHistory = detectAnomalies([line("a", "2026-01-05", -20, "NEW VENDOR LLC")], []);
    expect(noHistory.some((f) => f.flagType === "unmatched_statement")).toBe(false);
  });

  it("flags an amount far outside the payee's historical range", () => {
    const history = Array.from({ length: 6 }, () => ({
      description: "VERIZON WIRELESS",
      amount: -80,
    })).concat([{ description: "VERIZON WIRELESS", amount: -82 }]);

    const found = detectAnomalies(
      [line("a", "2026-01-05", -4000, "VERIZON WIRELESS 01/05")],
      history,
    );
    expect(found.some((f) => f.flagType === "amount_discrepancy")).toBe(true);
  });

  it("does not flag a normal amount for a known payee", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      description: "VERIZON WIRELESS",
      amount: -(80 + i),
    }));
    const found = detectAnomalies([line("a", "2026-01-05", -83, "VERIZON WIRELESS")], history);
    expect(found.some((f) => f.flagType === "amount_discrepancy")).toBe(false);
  });

  it("flags check-number gaps within a plausible range", () => {
    const found = detectAnomalies([
      line("a", "2026-01-05", -100, "CHECK 1001"),
      line("b", "2026-01-06", -200, "CHECK 1004"),
    ]);
    const gaps = found.filter((f) => f.flagType === "date_mismatch");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].description).toMatch(/1001 → 1004/);
  });

  it("ignores contiguous check sequences and implausible jumps", () => {
    const contiguous = detectAnomalies([
      line("a", "2026-01-05", -100, "CHECK 1001"),
      line("b", "2026-01-06", -200, "CHECK 1002"),
    ]);
    expect(contiguous.filter((f) => f.flagType === "date_mismatch")).toHaveLength(0);

    const farApart = detectAnomalies([
      line("a", "2026-01-05", -100, "CHECK 1001"),
      line("b", "2026-01-06", -200, "CHECK 9500"),
    ]);
    expect(farApart.filter((f) => f.flagType === "date_mismatch")).toHaveLength(0);
  });

  it("returns nothing for a clean statement", () => {
    const history = [
      { description: "VERIZON WIRELESS", amount: -80 },
      { description: "STARBUCKS", amount: -5 },
    ];
    const found = detectAnomalies(
      [line("a", "2026-01-05", -80, "VERIZON WIRELESS"), line("b", "2026-01-06", -5, "STARBUCKS")],
      history,
    );
    expect(found).toEqual([]);
  });
});
