import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPOT_CHECK_RATE,
  isSpotCheckSampled,
  normalizeSpotCheckRate,
  spotCheckDraw,
} from "@/lib/inbox/jev-approval/spot-check";

const SALT = "2f4f7a1e-8c2b-4b8a-9d57-1d0b7f0c4a11";

describe("spot-check sampling", () => {
  it("is deterministic for a candidate and salt", () => {
    const candidateId = randomUUID();
    const first = spotCheckDraw({ candidateId, salt: SALT });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(spotCheckDraw({ candidateId, salt: SALT })).toBe(first);
      expect(isSpotCheckSampled({ candidateId, salt: SALT, rate: 0.1 })).toBe(first < 0.1);
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("pins known draws, so a change to the hashing cannot slip through unnoticed", () => {
    // sha256("salt-1:candidate-a") = b8685c93 6dc03bd4 …: 53 bits of it, over 2^53.
    expect(spotCheckDraw({ candidateId: "candidate-a", salt: "salt-1" })).toBe(0.2613007682392614);
    expect(spotCheckDraw({ candidateId: "candidate-b", salt: "salt-1" })).toBe(0.05562065719717779);
    // Both the salt and the id are part of the draw.
    expect(spotCheckDraw({ candidateId: "candidate-a", salt: "salt-2" })).not.toBe(
      0.2613007682392614,
    );
    expect(isSpotCheckSampled({ candidateId: "candidate-b", salt: "salt-1", rate: "0.1000" })).toBe(
      true,
    );
    expect(isSpotCheckSampled({ candidateId: "candidate-a", salt: "salt-1", rate: "0.1000" })).toBe(
      false,
    );
  });

  it("samples close to the configured rate over many candidates", () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `candidate-${index}`);
    for (const rate of [0.1, 0.25, 0.5]) {
      const sampled = ids.filter((candidateId) =>
        isSpotCheckSampled({ candidateId, salt: SALT, rate }),
      ).length;
      // Binomial: three standard deviations at n = 20,000 is under 1.1 points.
      expect(Math.abs(sampled / ids.length - rate)).toBeLessThan(0.011);
    }
  });

  it("holds back nothing at 0 and everything at 1", () => {
    for (let index = 0; index < 200; index += 1) {
      const candidateId = randomUUID();
      expect(isSpotCheckSampled({ candidateId, salt: SALT, rate: 0 })).toBe(false);
      expect(isSpotCheckSampled({ candidateId, salt: SALT, rate: "1.0000" })).toBe(true);
    }
  });

  it("reads the stored decimal, defaults when unset, and holds everything back when unreadable", () => {
    expect(normalizeSpotCheckRate("0.1000")).toBe(0.1);
    expect(normalizeSpotCheckRate(null)).toBe(DEFAULT_SPOT_CHECK_RATE);
    expect(normalizeSpotCheckRate(undefined)).toBe(DEFAULT_SPOT_CHECK_RATE);
    expect(normalizeSpotCheckRate("not a number")).toBe(1);
    expect(normalizeSpotCheckRate(-0.5)).toBe(0);
    expect(normalizeSpotCheckRate(7)).toBe(1);
  });
});
