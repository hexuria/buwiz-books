import { describe, expect, it } from "vitest";
import {
  amountForInput,
  billDraftToCorrection,
  candidateToBillEditorDraft,
  candidateToEditorDraft,
  candidateToTransactionEditorDraft,
  DraftError,
  parseAmountInput,
  transactionDraftToCorrection,
  type DraftSourceCandidate,
  type DraftSourceLine,
  type EditorDraft,
} from "../../src/components/inbox-v2/candidate-draft";

/**
 * The reading pane prefills an extracted editor from the candidate and turns the edited draft
 * back into the existing candidate correction. What goes back must be what a person would have
 * typed in that editor: exact decimal amounts, balanced to the last digit, nothing dropped.
 */

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const SUPPLIES = "22222222-2222-4222-8222-222222222222";
const PAYABLE = "33333333-3333-4333-8333-333333333333";
const BANK = "44444444-4444-4444-8444-444444444444";
const SAVINGS = "55555555-5555-4555-8555-555555555555";
const REVENUE = "66666666-6666-4666-8666-666666666666";
const VENDOR = "77777777-7777-4777-8777-777777777777";
const DEPT = "88888888-8888-4888-8888-888888888888";
const LOC = "99999999-9999-4999-8999-999999999999";

const USD = { originalCurrency: "USD", functionalCurrency: "USD", exchangeRate: "1.0000000000" };

function line(
  id: string,
  accountId: string | null,
  side: { debit?: string; credit?: string },
  extra: Partial<DraftSourceLine> = {},
): DraftSourceLine {
  return {
    id,
    accountId,
    originalDebit: side.debit ?? null,
    originalCredit: side.credit ?? null,
    lineDescription: null,
    departmentId: null,
    locationId: null,
    ...extra,
  };
}

function candidate(overrides: Partial<DraftSourceCandidate>): DraftSourceCandidate {
  return {
    transactionType: "journal",
    transactionDate: "2026-09-01",
    memo: "Office restock",
    referenceNumber: "INV-7",
    partyId: VENDOR,
    originalTotal: null,
    lines: [],
    ...overrides,
  };
}

function expectBill(draft: EditorDraft) {
  if (draft.editor !== "bill") throw new Error(`expected the Bills editor, got ${draft.editor}`);
  return draft;
}

function expectTransaction(draft: EditorDraft | null) {
  if (!draft || draft.editor !== "transaction") throw new Error("expected the transaction editor");
  return draft;
}

describe("amounts", () => {
  it("shows stored scale-8 decimals exactly, trimmed to two places", () => {
    expect(amountForInput("450.00000000")).toBe("450.00");
    expect(amountForInput("450.10000000")).toBe("450.10");
    expect(amountForInput("0.12345678")).toBe("0.12345678");
    expect(amountForInput("12345678901.5")).toBe("12345678901.50");
    expect(amountForInput(null)).toBe("");
  });

  it("parses typed amounts exactly and rejects anything that is not a plain positive number", () => {
    expect(parseAmountInput(" 120.50 ", "Line 1")).toBe("120.5");
    expect(parseAmountInput(".5", "Line 1")).toBe("0.5");
    expect(parseAmountInput("5.", "Line 1")).toBe("5");
    expect(parseAmountInput("", "Line 1")).toBeNull();
    expect(parseAmountInput("0.00", "Line 1")).toBeNull();
    for (const bad of ["-5", "1e3", "12,50", "abc"]) {
      expect(() => parseAmountInput(bad, "Line 2")).toThrow(/Line 2: enter the amount/);
    }
    expect(() => parseAmountInput("0.123456789", "Line 3")).toThrow(/at most 8 decimal places/);
  });
});

