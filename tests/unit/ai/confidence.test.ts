import { describe, expect, it } from "vitest";
import { normalizeConfidence, toMatcherConfidence } from "../../../src/lib/ai/confidence";

describe("normalizeConfidence", () => {
  it("passes through 0–1 values", () => {
    expect(normalizeConfidence(0.85)).toBe(0.85);
    expect(normalizeConfidence(0.999)).toBe(0.999);
    expect(normalizeConfidence(0)).toBe(0);
  });

  // PR-19 deliberate change: a bare 1 reads as 100% on the 0-1 scale and 1%
  // on the 0-100 scale. It used to resolve to 100% — the worst reading,
  // since a 1%-confident percentage answer sailed over every auto-apply
  // threshold. Ambiguity resolves LOW; full confidence is expressed as 100.
  it("treats a bare 1 as ambiguous and resolves it LOW", () => {
    expect(normalizeConfidence(1)).toBe(0.01);
    expect(normalizeConfidence("1")).toBe(0.01);
    expect(normalizeConfidence(100)).toBe(1);
  });

  it("honors a schema-pinned unit scale, where 1 really is 100%", () => {
    expect(normalizeConfidence(1, { scaleHint: "unit" })).toBe(1);
    expect(normalizeConfidence(0.5, { scaleHint: "unit" })).toBe(0.5);
    // The hint does not disable percentage rescue for out-of-range values.
    expect(normalizeConfidence(85, { scaleHint: "unit" })).toBe(0.85);
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
    // Bare 1 is ambiguous-low (PR-19) unless the caller pins the scale.
    expect(toMatcherConfidence(1)).toBe(1);
    expect(toMatcherConfidence(1, { scaleHint: "unit" })).toBe(100);
    expect(toMatcherConfidence(0.99)).toBe(99);
  });

  it("normalizes before converting (tolerates 0–100 input)", () => {
    expect(toMatcherConfidence(84)).toBe(84);
  });
});
