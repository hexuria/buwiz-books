import { describe, expect, it } from "vitest";
import {
  accountSignature,
  applicationKey,
  applyMemoryAnswer,
  buildMemoryAnswer,
  departsFromApplication,
  memoryAnswerFromColumns,
  memoryAnswerLineSchema,
  memoryAnswerSchema,
  memoryApplicationSchema,
  memoryDirection,
  memoryDraftSchema,
  possibleEntryDirections,
  type AnswerAccount,
  type MemoryAnswer,
} from "../../src/lib/inbox/memory/answer";
import { replayMemoryLock } from "../../src/lib/inbox/memory/lock";

/**
 * A memory answer is what a person settled a paper as. Replay never invents a
 * number: one line per side takes the new draft's total; a split replays its
 * exact amounts, and only onto a draft of exactly that total.
 */

const OFFICE = "11111111-1111-4111-8111-111111111111";
const POSTAGE = "22222222-2222-4222-8222-222222222222";
const BANK = "33333333-3333-4333-8333-333333333333";
const AP = "44444444-4444-4444-8444-444444444444";
const UNCATEGORIZED = "55555555-5555-4555-8555-555555555555";
const PARENT = "66666666-6666-4666-8666-666666666666";
const VENDOR = "77777777-7777-4777-8777-777777777777";

const ACCOUNTS = new Map<string, AnswerAccount>([
  [
    OFFICE,
    {
      id: OFFICE,
      accountType: "expense",
      subtype: "supplies_and_materials",
      isActive: true,
      isLeaf: true,
    },
  ],
  [
    POSTAGE,
    {
      id: POSTAGE,
      accountType: "expense",
      subtype: "general_operations",
      isActive: true,
      isLeaf: true,
    },
  ],
  [
    BANK,
    { id: BANK, accountType: "asset", subtype: "bank_accounts", isActive: true, isLeaf: true },
  ],
  [
    AP,
    { id: AP, accountType: "liability", subtype: "accounts_payable", isActive: true, isLeaf: true },
  ],
  [
    UNCATEGORIZED,
    {
      id: UNCATEGORIZED,
      accountType: "expense",
      subtype: "uncategorized_expenses",
      isActive: true,
      isLeaf: true,
    },
  ],
  [PARENT, { id: PARENT, accountType: "expense", subtype: null, isActive: true, isLeaf: false }],
]);

const line = (
  accountId: string | null,
  side: "debit" | "credit",
  amount: string,
  currency = "USD",
) => ({
  accountId,
  originalDebit: side === "debit" ? amount : null,
  originalCredit: side === "credit" ? amount : null,
  originalCurrency: currency,
});

function built(input: Parameters<typeof buildMemoryAnswer>[0]): MemoryAnswer {
  const result = buildMemoryAnswer(input);
  if (!result.ok) throw new Error(result.message);
  return result.answer;
}

const RECEIPT: MemoryAnswer = built({
  docKind: "purchase",
  partyId: VENDOR,
  lines: [line(OFFICE, "debit", "84.25"), line(BANK, "credit", "84.25")],
  accounts: ACCOUNTS,
});