describe("vendor bills", () => {
  const billCandidate = candidate({
    lines: [
      line("l1", EXPENSE, { debit: "0.10000000" }, { lineDescription: "Pens", departmentId: DEPT }),
      line("l2", SUPPLIES, { debit: "0.20000000" }, { locationId: LOC }),
      line("l3", PAYABLE, { credit: "0.30000000" }, { lineDescription: "A/P: INV-7" }),
    ],
  });

  it("opens a bill's expense lines in the Bills editor and keeps its payable side", () => {
    const draft = expectBill(candidateToEditorDraft(billCandidate, "vendor_bill"));
    expect(draft.draft).toMatchObject({
      vendorId: VENDOR,
      billNumber: "INV-7",
      billDate: "2026-09-01",
      memo: "Office restock",
    });
    expect(draft.draft.lineItems).toEqual([
      {
        id: "l1",
        description: "Pens",
        amount: "0.10",
        accountId: EXPENSE,
        departmentId: DEPT,
        locationId: null,
      },
      {
        id: "l2",
        description: "",
        amount: "0.20",
        accountId: SUPPLIES,
        departmentId: null,
        locationId: LOC,
      },
    ]);
    expect(draft.creditLine).toEqual({
      accountId: PAYABLE,
      lineDescription: "A/P: INV-7",
      departmentId: null,
      locationId: null,
    });
  });

  it("round-trips an untouched bill to the same balanced accrual, exactly", () => {
    const draft = expectBill(candidateToEditorDraft(billCandidate, "vendor_bill"));
    const correction = billDraftToCorrection(draft.draft, {
      ...USD,
      creditLine: draft.creditLine,
      payableAccountId: "unused-because-the-bill-has-one",
    });
    expect(correction).toMatchObject({
      transactionType: "journal",
      economicEventClass: "bill_accrual",
      transactionDate: "2026-09-01",
      partyId: VENDOR,
      referenceNumber: "INV-7",
      originalCurrency: "USD",
      exchangeRate: "1",
    });
    expect(correction.lines).toEqual([
      {
        accountId: EXPENSE,
        debit: "0.1",
        credit: null,
        lineDescription: "Pens",
        departmentId: DEPT,
        locationId: null,
      },
      {
        accountId: SUPPLIES,
        debit: "0.2",
        credit: null,
        lineDescription: null,
        departmentId: null,
        locationId: LOC,
      },
      // 0.1 + 0.2 is 0.3 here, not 0.30000000000000004.
      {
        accountId: PAYABLE,
        debit: null,
        credit: "0.3",
        lineDescription: "A/P: INV-7",
        departmentId: null,
        locationId: null,
      },
    ]);
  });

  it("credits the mapped payable when the paper's credit side was never chosen", () => {
    const emailed = candidate({
      referenceNumber: null,
      lines: [
        line(
          "d",
          null,
          { debit: "98.40000000" },
          {
            lineDescription: "Debit account — reviewer selection required",
          },
        ),
        line(
          "c",
          null,
          { credit: "98.40000000" },
          {
            lineDescription: "Credit account — reviewer selection required",
          },
        ),
      ],
    });
    const draft = expectBill(candidateToEditorDraft(emailed, "vendor_bill"));
    expect(draft.draft.lineItems[0]).toMatchObject({ accountId: "", amount: "98.40" });
    // The placeholder's guidance text is not carried onto the posted payable line.
    expect(draft.creditLine).toMatchObject({ accountId: null, lineDescription: null });

    expect(() =>
      billDraftToCorrection(draft.draft, {
        ...USD,
        creditLine: draft.creditLine,
        payableAccountId: PAYABLE,
      }),
    ).toThrow("Line 1: choose a category.");

    const chosen = {
      ...draft.draft,
      lineItems: [{ ...draft.draft.lineItems[0], accountId: EXPENSE }],
    };
    const correction = billDraftToCorrection(chosen, {
      ...USD,
      creditLine: draft.creditLine,
      payableAccountId: PAYABLE,
    });
    expect(correction.lines.at(-1)).toEqual({
      accountId: PAYABLE,
      debit: null,
      credit: "98.4",
      lineDescription: "A/P: Bill",
      departmentId: null,
      locationId: null,
    });
  });

  it("starts an unread paper with one line for its total", () => {
    const draft = expectBill(
      candidateToEditorDraft(candidate({ originalTotal: "1250.00000000" }), "vendor_bill"),
    );
    expect(draft.draft.lineItems).toEqual([
      { id: "paper-total", description: "", amount: "1250.00", accountId: "" },
    ]);
    expect(draft.creditLine).toBeNull();
  });

  it("opens a bill that is not expense lines against one payable as a journal, losing nothing", () => {
    const odd = candidate({
      lines: [
        line("a", EXPENSE, { debit: "10.00000000" }),
        line("b", PAYABLE, { credit: "6.00000000" }),
        line("c", BANK, { credit: "4.00000000" }),
      ],
    });
    expect(candidateToBillEditorDraft(odd)).toBeNull();
    const draft = expectTransaction(candidateToEditorDraft(odd, "vendor_bill"));
    expect(draft.fallback).toBe("bill_shape");
    expect(draft.draft.type).toBe("journal");
    expect(
      draft.draft.journalLines.map((entry) => [entry.categoryId, entry.debit, entry.credit]),
    ).toEqual([
      [EXPENSE, "10.00", ""],
      [PAYABLE, "", "6.00"],
      [BANK, "", "4.00"],
    ]);
  });

  it("refuses a bill with no vendor, no priced line, or no payable to credit", () => {
    const draft = expectBill(candidateToEditorDraft(billCandidate, "vendor_bill"));
    const context = { ...USD, creditLine: null, payableAccountId: null };
    expect(() => billDraftToCorrection({ ...draft.draft, vendorId: "" }, context)).toThrow(
      "Choose the vendor for this bill.",
    );
    expect(() =>
      billDraftToCorrection(
        {
          ...draft.draft,
          lineItems: draft.draft.lineItems.map((item) => ({ ...item, amount: "" })),
        },
        { ...context, payableAccountId: PAYABLE },
      ),
    ).toThrow("Add at least one line with a category and an amount.");
    expect(() => billDraftToCorrection(draft.draft, context)).toThrow(DraftError);
    expect(() => billDraftToCorrection(draft.draft, context)).toThrow(
      /No Accounts Payable account/,
    );
  });

  it("re-points the payable side at mapped A/P when a paid expense is rebooked as a bill", () => {
    const paid = candidate({
      transactionType: "pay_out",
      lines: [
        line("e", EXPENSE, { debit: "64.00000000" }),
        line("b", BANK, { credit: "64.00000000" }, { lineDescription: "Paid by card" }),
      ],
    });
    // As a bill shape it keeps the card as the credit side...
    expect(candidateToBillEditorDraft(paid)).toMatchObject({
      creditLine: { accountId: BANK, lineDescription: "Paid by card" },
    });
    // ...but a reviewer who books it as a bill means a payable, not a card payment.
    const rebooked = expectBill(candidateToBillEditorDraft(paid, { rebook: true })!);
    expect(rebooked.creditLine).toMatchObject({ accountId: null, lineDescription: null });
    const correction = billDraftToCorrection(rebooked.draft, {
      ...USD,
      creditLine: rebooked.creditLine,
      payableAccountId: PAYABLE,
    });
    expect(correction.lines.at(-1)).toMatchObject({ accountId: PAYABLE, credit: "64" });
    expect(correction.economicEventClass).toBe("bill_accrual");
  });

  it("keeps a foreign-currency bill's captured rate", () => {
    const draft = expectBill(candidateToEditorDraft(billCandidate, "vendor_bill"));
    const correction = billDraftToCorrection(draft.draft, {
      originalCurrency: "EUR",
      functionalCurrency: "USD",
      exchangeRate: "1.0850000000",
      creditLine: draft.creditLine,
      payableAccountId: null,
    });
    expect(correction).toMatchObject({ originalCurrency: "EUR", exchangeRate: "1.0850000000" });
  });
});

