import { describe, expect, it } from "vitest";
import { normalizeConfidence, toMatcherConfidence } from "../../../src/lib/ai/confidence";

describe("normalizeConfidence", () => {
  it("passes through 0–1 values", () => {
    expect(normalizeConfidence(0.85)).toBe(0.85);
    expect(normalizeConfidence(1)).toBe(1);
    expect(normalizeConfidence(0)).toBe(0);
  });

  it("scales 0–100 values down", () => {
    expect(normalizeConfidence(85)).toBe(0.85);
    expect(normalizeConfidence(100)).toBe(1);
  });

  it("clamps values above 100", () => {
    expect(normalizeConfidence(250)).toBe(1);
  });

  it("returns 0 for non-numeric and negative input", () => {
    expect(normalizeConfidence("high")).toBe(0);
    expect(normalizeConfidence(undefined)).toBe(0);
    expect(normalizeConfidence(null)).toBe(0);
    expect(normalizeConfidence(-5)).toBe(0);
    expect(normalizeConfidence(Number.NaN)).toBe(0);
    expect(normalizeConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("accepts numeric strings", () => {
    expect(normalizeConfidence("85")).toBe(0.85);
    expect(normalizeConfidence("0.6")).toBe(0.6);
  });
});

describe("toMatcherConfidence", () => {
  it("converts 0–1 to the matcher's 0–100 domain", () => {
    expect(toMatcherConfidence(0.84)).toBe(84);
    expect(toMatcherConfidence(1)).toBe(100);
  });

  it("normalizes before converting (tolerates 0–100 input)", () => {
    expect(toMatcherConfidence(84)).toBe(84);
  });
});
