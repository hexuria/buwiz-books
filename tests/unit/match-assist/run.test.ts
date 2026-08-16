// ============================================================================
// Match-assist orchestration: batching, grounding-set construction, and
// graceful degradation. The façade and persistence layer are mocked so this
// isolates the orchestration decisions.
// ============================================================================
import { describe, expect, it, vi, beforeEach } from "vitest";

const { aiCompleteMock, persistMock, lookupAliasesMock } = vi.hoisted(() => ({
  aiCompleteMock: vi.fn(),
  persistMock: vi.fn(),
  lookupAliasesMock: vi.fn(),
}));

vi.mock("../../../src/lib/ai/facade", () => ({ aiComplete: aiCompleteMock }));
vi.mock("../../../src/lib/match-assist/persist", () => ({
  persistLlmMatchSuggestions: persistMock,
}));
vi.mock("../../../src/lib/match-assist/aliases", () => ({
  lookupVendorAliases: lookupAliasesMock,
}));

import { runMatchAssist } from "../../../src/lib/match-assist/run";

const db = {} as never;

const line = (id: string, amount = -100) => ({
  id,
  transactionDate: "2026-01-10",
  description: `VENDOR ${id}`,
  amount,
});

const ledgerFor = (id: string, amount = -100) => ({
  journalLineId: `jl-${id}`,
  date: "2026-01-09",
  amount,
  description: `VENDOR ${id}`,
});

describe("runMatchAssist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupAliasesMock.mockResolvedValue(new Map());
    persistMock.mockResolvedValue({ inserted: 1, rejected: [] });
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: "inv-1",
      model: "gemini-test",
      data: { decisions: [] },
    });
  });

  it("skips the model entirely when there is nothing to match", async () => {
    const result = await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: [],
      ledgerTxns: [ledgerFor("a")],
    });
    expect(result.blocksBuilt).toBe(0);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("skips the model when blocking finds no candidates", async () => {
    const result = await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: [line("a")],
      // Far-away date and unrelated amount/description → no candidate.
      ledgerTxns: [
        { journalLineId: "jl-x", date: "2026-06-01", amount: -7, description: "UNRELATED" },
      ],
    });
    expect(result.blocksBuilt).toBe(0);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("batches at 20 statement lines per model call", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => line(`l${i}`));
    const ledger = lines.map((l) => ledgerFor(l.id.replace("l", "")));
    // Give each line a same-amount candidate so every line blocks.
    const ledgerTxns = lines.map((l, i) => ({
      journalLineId: `jl-${i}`,
      date: "2026-01-09",
      amount: -100,
      description: l.description,
    }));
    void ledger;

    await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: lines,
      ledgerTxns,
    });

    expect(aiCompleteMock).toHaveBeenCalledTimes(2);
    expect(aiCompleteMock.mock.calls[0][0].input.blocks).toHaveLength(20);
    expect(aiCompleteMock.mock.calls[1][0].input.blocks).toHaveLength(5);
  });

  it("passes the batch's own candidates as the grounding set", async () => {
    await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: [line("a")],
      ledgerTxns: [ledgerFor("a"), ledgerFor("b")],
    });

    const persistArgs = persistMock.mock.calls[0][1];
    const grounded = persistArgs.candidatesByLine.get("a");
    expect(grounded.has("jl-a")).toBe(true);
    expect(grounded.has("jl-b")).toBe(true);
    expect(grounded.has("jl-not-offered")).toBe(false);
  });

  it("degrades gracefully when the model output fails validation", async () => {
    aiCompleteMock.mockResolvedValue({
      ok: false,
      needsReview: true,
      invocationId: "inv-bad",
      issues: ["decisions: Required"],
    });

    const result = await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: [line("a")],
      ledgerTxns: [ledgerFor("a")],
    });

    expect(result.degraded).toBe(true);
    expect(result.suggestionsInserted).toBe(0);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("records invocation ids for provenance", async () => {
    const result = await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: [line("a")],
      ledgerTxns: [ledgerFor("a")],
    });
    expect(result.invocationIds).toEqual(["inv-1"]);
  });

  it("supplies alias hints to blocking when a party name is known", async () => {
    lookupAliasesMock.mockResolvedValue(new Map([["VENDOR A", "party-1"]]));

    await runMatchAssist(db, {
      orgId: "org-1",
      reconciliationId: "rec-1",
      statementLines: [line("a")],
      ledgerTxns: [
        {
          journalLineId: "jl-alias",
          date: "2026-01-09",
          amount: -55,
          description: "MISC",
          partyName: "Acme Co",
        },
      ],
      partyNameById: new Map([["party-1", "Acme Co"]]),
    });

    // The alias hint is what made this otherwise-unrelated candidate block.
    expect(aiCompleteMock).toHaveBeenCalled();
    const block = aiCompleteMock.mock.calls[0][0].input.blocks[0];
    expect(block.candidates[0].aliasMatch).toBe(true);
  });
});