describe("buildMemoryAnswer", () => {
  it("records each line's side, position, account type and exact amount", () => {
    expect(RECEIPT).toEqual({
      docKind: "purchase",
      partyId: VENDOR,
      lines: [
        {
          lineMatch: { side: "debit", index: 0 },
          accountId: OFFICE,
          accountType: "expense",
          amount: "84.25",
          currency: "USD",
          taxCode: null,
        },
        {
          lineMatch: { side: "credit", index: 0 },
          accountId: BANK,
          accountType: "asset",
          amount: "84.25",
          currency: "USD",
          taxCode: null,
        },
      ],
    });
  });

  it("numbers split lines per side, in order", () => {
    const answer = built({
      docKind: "purchase",
      partyId: null,
      lines: [
        line(OFFICE, "debit", "60.00"),
        line(BANK, "credit", "84.25"),
        line(POSTAGE, "debit", "24.25000000"),
      ],
      accounts: ACCOUNTS,
    });
    expect(answer.lines.map((entry) => [entry.lineMatch, entry.amount])).toEqual([
      [{ side: "debit", index: 0 }, "60"],
      [{ side: "credit", index: 0 }, "84.25"],
      [{ side: "debit", index: 1 }, "24.25"],
    ]);
  });

  it.each([
    [
      "an unselected line",
      { lines: [line(null, "debit", "10"), line(BANK, "credit", "10")] },
      "line_uncategorized",
    ],
    [
      "an Uncategorized bucket",
      { lines: [line(UNCATEGORIZED, "debit", "10"), line(BANK, "credit", "10")] },
      "line_uncategorized",
    ],
    [
      "a parent account",
      { lines: [line(PARENT, "debit", "10"), line(BANK, "credit", "10")] },
      "account_not_postable",
    ],
    [
      "an account from elsewhere",
      {
        lines: [
          line("99999999-9999-4999-8999-999999999999", "debit", "10"),
          line(BANK, "credit", "10"),
        ],
      },
      "account_not_postable",
    ],
    [
      "a one-sided entry",
      { lines: [line(OFFICE, "debit", "10"), line(POSTAGE, "debit", "10")] },
      "one_sided",
    ],
    [
      "an unbalanced entry",
      { lines: [line(OFFICE, "debit", "10"), line(BANK, "credit", "10.01")] },
      "unbalanced",
    ],
    [
      "a zero amount",
      { lines: [line(OFFICE, "debit", "0"), line(BANK, "credit", "0")] },
      "line_amount_invalid",
    ],
    ["a single line", { lines: [line(OFFICE, "debit", "10")] }, "too_few_lines"],
    [
      'a paper of kind "other"',
      {
        docKind: "other",
        lines: [line(OFFICE, "debit", "10"), line(BANK, "credit", "10")],
      },
      "doc_kind_unknown",
    ],
  ])("refuses %s", (_label, overrides, problem) => {
    const result = buildMemoryAnswer({
      docKind: "purchase",
      partyId: null,
      accounts: ACCOUNTS,
      ...overrides,
    } as Parameters<typeof buildMemoryAnswer>[0]);
    expect(result).toMatchObject({ ok: false, problem });
  });

  it("round-trips through the stored columns", () => {
    expect(
      memoryAnswerFromColumns({
        answerDocKind: RECEIPT.docKind,
        answerPartyId: RECEIPT.partyId,
        answerLines: JSON.parse(JSON.stringify(RECEIPT.lines)),
      }),
    ).toEqual(RECEIPT);
    expect(
      memoryAnswerFromColumns({ answerDocKind: "purchase", answerPartyId: null, answerLines: [] }),
    ).toBeNull();
    expect(
      memoryAnswerFromColumns({
        answerDocKind: "other",
        answerPartyId: null,
        answerLines: RECEIPT.lines,
      }),
    ).toBeNull();
  });
});

describe("memoryDirection", () => {
  it("books each kind of paper the way the ledger does", () => {
    expect(memoryDirection("purchase")).toBe("outflow");
    expect(memoryDirection("bill_accrual")).toBe("outflow");
    expect(memoryDirection("payroll")).toBe("outflow");
    expect(memoryDirection("sale")).toBe("inflow");
    expect(memoryDirection("invoice_payment")).toBe("inflow");
    expect(memoryDirection("transfer")).toBe("neutral");
    expect(memoryDirection("other")).toBeNull();
    expect(memoryDirection(null)).toBeNull();
  });
});

