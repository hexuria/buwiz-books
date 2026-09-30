import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAINS, JEV_MODEL } from "../../../src/lib/ai/chains";
import {
  estimateCostUsd,
  FALLBACK_CHARS_PER_TOKEN,
  meteredUsage,
  priceFor,
  UNPRICED_MODEL_FALLBACK_PRICE,
} from "../../../src/lib/ai/pricing";

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

  it("returns null when there is no usage to price", () => {
    expect(estimateCostUsd({ model: "gpt-4o", tokensIn: 0, tokensOut: 0 })).toBeNull();
    expect(estimateCostUsd({ model: "gpt-4o", tokensIn: null, tokensOut: null })).toBeNull();
    expect(estimateCostUsd({ model: "mystery-model", tokensIn: 0, tokensOut: 0 })).toBeNull();
  });

  it("prices gemini flash far below claude opus for the same usage", () => {
    const usage = { tokensIn: 100_000, tokensOut: 10_000 };
    const flash = estimateCostUsd({ model: "gemini-3.1-flash-image-preview", ...usage })!;
    const opus = estimateCostUsd({ model: "claude-opus-4-8", ...usage })!;
    expect(flash).toBeLessThan(opus / 10);
  });
});

describe("unpriced models", () => {
  const KNOWN_MODELS = [
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "gemini-3.1-flash-image-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-image-preview",
    "gemini-embedding-001",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1",
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("meters an unpriced model at the fallback rate — never null, never free", () => {
    expect(priceFor("jev-ledger-7b")).toBeNull();
    const cost = estimateCostUsd({
      model: "jev-ledger-7b",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(cost).toBeCloseTo(
      UNPRICED_MODEL_FALLBACK_PRICE.inputPerMTok + UNPRICED_MODEL_FALLBACK_PRICE.outputPerMTok,
      6,
    );
  });

  it("meters an unreported model id at the fallback rate too", () => {
    expect(estimateCostUsd({ model: null, tokensIn: 1_000_000, tokensOut: 0 })).toBeCloseTo(
      UNPRICED_MODEL_FALLBACK_PRICE.inputPerMTok,
      6,
    );
  });

  it("never meters an unknown model as cheaper than a known one", () => {
    for (const model of KNOWN_MODELS) {
      const price = priceFor(model);
      expect(price, model).not.toBeNull();
      expect(UNPRICED_MODEL_FALLBACK_PRICE.inputPerMTok).toBeGreaterThanOrEqual(
        price!.inputPerMTok,
      );
      expect(UNPRICED_MODEL_FALLBACK_PRICE.outputPerMTok).toBeGreaterThanOrEqual(
        price!.outputPerMTok,
      );
    }
  });

  it("keeps every default-chain model on its real price", () => {
    // A default model falling through to the fallback would bill every org
    // at the most expensive rate in the table.
    for (const chain of Object.values(DEFAULT_CHAINS)) {
      for (const hop of chain) expect(priceFor(hop.model), hop.model).not.toBeNull();
    }
  });

  it("does not change what a known model costs", () => {
    expect(
      estimateCostUsd({ model: "gpt-4o-mini", tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ).toBe(0.75);
    expect(
      estimateCostUsd({ model: "claude-haiku-4-5", tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ).toBe(6);
  });

  it("warns once per unpriced model, not once per call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pricingWarnings = () =>
      warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { scope: string; model: string })
        .filter((entry) => entry.scope === "ai.pricing");

    const usage = { tokensIn: 1000, tokensOut: 100 };
    estimateCostUsd({ model: "warn-once-model-a", ...usage });
    estimateCostUsd({ model: "warn-once-model-a", ...usage });
    estimateCostUsd({ model: "warn-once-model-b", ...usage });
    estimateCostUsd({ model: "gpt-4o", ...usage });

    expect(pricingWarnings().map((entry) => entry.model)).toEqual([
      "warn-once-model-a",
      "warn-once-model-b",
    ]);
  });
});

describe("Jev is metered with every other unpriced model", () => {
  it("prices a Jev model id at the fallback rate, never as free", () => {
    expect(priceFor(JEV_MODEL)).toBeNull();
    const cost = estimateCostUsd({ model: JEV_MODEL, tokensIn: 300, tokensOut: 40 });
    const expected =
      (300 / 1_000_000) * UNPRICED_MODEL_FALLBACK_PRICE.inputPerMTok +
      (40 / 1_000_000) * UNPRICED_MODEL_FALLBACK_PRICE.outputPerMTok;
    expect(cost).toBeCloseTo(Math.round(expected * 1_000_000) / 1_000_000, 6);
    expect(cost).toBeGreaterThan(0);
  });
});

describe("meteredUsage", () => {
  it("passes reported counts through untouched", () => {
    expect(meteredUsage({ tokensIn: 120, tokensOut: 30 }, "prompt", "response")).toEqual({
      tokensIn: 120,
      tokensOut: 30,
      estimated: false,
    });
  });

  it("estimates from the text when a gateway reports no usage", () => {
    const prompt = "p".repeat(301);
    const response = "r".repeat(30);
    expect(meteredUsage({ tokensIn: null, tokensOut: null }, prompt, response)).toEqual({
      tokensIn: Math.ceil(301 / FALLBACK_CHARS_PER_TOKEN),
      tokensOut: Math.ceil(30 / FALLBACK_CHARS_PER_TOKEN),
      estimated: true,
    });
  });

  it("treats a reported zero as missing", () => {
    const usage = meteredUsage({ tokensIn: 0, tokensOut: 0 }, "abcdef", "abc");
    expect(usage).toEqual({ tokensIn: 2, tokensOut: 1, estimated: true });
  });

  it("estimates only the missing side", () => {
    expect(meteredUsage({ tokensIn: 500, tokensOut: null }, "prompt", "abcdef")).toEqual({
      tokensIn: 500,
      tokensOut: 2,
      estimated: true,
    });
  });

  it("does not flag an empty response as an estimate", () => {
    expect(meteredUsage({ tokensIn: 500, tokensOut: null }, "prompt", "")).toEqual({
      tokensIn: 500,
      tokensOut: 0,
      estimated: false,
    });
  });
});
