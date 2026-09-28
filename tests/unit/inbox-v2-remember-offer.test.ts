import { describe, expect, it } from "vitest";
import { correctionChangesAnswer } from "../../src/components/inbox-v2/remember-offer";

/**
 * The Inbox v2 pane offers "Remember this?" only after a save that changed the draft's answer —
 * its accounts, counterparty, or kind of paper — never after one that kept it.
 */

const OFFICE = "office";
const COMPUTERS = "computers";
const BANK = "bank";

const before = {
  lines: [
    { accountId: OFFICE, originalDebit: "42.10000000" },
    { accountId: BANK, originalDebit: null },
  ],
  partyId: "vendor-1",
  economicEventClass: "purchase",
};

const line = (accountId: string, side: "debit" | "credit", amount = "42.1") => ({
  accountId,
  debit: side === "debit" ? amount : null,
  credit: side === "credit" ? amount : null,
  lineDescription: null,
  departmentId: null,
  locationId: null,
});

describe("correctionChangesAnswer", () => {
  it("is false for the same accounts, party and kind, in any order and at any amount", () => {
    expect(
      correctionChangesAnswer(before, {
        lines: [line(BANK, "credit", "40"), line(OFFICE, "debit", "40")],
        partyId: "vendor-1",
      }),
    ).toBe(false);
    expect(
      correctionChangesAnswer(before, {
        lines: [line(OFFICE, "debit"), line(BANK, "credit")],
        partyId: "vendor-1",
        economicEventClass: "purchase",
      }),
    ).toBe(false);
  });

  it("is true for another account, a moved side, or an extra line", () => {
    expect(
      correctionChangesAnswer(before, {
        lines: [line(COMPUTERS, "debit"), line(BANK, "credit")],
        partyId: "vendor-1",
      }),
    ).toBe(true);
    expect(
      correctionChangesAnswer(before, {
        lines: [line(OFFICE, "credit"), line(BANK, "debit")],
        partyId: "vendor-1",
      }),
    ).toBe(true);
    expect(
      correctionChangesAnswer(before, {
        lines: [line(OFFICE, "debit", "40"), line(COMPUTERS, "debit", "2.1"), line(BANK, "credit")],
        partyId: "vendor-1",
      }),
    ).toBe(true);
  });

  it("is true for another party or another kind of paper", () => {
    const lines = [line(OFFICE, "debit"), line(BANK, "credit")];
    expect(correctionChangesAnswer(before, { lines, partyId: "vendor-2" })).toBe(true);
    expect(correctionChangesAnswer(before, { lines, partyId: null })).toBe(true);
    expect(
      correctionChangesAnswer(before, {
        lines,
        partyId: "vendor-1",
        economicEventClass: "bill_accrual",
      }),
    ).toBe(true);
  });

  it("treats a draft still waiting for its accounts as changed once they are chosen", () => {
    expect(
      correctionChangesAnswer(
        {
          lines: [
            { accountId: null, originalDebit: "42.10000000" },
            { accountId: null, originalDebit: null },
          ],
          partyId: null,
          economicEventClass: "purchase",
        },
        { lines: [line(OFFICE, "debit"), line(BANK, "credit")], partyId: null },
      ),
    ).toBe(true);
  });
});
