import { describe, it, expect } from "vitest";
import { maskGeminiKeys } from "../../../src/lib/mask-secret";

describe("maskGeminiKeys", () => {
  it("masks a key to its last four", () => {
    expect(maskGeminiKeys(["AIzaSyABCD1234"])).toEqual(["••••1234"]);
  });

  it("preserves input order", () => {
    expect(maskGeminiKeys(["aaaa1111", "bbbb2222"])).toEqual(["••••1111", "••••2222"]);
  });

  it("disambiguates keys that share a last-4 (no collision)", () => {
    const masks = maskGeminiKeys(["keyA-9999", "keyB-9999", "keyC-9999"]);
    expect(masks).toEqual(["••••9999", "••••9999 (2)", "••••9999 (3)"]);
    // All masks distinct → a mask→key round-trip can't collapse two live keys.
    expect(new Set(masks).size).toBe(masks.length);
  });

  it("supports a lossless mask→key round-trip even with duplicate last-4s", () => {
    const stored = ["real-key-one-9999", "real-key-two-9999", "real-key-three-0000"];
    const masks = maskGeminiKeys(stored);
    const byMask = new Map(masks.map((m, i) => [m, stored[i]]));
    // Every stored key is recoverable from its mask.
    for (let i = 0; i < stored.length; i++) {
      expect(byMask.get(masks[i])).toBe(stored[i]);
    }
    expect(byMask.size).toBe(stored.length);
  });

  it("returns an empty array for no keys", () => {
    expect(maskGeminiKeys([])).toEqual([]);
  });
});
