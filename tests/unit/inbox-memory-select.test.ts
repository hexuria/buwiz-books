import { describe, expect, it } from "vitest";
import type { MemoryAnswer, MemoryDraft } from "../../src/lib/inbox/memory/answer";
import { emptyPaperKeys, type PaperKeys } from "../../src/lib/inbox/memory/keys";
import {
  sameMemoryDecision,
  selectMemory,
  validateMemoryAnswer,
  type MemoryCandidate,
  type MemoryChartAccount,
  type MemoryParty,
  type MemoryValidationContext,
} from "../../src/lib/inbox/memory/select";

/**
 * Which memory answers a paper: the most specific kind with a usable memory.
 * Same-specificity memories that disagree apply nothing (a conflict); a memory
 * that fails the checks a model's pick must pass is a reported miss.
 */

const OFFICE = "11111111-1111-4111-8111-111111111111";
const POSTAGE = "22222222-2222-4222-8222-222222222222";
const BANK = "33333333-3333-4333-8333-333333333333";
const VENDOR = "77777777-7777-4777-8777-777777777777";
const CUSTOMER = "88888888-8888-4888-8888-888888888888";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function chart(overrides: Partial<Record<string, Partial<MemoryChartAccount>>> = {}) {
  const base: MemoryChartAccount[] = [
    {
      id: OFFICE,
      accountType: "expense",
      subtype: "supplies_and_materials",
      isActive: true,
      isLeaf: true,
    },
    {
      id: POSTAGE,
      accountType: "expense",
      subtype: "general_operations",
      isActive: true,
      isLeaf: true,
    },
    { id: BANK, accountType: "asset", subtype: "bank_accounts", isActive: true, isLeaf: true },
  ];
  return new Map(base.map((account) => [account.id, { ...account, ...overrides[account.id] }]));
}

function partiesMap(overrides: Partial<MemoryParty>[] = []) {
  const base: MemoryParty[] = [
    { id: VENDOR, partyType: "vendor", isActive: true },
    { id: CUSTOMER, partyType: "customer", isActive: true },
  ];
  return new Map(
    base.map((party) => [
      party.id,
      { ...party, ...overrides.find((override) => override.id === party.id) },
    ]),
  );
}

function context(overrides: Partial<MemoryValidationContext> = {}): MemoryValidationContext {
  return {
    accounts: chart(),
    parties: partiesMap(),
    paperEventClass: "purchase",
    paperReviewerEditable: true,
    ...overrides,
  };
}

function answer(category: string, overrides: Partial<MemoryAnswer> = {}): MemoryAnswer {
  return {
    docKind: "purchase",
    partyId: VENDOR,
    lines: [
      {
        lineMatch: { side: "debit", index: 0 },
        accountId: category,
        accountType: "expense",
        amount: "10",
        currency: "USD",
        taxCode: null,
      },
      {
        lineMatch: { side: "credit", index: 0 },
        accountId: BANK,
        accountType: "asset",
        amount: "10",
        currency: "USD",
        taxCode: null,
      },
    ],
    ...overrides,
  };
}

let sequence = 0;
function memory(
  matchKind: MemoryCandidate["matchKind"],
  matchKey: string,
  value: MemoryAnswer | null,
  overrides: Partial<MemoryCandidate> = {},
): MemoryCandidate {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    matchKind,
    matchKey,
    enabled: true,
    answer: value,
    ...overrides,
  };
}

const DRAFT: MemoryDraft = { direction: "outflow", total: "84.25", currency: "USD" };

function keys(overrides: Partial<PaperKeys> = {}): PaperKeys {
  return {
    ...emptyPaperKeys(),
    file_hash: [HASH_A],
    sender_party: ["billing@acme.test|"],
    party: [VENDOR],
    line_text: ["PAPER PRINTER"],
    ...overrides,
  };
}

