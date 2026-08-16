import { describe, expect, it } from "vitest";
import {
  buildMatchBlocks,
  findSplitCombinations,
  tokenOverlap,
} from "../../../src/lib/match-assist/blocking";
import type { LedgerTransactionForMatching } from "../../../src/lib/auto-matcher";

const ledger = (
  id: string,
  date: string,
  amount: number,
  description: string,
  partyName?: string,
): LedgerTransactionForMatching => ({
  journalLineId: id,
  date,
  amount,
  description,
  ...(partyName ? { partyName } : {}),
});

describe("tokenOverlap", () => {
  it("scores identical vendors high", () => {
    expect(tokenOverlap("AMZN Mktp US*2K3AB", "AMZN MKTP US")).toBeGreaterThan(0.9);
  });

  it("scores unrelated descriptors at zero", () => {
    expect(tokenOverlap("STARBUCKS SEATTLE", "VERIZON WIRELESS")).toBe(0);
  });
});

describe("findSplitCombinations", () => {
  it("finds a two-part split that sums exactly", () => {
    const combos = findSplitCombinations(-100, [
      ledger("a", "2026-01-01", -60, "PART A"),
      ledger("b", "2026-01-01", -40, "PART B"),
      ledger("c", "2026-01-01", -25, "PART C"),
    ]);
    expect(combos).toContainEqual({ journalLineIds: ["a", "b"], total: -100 });
  });

  it("finds a three-part split when allowed", () => {
    const combos = findSplitCombinations(
      -100,
      [
        ledger("a", "2026-01-01", -50, "A"),
        ledger("b", "2026-01-01", -30, "B"),
        ledger("c", "2026-01-01", -20, "C"),
      ],
      3,
    );
    expect(combos.some((c) => c.journalLineIds.length === 3)).toBe(true);
  });

  it("respects the max-parts bound", () => {
    const combos = findSplitCombinations(
      -100,
      [
        ledger("a", "2026-01-01", -50, "A"),
        ledger("b", "2026-01-01", -30, "B"),
        ledger("c", "2026-01-01", -20, "C"),
      ],
      2,
    );
    expect(combos).toHaveLength(0);
  });

  it("returns nothing when no subset sums to the target", () => {
    expect(
      findSplitCombinations(-100, [
        ledger("a", "2026-01-01", -33, "A"),
        ledger("b", "2026-01-01", -44, "B"),
      ]),
    ).toHaveLength(0);
  });
});

describe("buildMatchBlocks", () => {
  const line = {
    id: "line-1",
    transactionDate: "2026-01-10",
    description: "AMZN Mktp US*2K3AB817",
    amount: -100,
  };

  it("includes an exact-amount candidate within the date window", () => {
    const blocks = buildMatchBlocks(
      [line],
      [ledger("jl-1", "2026-01-08", -100, "Amazon office supplies")],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].candidates.map((c) => c.journalLineId)).toEqual(["jl-1"]);
  });

  it("excludes candidates outside the date window", () => {
    const blocks = buildMatchBlocks([line], [ledger("jl-far", "2026-02-20", -100, "Amazon")]);
    expect(blocks).toHaveLength(0);
  });

  it("excludes candidates with no amount, token, or alias signal", () => {
    const blocks = buildMatchBlocks(
      [line],
      [ledger("jl-noise", "2026-01-09", -12.34, "VERIZON WIRELESS")],
    );
    expect(blocks).toHaveLength(0);
  });

  it("includes a near-amount candidate within tolerance", () => {
    const blocks = buildMatchBlocks(
      [line],
      [ledger("jl-near", "2026-01-09", -100.5, "Something else entirely")],
    );
    expect(blocks[0]?.candidates[0]?.journalLineId).toBe("jl-near");
  });

  it("flags alias matches and ranks them into the block", () => {
    const blocks = buildMatchBlocks(
      [line],
      [ledger("jl-alias", "2026-01-09", -55, "MISC", "Amazon")],
      {
        aliasPartyByDescriptor: new Map([["AMZN MKTP US", "Amazon"]]),
      },
    );
    expect(blocks[0].candidates[0].aliasMatch).toBe(true);
  });

  it("ranks exact-amount candidates above weak ones and caps the block size", () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      ledger(`jl-${i}`, "2026-01-09", -100, `AMZN MKTP US ${i}`),
    );
    const blocks = buildMatchBlocks([line], candidates, { maxCandidatesPerLine: 3 });
    expect(blocks[0].candidates).toHaveLength(3);
  });

  it("attaches split combinations when subsets sum to the line", () => {
    const blocks = buildMatchBlocks(
      [line],
      [
        ledger("jl-a", "2026-01-09", -60, "AMZN MKTP US part 1"),
        ledger("jl-b", "2026-01-09", -40, "AMZN MKTP US part 2"),
      ],
    );
    expect(blocks[0].splitCombinations).toContainEqual({
      journalLineIds: ["jl-a", "jl-b"],
      total: -100,
    });
  });

  it("omits lines with no candidates entirely (no wasted model call)", () => {
    expect(buildMatchBlocks([line], [])).toHaveLength(0);
  });
});
