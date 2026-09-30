import { describe, expect, it, vi } from "vitest";

// The feedback module imports the database module; nothing here opens a connection.
vi.mock("@/db", () => ({ db: {}, dbAdmin: {} }));

import { compareWithProposal } from "@/lib/inbox/jev-approval/feedback";
import { proposalAnswerOf, type JevEntrySnapshot } from "@/lib/inbox/jev-approval/proposal";

const OFFICE = "11111111-1111-4111-8111-111111111111";
const HARDWARE = "22222222-2222-4222-8222-222222222222";
const BANK = "44444444-4444-4444-8444-444444444444";
const CARD = "66666666-6666-4666-8666-666666666666";
const VENDOR = "55555555-5555-4555-8555-555555555555";

function proposal(overrides: Partial<JevEntrySnapshot> = {}): JevEntrySnapshot {
  return {
    transactionDate: "2026-08-03",
    currency: "USD",
    partyId: VENDOR,
    lines: [
      { accountId: OFFICE, debit: "42.10", credit: null },
      { accountId: BANK, debit: null, credit: "42.10" },
    ],
    ...overrides,
  };
}

describe("compareWithProposal", () => {
  it("accepts the same entry, whatever the line order or trailing zeros", () => {
    const decided = proposal({
      lines: [
        { accountId: BANK, debit: null, credit: "42.10000000" },
        { accountId: OFFICE, debit: "42.1", credit: null },
      ],
    });
    expect(compareWithProposal(proposal(), decided)).toEqual({ same: true, changes: {} });
  });

  it("flags a changed category, amount, side, date, currency or party", () => {
    const cases: Array<[string, JevEntrySnapshot, string]> = [
      [
        "category",
        proposal({
          lines: [
            { accountId: HARDWARE, debit: "42.10", credit: null },
            { accountId: BANK, debit: null, credit: "42.10" },
          ],
        }),
        "lines",
      ],
      [
        "amount",
        proposal({
          lines: [
            { accountId: OFFICE, debit: "42.11", credit: null },
            { accountId: BANK, debit: null, credit: "42.11" },
          ],
        }),
        "lines",
      ],
      [
        "side",
        proposal({
          lines: [
            { accountId: OFFICE, debit: null, credit: "42.10" },
            { accountId: BANK, debit: "42.10", credit: null },
          ],
        }),
        "lines",
      ],
      ["date", proposal({ transactionDate: "2026-08-04" }), "transactionDate"],
      ["currency", proposal({ currency: "EUR" }), "currency"],
      ["party", proposal({ partyId: "77777777-7777-4777-8777-777777777777" }), "partyId"],
    ];
    for (const [label, decided, field] of cases) {
      const result = compareWithProposal(proposal(), decided);
      expect(result.same, label).toBe(false);
      expect(Object.keys(result.changes), label).toEqual([field]);
    }
  });

  it("counts a split line as a change", () => {
    const decided = proposal({
      lines: [
        { accountId: OFFICE, debit: "40.00", credit: null },
        { accountId: OFFICE, debit: "2.10", credit: null },
        { accountId: BANK, debit: null, credit: "42.10" },
      ],
    });
    expect(compareWithProposal(proposal(), decided).same).toBe(false);
  });

  it("ignores what the proposal left blank: an unpicked payment side and no party", () => {
    const blank = proposal({
      partyId: null,
      lines: [
        { accountId: OFFICE, debit: "42.10", credit: null },
        { accountId: null, debit: null, credit: "42.10" },
      ],
    });
    const decided = proposal({
      lines: [
        { accountId: OFFICE, debit: "42.10", credit: null },
        { accountId: CARD, debit: null, credit: "42.10" },
      ],
    });
    expect(compareWithProposal(blank, decided).same).toBe(true);
    // A blank line still pins its side and amount.
    const moved = proposal({
      lines: [
        { accountId: OFFICE, debit: "42.10", credit: null },
        { accountId: CARD, debit: null, credit: "42.00" },
      ],
    });
    expect(compareWithProposal(blank, moved).same).toBe(false);
  });
});

describe("proposalAnswerOf", () => {
  const picked = (confidence: unknown) => ({
    accountId: OFFICE,
    predictionEvidence: { source: "inbox_classification", outcome: "picked", confidence },
  });

  it("is null for a draft nobody answered: typed, unsure, or no fit", () => {
    expect(proposalAnswerOf([{ accountId: OFFICE, predictionEvidence: null }], null)).toBeNull();
    expect(
      proposalAnswerOf(
        [
          {
            accountId: OFFICE,
            predictionEvidence: { source: "inbox_classification", outcome: "no_fit" },
          },
          {
            accountId: null,
            predictionEvidence: {
              source: "inbox_classification",
              outcome: "low_confidence",
              confidence: 0.6,
            },
          },
        ],
        null,
      ),
    ).toBeNull();
  });

  it("takes the weakest answer, including a model-picked counterparty", () => {
    expect(proposalAnswerOf([picked(0.97), picked(0.91)], null)).toEqual({
      source: "jev",
      confidence: 0.91,
    });
    expect(proposalAnswerOf([picked(0.97)], { modelConfidence: 0.88 })).toEqual({
      source: "jev",
      confidence: 0.88,
    });
  });

  it("gives no confidence when a Jev answer carries none it can read", () => {
    expect(proposalAnswerOf([picked(0.97), picked("0.9")], null)).toEqual({
      source: "jev",
      confidence: null,
    });
  });

  it("treats a remembered answer as certain unless it says otherwise", () => {
    const remembered = { accountId: BANK, predictionEvidence: { source: "memory" } };
    expect(proposalAnswerOf([remembered], null)).toEqual({ source: "memory", confidence: 1 });
    expect(proposalAnswerOf([picked(0.96), remembered], null)).toEqual({
      source: "jev",
      confidence: 0.96,
    });
  });
});