describe("transactions", () => {
  it("opens a paid expense on Pay Out: the bank side is the one credit", () => {
    const paid = candidate({
      transactionType: "pay_out",
      lines: [
        line(
          "e1",
          EXPENSE,
          { debit: "40.00000000" },
          { lineDescription: "Paper", departmentId: DEPT },
        ),
        line("e2", SUPPLIES, { debit: "2.10000000" }, { locationId: LOC }),
        line("b", BANK, { credit: "42.10000000" }),
      ],
    });
    const draft = expectTransaction(candidateToEditorDraft(paid, "expense"));
    expect(draft.fallback).toBeNull();
    expect(draft.draft).toMatchObject({
      type: "pay_out",
      payCategoryId: BANK,
      payPartyId: VENDOR,
      payForLines: [
        {
          key: "e1",
          description: "Paper",
          categoryId: EXPENSE,
          departmentId: DEPT,
          amount: "40.00",
        },
        { key: "e2", description: "", categoryId: SUPPLIES, locationId: LOC, amount: "2.10" },
      ],
    });

    const correction = transactionDraftToCorrection(draft.draft, {
      ...USD,
      sourceReviewerEditable: false,
    });
    expect(correction.economicEventClass).toBeUndefined();
    expect(correction).toMatchObject({ transactionType: "pay_out", partyId: VENDOR });
    expect(correction.lines).toEqual([
      {
        accountId: BANK,
        debit: null,
        credit: "42.1",
        lineDescription: null,
        departmentId: null,
        locationId: null,
      },
      {
        accountId: EXPENSE,
        debit: "40",
        credit: null,
        lineDescription: "Paper",
        departmentId: DEPT,
        locationId: null,
      },
      {
        accountId: SUPPLIES,
        debit: "2.1",
        credit: null,
        lineDescription: null,
        departmentId: null,
        locationId: LOC,
      },
    ]);
  });

  it("opens money in on Pay In and lets a reviewer-editable paper reclassify by tab", () => {
    const received = candidate({
      transactionType: "pay_in",
      lines: [
        line("b", BANK, { debit: "300.00000000" }),
        line("r", REVENUE, { credit: "300.00000000" }),
      ],
    });
    const draft = expectTransaction(candidateToEditorDraft(received, "money_in"));
    expect(draft.draft).toMatchObject({ type: "pay_in", payCategoryId: BANK });
    const correction = transactionDraftToCorrection(draft.draft, {
      ...USD,
      sourceReviewerEditable: true,
    });
    expect(correction.economicEventClass).toBe("sale");
    expect(correction.lines.map((entry) => [entry.accountId, entry.debit, entry.credit])).toEqual([
      [BANK, "300", null],
      [REVENUE, null, "300"],
    ]);
  });

  it("opens a transfer on the Transfer tab", () => {
    const moved = candidate({
      transactionType: "transfer",
      partyId: null,
      lines: [
        line("to", SAVINGS, { debit: "500.00000000" }),
        line("from", BANK, { credit: "500.00000000" }),
      ],
    });
    const draft = expectTransaction(candidateToEditorDraft(moved, "transfer"));
    expect(draft.draft).toMatchObject({
      type: "transfer",
      transferFromCategory: BANK,
      transferToCategory: SAVINGS,
      transferAmount: "500.00",
    });
    const correction = transactionDraftToCorrection(draft.draft, {
      ...USD,
      sourceReviewerEditable: false,
    });
    expect(correction.partyId).toBeNull();
    expect(correction.lines.map((entry) => [entry.accountId, entry.debit, entry.credit])).toEqual([
      [SAVINGS, "500", null],
      [BANK, null, "500"],
    ]);
  });

  it("falls back to Journal when the tab would drop something", () => {
    const splitPayment = candidate({
      transactionType: "pay_out",
      lines: [
        line("e", EXPENSE, { debit: "50.00000000" }),
        // Two paying accounts do not fit Pay Out's single bank side.
        line("b1", BANK, { credit: "20.00000000" }),
        line("b2", SAVINGS, { credit: "30.00000000" }),
      ],
    });
    expect(candidateToEditorDraft(splitPayment, "expense")).toMatchObject({
      editor: "transaction",
      fallback: "tab_shape",
      draft: { type: "journal" },
    });

    const dimensionedBankSide = candidate({
      transactionType: "pay_out",
      lines: [
        line("e", EXPENSE, { debit: "50.00000000" }),
        line("b", BANK, { credit: "50.00000000" }, { departmentId: DEPT }),
      ],
    });
    expect(candidateToTransactionEditorDraft(dimensionedBankSide)).toMatchObject({
      fallback: "tab_shape",
    });
  });

  it("opens an unread paper on its tab with the paper total to categorize", () => {
    const draft = expectTransaction(
      candidateToEditorDraft(
        candidate({ transactionType: "pay_out", originalTotal: "19.99000000" }),
        "expense",
      ),
    );
    expect(draft.draft.type).toBe("pay_out");
    expect(draft.draft.payForLines).toEqual([
      {
        key: "paper-total",
        description: "",
        categoryId: "",
        departmentId: "",
        locationId: "",
        amount: "19.99",
      },
    ]);
  });

  it("posts a journal only when it balances exactly", () => {
    const journal = expectTransaction(
      candidateToEditorDraft(
        candidate({
          lines: [
            line("a", EXPENSE, { debit: "0.10000000" }),
            line("b", SUPPLIES, { debit: "0.20000000" }),
            line("c", BANK, { credit: "0.30000000" }),
          ],
        }),
        "journal",
      ),
    ).draft;
    const correction = transactionDraftToCorrection(journal, {
      ...USD,
      sourceReviewerEditable: true,
    });
    // A journal tab never reclassifies the source.
    expect(correction.economicEventClass).toBeUndefined();
    expect(correction.lines).toHaveLength(3);

    const unbalanced = {
      ...journal,
      journalLines: journal.journalLines.map((entry) =>
        entry.key === "c" ? { ...entry, credit: "0.31" } : entry,
      ),
    };
    expect(() =>
      transactionDraftToCorrection(unbalanced, { ...USD, sourceReviewerEditable: false }),
    ).toThrow("Debits (0.3) must equal credits (0.31).");

    const bothSides = {
      ...journal,
      journalLines: journal.journalLines.map((entry) =>
        entry.key === "a" ? { ...entry, credit: "0.10" } : entry,
      ),
    };
    expect(() =>
      transactionDraftToCorrection(bothSides, { ...USD, sourceReviewerEditable: false }),
    ).toThrow("Line 1: enter a debit or a credit, not both.");
  });

  it("names what is missing on Pay and Transfer", () => {
    const base = expectTransaction(
      candidateToEditorDraft(candidate({ transactionType: "pay_out" }), "expense"),
    ).draft;
    expect(() =>
      transactionDraftToCorrection(base, { ...USD, sourceReviewerEditable: false }),
    ).toThrow("Choose the Pay Out category.");
    expect(() =>
      transactionDraftToCorrection(
        { ...base, payCategoryId: BANK, payForLines: [{ ...base.payForLines[0], amount: "5" }] },
        { ...USD, sourceReviewerEditable: false },
      ),
    ).toThrow("Line 1: choose a category.");
    expect(() =>
      transactionDraftToCorrection(
        { ...base, type: "transfer", transferAmount: "10", transferFromCategory: BANK },
        { ...USD, sourceReviewerEditable: false },
      ),
    ).toThrow("Choose both the Transfer From and Transfer To categories.");
  });
});