describe("selectMemory — specificity", () => {
  it("lets the most specific kind answer", () => {
    const words = memory("line_text", "PAPER PRINTER", answer(POSTAGE));
    const file = memory("file_hash", HASH_A, answer(OFFICE));
    const sender = memory("sender_party", "billing@acme.test|", answer(POSTAGE));
    const decision = selectMemory({
      memories: [words, sender, file],
      keys: keys(),
      draft: DRAFT,
      validation: context(),
    });
    expect(decision).toMatchObject({ kind: "hit", matchKind: "file_hash", memoryIds: [file.id] });
    if (decision.kind !== "hit") throw new Error("expected a hit");
    expect(decision.application.lines).toEqual([
      { side: "debit", accountId: OFFICE, amount: "84.25" },
      { side: "credit", accountId: BANK, amount: "84.25" },
    ]);
  });

  it("walks down to sender, party, then words", () => {
    const sender = memory("sender_party", "billing@acme.test|", answer(OFFICE));
    const party = memory("party", VENDOR, answer(POSTAGE));
    const words = memory("line_text", "PAPER PRINTER", answer(POSTAGE));
    const onlyBelowFile = { memories: [words, party, sender], draft: DRAFT, validation: context() };
    expect(selectMemory({ ...onlyBelowFile, keys: keys() })).toMatchObject({
      matchKind: "sender_party",
    });
    expect(selectMemory({ ...onlyBelowFile, keys: keys({ sender_party: [] }) })).toMatchObject({
      matchKind: "party",
    });
    expect(
      selectMemory({ ...onlyBelowFile, keys: keys({ sender_party: [], party: [] }) }),
    ).toMatchObject({ matchKind: "line_text" });
  });

  it("only matches a memory under the paper's own key", () => {
    const decision = selectMemory({
      memories: [memory("file_hash", HASH_B, answer(OFFICE))],
      keys: keys(),
      draft: DRAFT,
      validation: context(),
    });
    expect(decision).toEqual({ kind: "miss", rejected: [] });
  });

  it("ignores a memory that is turned off", () => {
    const off = memory("file_hash", HASH_A, answer(OFFICE), { enabled: false });
    const words = memory("line_text", "PAPER PRINTER", answer(POSTAGE));
    expect(
      selectMemory({ memories: [off, words], keys: keys(), draft: DRAFT, validation: context() }),
    ).toMatchObject({ kind: "hit", matchKind: "line_text", memoryIds: [words.id] });
  });
});

describe("selectMemory — conflicts", () => {
  it("applies nothing when two memories of one specificity disagree", () => {
    const a = memory("file_hash", HASH_A, answer(OFFICE));
    const b = memory("file_hash", HASH_B, answer(POSTAGE));
    const words = memory("line_text", "PAPER PRINTER", answer(OFFICE));
    const decision = selectMemory({
      memories: [a, b, words],
      keys: keys({ file_hash: [HASH_A, HASH_B] }),
      draft: DRAFT,
      validation: context(),
    });
    expect(decision.kind).toBe("conflict");
    if (decision.kind !== "conflict") throw new Error("expected a conflict");
    // The less specific memory is not consulted: a conflict goes to a person.
    expect(decision.matchKind).toBe("file_hash");
    expect(decision.memoryIds).toEqual([a.id, b.id].sort());
    expect(decision.answers).toHaveLength(2);
  });

  it("treats memories that replay to the same answer as agreeing", () => {
    const a = memory("file_hash", HASH_A, answer(OFFICE));
    // A different remembered amount on a single line is the same replayed answer.
    const b = memory(
      "file_hash",
      HASH_B,
      answer(OFFICE, {
        lines: answer(OFFICE).lines.map((entry) => ({ ...entry, amount: "99" })),
      }),
    );
    const decision = selectMemory({
      memories: [a, b],
      keys: keys({ file_hash: [HASH_A, HASH_B] }),
      draft: DRAFT,
      validation: context(),
    });
    expect(decision).toMatchObject({ kind: "hit", memoryIds: [a.id, b.id].sort() });
  });

  it("disagrees over the party, too", () => {
    const a = memory("file_hash", HASH_A, answer(OFFICE));
    const b = memory("file_hash", HASH_B, answer(OFFICE, { partyId: null }));
    expect(
      selectMemory({
        memories: [a, b],
        keys: keys({ file_hash: [HASH_A, HASH_B] }),
        draft: DRAFT,
        validation: context(),
      }).kind,
    ).toBe("conflict");
  });

  it("does not let an unusable memory make a conflict", () => {
    const good = memory("file_hash", HASH_A, answer(OFFICE));
    const stale = memory("file_hash", HASH_B, answer(POSTAGE));
    const decision = selectMemory({
      memories: [good, stale],
      keys: keys({ file_hash: [HASH_A, HASH_B] }),
      draft: DRAFT,
      validation: context({ accounts: chart({ [POSTAGE]: { isActive: false } }) }),
    });
    expect(decision).toMatchObject({
      kind: "hit",
      memoryIds: [good.id],
      rejected: [{ memoryId: stale.id, matchKind: "file_hash", reason: "account_inactive" }],
    });
  });
});

