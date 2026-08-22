import { describe, it, expect } from "vitest";
import {
  applyPercent,
  applyRateBps,
  addAll,
  clampAtZero,
  roundToCentavos,
  toPesoString,
  toScaled,
} from "@/lib/tax/money";

describe("roundToCentavos — the BIR half-up rule", () => {
  it.each([
    ["1.004", "1.00"],
    ["1.005", "1.01"],
    ["1.006", "1.01"],
    ["1.0049999", "1.00"],
    ["0.005", "0.01"],
    ["0.004", "0.00"],
    ["1375.045", "1375.05"],
  ])("rounds %s to %s", (input, expected) => {
    expect(toPesoString(roundToCentavos(toScaled(input)))).toBe(expected);
  });

  it("rounds ties away from zero on both signs", () => {
    // BIR prescribes no rule for negatives because a negative tax does not
    // arise. Symmetry is chosen so a reversal mirrors what it reverses instead
    // of drifting a centavo.
    expect(toPesoString(roundToCentavos(toScaled("-1.005")))).toBe("-1.01");
    expect(toPesoString(roundToCentavos(toScaled("1.005")))).toBe("1.01");
  });
});

describe("applyRateBps", () => {
  it("computes exact percentages", () => {
    expect(toPesoString(applyRateBps(toScaled("100000"), 1500))).toBe("15000.00");
    expect(toPesoString(applyRateBps(toScaled("100000"), 1200))).toBe("12000.00");
    expect(toPesoString(applyRateBps(toScaled("100"), 200))).toBe("2.00");
  });

  it("rounds ONCE, not twice", () => {
    // Dividing then rounding separately drifts. 9167 × 15% = 1375.05 exactly;
    // a two-step implementation can land on 1375.04.
    expect(toPesoString(applyRateBps(toScaled("9167"), 1500))).toBe("1375.05");
    expect(toPesoString(applyRateBps(toScaled("8333"), 2000))).toBe("1666.60");
    expect(toPesoString(applyRateBps(toScaled("26667"), 2000))).toBe("5333.40");
  });

  it("handles a base with sub-centavo precision without losing it early", () => {
    // 0.005 × 50% = 0.0025, which rounds half-up to 0.01... no: 0.0025 rounds
    // to 0.00 under half-up at 2dp. The point is that the base is not
    // pre-rounded before multiplying.
    expect(toPesoString(applyRateBps(toScaled("0.005"), 5000))).toBe("0.00");
    expect(toPesoString(applyRateBps(toScaled("0.01"), 5000))).toBe("0.01");
  });

  it("rejects a rate outside [0, 10000] bps", () => {
    expect(() => applyRateBps(toScaled("100"), -1)).toThrow(RangeError);
    expect(() => applyRateBps(toScaled("100"), 10_001)).toThrow(RangeError);
    expect(() => applyRateBps(toScaled("100"), 12.5)).toThrow(RangeError);
  });

  it("is exact at the VAT rate on an awkward base", () => {
    // 12% of 8,333.33 = 999.9996 → 1,000.00
    expect(toPesoString(applyRateBps(toScaled("8333.33"), 1200))).toBe("1000.00");
  });
});

describe("applyPercent", () => {
  it("expresses the de minimis percentage-of-minimum-wage ceiling", () => {
    // RR 29-2025 raised the OT/night-shift meal allowance to 30% of the
    // regional basic minimum wage.
    expect(toPesoString(applyPercent(toScaled("645"), 30))).toBe("193.50");
    expect(toPesoString(applyPercent(toScaled("645"), 25))).toBe("161.25");
  });
});

describe("helpers", () => {
  it("adds without float drift", () => {
    expect(toPesoString(addAll(toScaled("0.1"), toScaled("0.2")))).toBe("0.30");
  });

  it("clamps negatives to zero", () => {
    expect(toPesoString(clampAtZero(toScaled("-5")))).toBe("0.00");
    expect(toPesoString(clampAtZero(toScaled("5")))).toBe("5.00");
  });

  it("renders exactly two decimals", () => {
    expect(toPesoString(toScaled("1000"))).toBe("1000.00");
    expect(toPesoString(toScaled("1000.5"))).toBe("1000.50");
    expect(toPesoString(toScaled("0"))).toBe("0.00");
  });

  it("rejects a non-numeric amount rather than coercing it", () => {
    expect(() => toScaled("abc")).toThrow();
  });
});
