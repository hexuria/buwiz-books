// ============================================================================
// The autonomy ladder. The load-bearing assertions here are the NEGATIVE
// ones: match/split can never be automated, and confidence alone is never
// enough without an explicit org flip.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  canAutoApply,
  STRUCTURAL_MANUAL_KINDS,
  AUTONOMY_CRITERIA,
} from "../../../src/lib/ai/autonomy";

describe("STRUCTURAL_MANUAL_KINDS", () => {
  it("includes the ledger-linking kinds", () => {
    expect(STRUCTURAL_MANUAL_KINDS.has("match")).toBe(true);
    expect(STRUCTURAL_MANUAL_KINDS.has("split")).toBe(true);
  });

  it("PR-19: party creation, date moves and categorization stay human-applied", () => {
    expect(STRUCTURAL_MANUAL_KINDS.has("create_party")).toBe(true);
    expect(STRUCTURAL_MANUAL_KINDS.has("date_fix")).toBe(true);
    expect(STRUCTURAL_MANUAL_KINDS.has("categorize")).toBe(true);
  });

  it("category_mapping deliberately stays flippable", () => {
    expect(STRUCTURAL_MANUAL_KINDS.has("category_mapping")).toBe(false);
  });
});

describe("canAutoApply", () => {
  // PR-19 walled `categorize`; category_mapping is the deliberately
  // flippable kind (reversible, type-checked on write and read).
  const enabled = { category_mapping: "auto_apply_high_confidence" };

  it("allows a high-confidence proposal for a flipped-on kind", () => {
    expect(
      canAutoApply({
        kind: "category_mapping",
        autonomy: enabled,
        confidence: 0.95,
        threshold: 0.9,
      }),
    ).toBe(true);
  });

  it("refuses when the org has not flipped the task on", () => {
    expect(
      canAutoApply({ kind: "category_mapping", autonomy: {}, confidence: 1.0, threshold: 0.9 }),
    ).toBe(false);
  });

  it("refuses below the org's threshold", () => {
    expect(
      canAutoApply({
        kind: "category_mapping",
        autonomy: enabled,
        confidence: 0.5,
        threshold: 0.9,
      }),
    ).toBe(false);
  });

  it("refuses when confidence is unknown", () => {
    expect(
      canAutoApply({
        kind: "category_mapping",
        autonomy: enabled,
        confidence: null,
        threshold: 0.9,
      }),
    ).toBe(false);
  });

  it("NEVER auto-applies match, even at full confidence with autonomy enabled", () => {
    expect(
      canAutoApply({
        kind: "match",
        autonomy: { match: "auto_apply_high_confidence" },
        confidence: 1.0,
        threshold: 0,
      }),
    ).toBe(false);
  });

  it("NEVER auto-applies split, even at full confidence with autonomy enabled", () => {
    expect(
      canAutoApply({
        kind: "split",
        autonomy: { split: "auto_apply_high_confidence" },
        confidence: 1.0,
        threshold: 0,
      }),
    ).toBe(false);
  });

  it("defaults to a strict threshold when the org set none", () => {
    expect(
      canAutoApply({
        kind: "category_mapping",
        autonomy: enabled,
        confidence: 0.85,
        threshold: null,
      }),
    ).toBe(false);
    expect(
      canAutoApply({
        kind: "category_mapping",
        autonomy: enabled,
        confidence: 0.95,
        threshold: null,
      }),
    ).toBe(true);
  });
});

describe("AUTONOMY_CRITERIA", () => {
  it("demands a meaningful sample and a high bar", () => {
    expect(AUTONOMY_CRITERIA.minProposals).toBeGreaterThanOrEqual(200);
    expect(AUTONOMY_CRITERIA.minAcceptanceRate).toBeGreaterThanOrEqual(0.98);
  });

  it("demotes at a lower rate than it promotes (hysteresis, not flapping)", () => {
    expect(AUTONOMY_CRITERIA.demotionRate).toBeLessThan(AUTONOMY_CRITERIA.minAcceptanceRate);
  });
});