describe("selectMemory — the same checks as a model's pick", () => {
  it("treats a failing memory as a miss, reports it, and falls through", () => {
    const file = memory("file_hash", HASH_A, answer(POSTAGE));
    const words = memory("line_text", "PAPER PRINTER", answer(OFFICE));
    const decision = selectMemory({
      memories: [file, words],
      keys: keys(),
      draft: DRAFT,
      validation: context({ accounts: chart({ [POSTAGE]: { isLeaf: false } }) }),
    });
    expect(decision).toMatchObject({
      kind: "hit",
      matchKind: "line_text",
      rejected: [{ memoryId: file.id, reason: "account_not_leaf" }],
    });
  });

  it("is a plain miss when every memory fails", () => {
    const file = memory("file_hash", HASH_A, null);
    expect(
      selectMemory({ memories: [file], keys: keys(), draft: DRAFT, validation: context() }),
    ).toEqual({
      kind: "miss",
      rejected: [{ memoryId: file.id, matchKind: "file_hash", reason: "answer_malformed" }],
    });
  });

  it("refuses money going the other way", () => {
    const file = memory("file_hash", HASH_A, answer(OFFICE));
    expect(
      selectMemory({
        memories: [file],
        keys: keys(),
        draft: { ...DRAFT, direction: "inflow" },
        validation: context(),
      }),
    ).toMatchObject({ kind: "miss", rejected: [{ reason: "direction_mismatch" }] });
  });
});

describe("validateMemoryAnswer", () => {
  const OTHER_ORG_ACCOUNT = "99999999-9999-4999-8999-999999999999";

  it.each([
    ["an account of another organization", answer(OTHER_ORG_ACCOUNT), context(), "account_missing"],
    [
      "an inactive account",
      answer(OFFICE),
      context({ accounts: chart({ [OFFICE]: { isActive: false } }) }),
      "account_inactive",
    ],
    [
      "an account that gained children",
      answer(OFFICE),
      context({ accounts: chart({ [OFFICE]: { isLeaf: false } }) }),
      "account_not_leaf",
    ],
    [
      "an account re-typed since it was remembered",
      answer(OFFICE),
      context({ accounts: chart({ [OFFICE]: { accountType: "asset" } }) }),
      "account_type_changed",
    ],
    [
      "an account turned into an Uncategorized bucket",
      answer(OFFICE),
      context({ accounts: chart({ [OFFICE]: { subtype: "uncategorized_expenses" } }) }),
      "account_uncategorized",
    ],
    [
      "a party of another organization",
      answer(OFFICE, { partyId: "12345678-1234-4234-8234-123456789012" }),
      context(),
      "party_missing",
    ],
    [
      "an inactive party",
      answer(OFFICE),
      context({ parties: partiesMap([{ id: VENDOR, isActive: false }]) }),
      "party_inactive",
    ],
    [
      "a customer on a purchase",
      answer(OFFICE, { partyId: CUSTOMER }),
      context(),
      "party_type_not_allowed",
    ],
    [
      "a counterparty on a transfer",
      answer(OFFICE, { docKind: "transfer" }),
      context({ paperEventClass: "transfer" }),
      "party_not_expected",
    ],
    [
      "a new kind of paper on a provider-owned source",
      answer(OFFICE, { docKind: "bill_accrual" }),
      context({ paperReviewerEditable: false }),
      "doc_kind_not_editable",
    ],
  ])("rejects %s", (_label, value, validation, reason) => {
    expect(validateMemoryAnswer(value, validation)).toEqual({ ok: false, reason });
  });

  it("accepts a new kind of paper where a reviewer could set it", () => {
    expect(validateMemoryAnswer(answer(OFFICE, { docKind: "bill_accrual" }), context())).toEqual({
      ok: true,
    });
  });

  it("accepts a memory that names no party", () => {
    expect(validateMemoryAnswer(answer(OFFICE, { partyId: null }), context())).toEqual({
      ok: true,
    });
  });
});

describe("sameMemoryDecision", () => {
  it("holds only for the same outcome, memories and answers", () => {
    const file = memory("file_hash", HASH_A, answer(OFFICE));
    const input = { memories: [file], keys: keys(), draft: DRAFT, validation: context() };
    const first = selectMemory(input);
    expect(sameMemoryDecision(first, selectMemory(input))).toBe(true);
    expect(
      sameMemoryDecision(
        first,
        selectMemory({ ...input, memories: [{ ...file, enabled: false }] }),
      ),
    ).toBe(false);
    expect(
      sameMemoryDecision(
        first,
        selectMemory({ ...input, memories: [{ ...file, answer: answer(POSTAGE) }] }),
      ),
    ).toBe(false);
    expect(sameMemoryDecision(first, null)).toBe(false);
  });
});
