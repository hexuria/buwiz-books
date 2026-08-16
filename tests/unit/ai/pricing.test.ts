import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "../../../src/lib/ai/pricing";

describe("priceFor", () => {
  it("matches pinned snapshot ids via their family prefix", () => {
    expect(priceFor("claude-sonnet-5-20260101")).toEqual(priceFor("claude-sonnet-5"));
  });

  it("prefers the longest matching prefix", () => {
    // gpt-4o-mini must NOT be priced as gpt-4o.
    expect(priceFor("gpt-4o-mini")!.inputPerMTok).toBeLessThan(priceFor("gpt-4o")!.inputPerMTok);
  });

  it("returns null for an unknown model", () => {
    expect(priceFor("some-new-model-2027")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("computes input + output cost", () => {
    // 1M in @ $3, 1M out @ $15 → $18
    expect(
      estimateCostUsd({ model: "claude-sonnet-5", tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ).toBeCloseTo(18, 6);
  });

  it("keeps sub-cent precision for cheap OCR pages", () => {
    const cost = estimateCostUsd({
      model: "gemini-3.1-flash-image-preview",
      tokensIn: 258,
      tokensOut: 100,
    });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.001);
  });

  it("returns null (unknown), never 0, for an unpriced model", () => {
    expect(estimateCostUsd({ model: "mystery-model", tokensIn: 1000, tokensOut: 1000 })).toBeNull();
  });

  it("returns null when there is no usage to price", () => {
    expect(estimateCostUsd({ model: "gpt-4o", tokensIn: 0, tokensOut: 0 })).toBeNull();
    expect(estimateCostUsd({ model: "gpt-4o", tokensIn: null, tokensOut: null })).toBeNull();
  });

  it("prices gemini flash far below claude opus for the same usage", () => {
    const usage = { tokensIn: 100_000, tokensOut: 10_000 };
    const flash = estimateCostUsd({ model: "gemini-3.1-flash-image-preview", ...usage })!;
    const opus = estimateCostUsd({ model: "claude-opus-4-8", ...usage })!;
    expect(flash).toBeLessThan(opus / 10);
  });
});