describe("applyMemoryAnswer", () => {
  it("gives one line per side the new paper's total", () => {
    const result = applyMemoryAnswer(RECEIPT, {
      direction: "outflow",
      total: "120.10",
      currency: "USD",
    });
    expect(result).toEqual({
      ok: true,
      application: {
        docKind: "purchase",
        partyId: VENDOR,
        lines: [
          { side: "debit", accountId: OFFICE, amount: "120.1" },
          { side: "credit", accountId: BANK, amount: "120.1" },
        ],
      },
    });
  });

  const SPLIT = built({
    docKind: "purchase",
    partyId: null,
    lines: [
      line(POSTAGE, "debit", "24.25"),
      line(OFFICE, "debit", "60"),
      line(BANK, "credit", "84.25"),
    ],
    accounts: ACCOUNTS,
  });

  it("replays a split's exact amounts onto a paper of exactly that total", () => {
    const result = applyMemoryAnswer(SPLIT, {
      direction: "outflow",
      total: "84.250",
      currency: "usd",
    });
    expect(result).toMatchObject({
      ok: true,
      application: {
        lines: [
          { side: "debit", accountId: POSTAGE, amount: "24.25" },
          { side: "debit", accountId: OFFICE, amount: "60" },
          { side: "credit", accountId: BANK, amount: "84.25" },
        ],
      },
    });
  });

  it("never guesses a split's proportions for another total", () => {
    expect(
      applyMemoryAnswer(SPLIT, { direction: "outflow", total: "84.26", currency: "USD" }),
    ).toEqual({ ok: false, reason: "split_amounts_differ" });
    expect(
      applyMemoryAnswer(SPLIT, { direction: "outflow", total: "84.25", currency: "EUR" }),
    ).toEqual({ ok: false, reason: "currency_differs" });
  });

  it("never replays a one-line answer onto a paper in another currency", () => {
    // The remembered bank account is a USD account; a EUR paper must not land there.
    expect(
      applyMemoryAnswer(RECEIPT, { direction: "outflow", total: "120.10", currency: "EUR" }),
    ).toEqual({ ok: false, reason: "currency_differs" });
  });

  it("never flips money the other way", () => {
    expect(
      applyMemoryAnswer(RECEIPT, { direction: "inflow", total: "84.25", currency: "USD" }),
    ).toEqual({ ok: false, reason: "direction_mismatch" });
  });

  it("always balances: both sides sum to the draft total", () => {
    for (const total of ["0.01", "84.25", "1000000.12345678"]) {
      const result = applyMemoryAnswer(RECEIPT, { direction: "outflow", total, currency: "USD" });
      if (!result.ok) throw new Error(result.reason);
      const debits = result.application.lines.filter((entry) => entry.side === "debit");
      const credits = result.application.lines.filter((entry) => entry.side === "credit");
      expect(debits.map((entry) => entry.amount)).toEqual(credits.map((entry) => entry.amount));
    }
  });

  it("gives equal answers equal keys, whatever the amount spelling", () => {
    const a = applyMemoryAnswer(RECEIPT, { direction: "outflow", total: "84.25", currency: "USD" });
    const b = applyMemoryAnswer(RECEIPT, {
      direction: "outflow",
      total: "84.25000000",
      currency: "USD",
    });
    if (!a.ok || !b.ok) throw new Error("replay failed");
    expect(applicationKey(a.application)).toBe(applicationKey(b.application));
    const other = applyMemoryAnswer(
      {
        ...RECEIPT,
        lines: RECEIPT.lines.map((entry) => ({
          ...entry,
          accountId: entry.accountId === OFFICE ? POSTAGE : entry.accountId,
        })),
      },
      { direction: "outflow", total: "84.25", currency: "USD" },
    );
    if (!other.ok) throw new Error("replay failed");
    expect(applicationKey(other.application)).not.toBe(applicationKey(a.application));
  });
});

describe("departsFromApplication", () => {
  const applied = applyMemoryAnswer(RECEIPT, {
    direction: "outflow",
    total: "84.25",
    currency: "USD",
  });
  if (!applied.ok) throw new Error("replay failed");
  const application = applied.application;
  const settled = {
    docKind: "purchase",
    partyId: VENDOR,
    lines: [
      { side: "credit" as const, accountId: BANK },
      { side: "debit" as const, accountId: OFFICE },
    ],
  };

  it("is not an undo to keep the accounts, party and kind (in any line order)", () => {
    expect(departsFromApplication(application, settled)).toBe(false);
  });

  it("is an undo to change an account, the party the memory set, or the kind", () => {
    expect(
      departsFromApplication(application, {
        ...settled,
        lines: [
          { side: "debit", accountId: POSTAGE },
          { side: "credit", accountId: BANK },
        ],
      }),
    ).toBe(true);
    expect(departsFromApplication(application, { ...settled, partyId: null })).toBe(true);
    expect(departsFromApplication(application, { ...settled, docKind: "bill_accrual" })).toBe(true);
    expect(
      departsFromApplication(application, {
        ...settled,
        lines: [...settled.lines, { side: "debit", accountId: POSTAGE }],
      }),
    ).toBe(true);
  });

  it("ignores the party when the memory set none", () => {
    expect(
      departsFromApplication({ ...application, partyId: null }, { ...settled, partyId: VENDOR }),
    ).toBe(false);
  });

  it("orders accounts per side for the signature", () => {
    expect(
      accountSignature([
        { side: "debit", accountId: "b" },
        { side: "credit", accountId: "a" },
        { side: "debit", accountId: null },
      ]),
    ).toBe("credit:a,debit:-,debit:b");
  });
});

