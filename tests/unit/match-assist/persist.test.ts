// ============================================================================
// The 84-cap invariant and grounding/money-math guards.
//
// These tests pin AI_NATIVE_ARCHITECTURE §2 wall 4: an LLM-sourced match can
// never reach the auto-link threshold, no matter what the model claims.
// ============================================================================
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  persistLlmMatchSuggestions,
  suggestionFingerprint,
  LLM_SUGGESTION_MAX_CONFIDENCE,
} from "../../../src/lib/match-assist/persist";
import type { MatchDecision } from "../../../src/lib/ai/schemas/match-assist";

// Minimal Drizzle stub: select().from().where() → dismissed rows;
// insert().values() → captured rows.
let dismissedRows: any[] = [];
let insertedRows: any[] = [];

const db = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => dismissedRows),
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(async (rows: any[]) => {
      insertedRows.push(...rows);
    }),
  })),
} as never;

const LINE_ID = "line-1";
const statementLines = new Map([
  [LINE_ID, { id: LINE_ID, amount: "-100.00", description: "ACME CORP" }],
]);
const candidatesByLine = new Map([[LINE_ID, new Set(["jl-1", "jl-2", "jl-3"])]]);

function run(decisions: MatchDecision[]) {
  return persistLlmMatchSuggestions(db, {
    orgId: "org-1",
    reconciliationId: "rec-1",
    decisions,
    statementLines,
    candidatesByLine,
  });
}

const matchDecision = (overrides: Partial<MatchDecision> = {}): MatchDecision => ({
  statementLineId: LINE_ID,
  decision: "match",
  journalLineIds: ["jl-1"],
  confidence: 0.75,
  reason: "amount and date align",
  ...overrides,
});

describe("persistLlmMatchSuggestions — the 84 cap", () => {
  beforeEach(() => {
    dismissedRows = [];
    insertedRows = [];
    vi.clearAllMocks();
  });

  it("caps a fully-confident model match at 84, below the 85 auto-link threshold", async () => {
    const result = await run([matchDecision({ confidence: 1.0 })]);
    expect(result.inserted).toBe(1);
    expect(Number(insertedRows[0].confidence)).toBe(LLM_SUGGESTION_MAX_CONFIDENCE);
    expect(Number(insertedRows[0].confidence)).toBeLessThan(85);
  });

  it("caps even when the model reports 0–100 scale confidence", async () => {
    await run([matchDecision({ confidence: 99 })]);
    expect(Number(insertedRows[0].confidence)).toBe(84);
  });

  it("preserves genuinely lower confidence", async () => {
    await run([matchDecision({ confidence: 0.4 })]);
    expect(Number(insertedRows[0].confidence)).toBe(40);
  });

  it("always writes status pending — never applied/accepted", async () => {
    await run([matchDecision()]);
    expect(insertedRows[0].status).toBe("pending");
  });
});

describe("persistLlmMatchSuggestions — grounding", () => {
  beforeEach(() => {
    dismissedRows = [];
    insertedRows = [];
  });

  it("rejects a hallucinated ledger line ID", async () => {
    const result = await run([matchDecision({ journalLineIds: ["jl-hallucinated"] })]);
    expect(result.inserted).toBe(0);
    expect(result.rejected[0].reason).toMatch(/outside the candidate set/i);
  });

  it("rejects a decision for an unknown statement line", async () => {
    const result = await run([matchDecision({ statementLineId: "line-unknown" })]);
    expect(result.inserted).toBe(0);
    expect(result.rejected[0].reason).toMatch(/unknown statement line/i);
  });

  it("skips 'none' decisions silently", async () => {
    const result = await run([matchDecision({ decision: "none", journalLineIds: [] })]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects a match decision naming multiple ledger lines", async () => {
    const result = await run([matchDecision({ journalLineIds: ["jl-1", "jl-2"] })]);
    expect(result.inserted).toBe(0);
    expect(result.rejected[0].reason).toMatch(/exactly one/i);
  });
});

describe("persistLlmMatchSuggestions — split money math", () => {
  beforeEach(() => {
    dismissedRows = [];
    insertedRows = [];
  });

  const splitDecision = (allocations: Array<{ journalLineId: string; amount: number }>) =>
    matchDecision({
      decision: "split",
      journalLineIds: allocations.map((a) => a.journalLineId),
      allocations,
      confidence: 0.9,
    });

  it("accepts an exact-sum split and records the parts", async () => {
    const result = await run([
      splitDecision([
        { journalLineId: "jl-1", amount: -60 },
        { journalLineId: "jl-2", amount: -40 },
      ]),
    ]);
    expect(result.inserted).toBe(1);
    expect(insertedRows[0].suggestionType).toBe("split");
    expect(insertedRows[0].journalLineId).toBeNull();
    expect(insertedRows[0].proposedChanges.split.to.parts).toEqual([
      { journalLineId: "jl-1", allocatedAmount: "-60.00" },
      { journalLineId: "jl-2", allocatedAmount: "-40.00" },
    ]);
    expect(Number(insertedRows[0].confidence)).toBe(84);
  });

  it("rejects an off-by-one-cent split", async () => {
    const result = await run([
      splitDecision([
        { journalLineId: "jl-1", amount: -60 },
        { journalLineId: "jl-2", amount: -39.99 },
      ]),
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected[0].reason).toMatch(/sum to/i);
  });

  it("rejects a single-allocation split", async () => {
    const result = await run([splitDecision([{ journalLineId: "jl-1", amount: -100 }])]);
    expect(result.inserted).toBe(0);
    expect(result.rejected[0].reason).toMatch(/at least two/i);
  });
});

describe("persistLlmMatchSuggestions — dismissal memory", () => {
  beforeEach(() => {
    insertedRows = [];
  });

  it("does not recreate a dismissed 1:1 suggestion", async () => {
    dismissedRows = [
      {
        statementLineId: LINE_ID,
        journalLineId: "jl-1",
        suggestionType: "auto_match",
        proposedChanges: null,
      },
    ];
    const result = await run([matchDecision()]);
    expect(result.inserted).toBe(0);
  });

  it("does not recreate a dismissed split regardless of allocation order", async () => {
    dismissedRows = [
      {
        statementLineId: LINE_ID,
        journalLineId: null,
        suggestionType: "split",
        proposedChanges: {
          split: {
            to: {
              parts: [{ journalLineId: "jl-2" }, { journalLineId: "jl-1" }],
            },
          },
        },
      },
    ];
    const result = await run([
      matchDecision({
        decision: "split",
        journalLineIds: ["jl-1", "jl-2"],
        allocations: [
          { journalLineId: "jl-1", amount: -60 },
          { journalLineId: "jl-2", amount: -40 },
        ],
      }),
    ]);
    expect(result.inserted).toBe(0);
  });

  it("still creates a suggestion for a different ledger line", async () => {
    dismissedRows = [
      {
        statementLineId: LINE_ID,
        journalLineId: "jl-1",
        suggestionType: "auto_match",
        proposedChanges: null,
      },
    ];
    const result = await run([matchDecision({ journalLineIds: ["jl-2"] })]);
    expect(result.inserted).toBe(1);
  });
});

describe("suggestionFingerprint", () => {
  it("is order-independent", () => {
    expect(suggestionFingerprint("l1", ["b", "a"], "split")).toBe(
      suggestionFingerprint("l1", ["a", "b"], "split"),
    );
  });

  it("distinguishes suggestion types", () => {
    expect(suggestionFingerprint("l1", ["a"], "split")).not.toBe(
      suggestionFingerprint("l1", ["a"], "auto_match"),
    );
  });
});