describe("possibleEntryDirections", () => {
  it("reads an expense debit as money out and an income credit as money in", () => {
    expect(
      possibleEntryDirections([
        { side: "debit", accountType: "expense" },
        { side: "credit", accountType: "asset" },
      ]),
    ).toEqual(["outflow"]);
    expect(
      possibleEntryDirections([
        { side: "debit", accountType: "asset" },
        { side: "credit", accountType: "revenue" },
      ]),
    ).toEqual(["inflow"]);
  });

  it("leaves every direction open for a balance-sheet-only entry", () => {
    expect(
      possibleEntryDirections([
        { side: "debit", accountType: "asset" },
        { side: "credit", accountType: "asset" },
      ]),
    ).toEqual(["outflow", "inflow", "neutral"]);
  });

  it("offers none for a mixed entry", () => {
    expect(
      possibleEntryDirections([
        { side: "debit", accountType: "expense" },
        { side: "credit", accountType: "revenue" },
      ]),
    ).toEqual([]);
  });
});

// Stored answers, eval cases and export files are read through these schemas. A malformed amount
// must make them fail validation — the value is then skipped — never throw out of safeParse and
// take the reader down with it (the positivity check parses the amount, and Zod runs a schema's
// checks after one fails unless the failing one aborts).
describe("amount validation never throws", () => {
  const MALFORMED = [
    "1e3",
    "-49.99",
    "49.999999999",
    " 12",
    "12.",
    ".5",
    "0x10",
    "NaN",
    "",
    "1,000",
  ];
  const answerLine = RECEIPT.lines[0];

  it("fails an answer line, an answer, a draft and an application on a malformed amount", () => {
    for (const amount of MALFORMED) {
      expect(() => memoryAnswerLineSchema.safeParse({ ...answerLine, amount })).not.toThrow();
      expect(memoryAnswerLineSchema.safeParse({ ...answerLine, amount }).success, amount).toBe(
        false,
      );
      expect(
        memoryAnswerSchema.safeParse({
          ...RECEIPT,
          lines: [{ ...answerLine, amount }, RECEIPT.lines[1]],
        }).success,
        amount,
      ).toBe(false);
      expect(
        memoryDraftSchema.safeParse({ direction: "outflow", total: amount, currency: "USD" })
          .success,
        amount,
      ).toBe(false);
      expect(
        memoryApplicationSchema.safeParse({
          docKind: "purchase",
          partyId: null,
          lines: [
            { side: "debit", accountId: OFFICE, amount },
            { side: "credit", accountId: BANK, amount: "84.25" },
          ],
        }).success,
        amount,
      ).toBe(false);
    }
  });

  it("still refuses a well-formed zero as not positive, with its own message", () => {
    const result = memoryAnswerLineSchema.safeParse({ ...answerLine, amount: "0.00" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "must be greater than zero",
    ]);
  });

  it("reads a stored row with a malformed amount as no answer", () => {
    const stored = { ...answerLine, amount: "1e3" };
    expect(() =>
      memoryAnswerFromColumns({
        answerDocKind: "purchase",
        answerPartyId: VENDOR,
        answerLines: [stored, RECEIPT.lines[1]],
      }),
    ).not.toThrow();
    expect(
      memoryAnswerFromColumns({
        answerDocKind: "purchase",
        answerPartyId: VENDOR,
        answerLines: [stored, RECEIPT.lines[1]],
      }),
    ).toBeNull();
  });

  it("reports a lock case with a malformed amount as malformed instead of throwing", () => {
    const replay = replayMemoryLock({
      task: "inbox_memory",
      provenance: "authored",
      inputRef: {
        version: 1,
        memory: {
          id: "memory-1",
          matchKind: "party",
          matchKeyDigest: "a".repeat(64),
          answer: { ...RECEIPT, lines: [{ ...answerLine, amount: "1e3" }, RECEIPT.lines[1]] },
        },
        paper: { direction: "outflow", total: "84.25", currency: "USD" },
      },
      expected: { docKind: "purchase", partyId: VENDOR, lines: [] },
    });
    expect(replay.passed).toBe(false);
    if (!replay.passed) expect(replay.reason).toMatch(/^malformed case: /);
  });
});
