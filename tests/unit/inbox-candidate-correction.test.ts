import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import {
  correctedSourceClassification,
  resolveCorrectionLinePartyIds,
} from "@/lib/inbox/candidate-correction";

describe("candidate correction economic-event identity", () => {
  it.each([
    ["bill_payment", "pay_out", "bill_payment", "outflow"],
    ["invoice_payment", "pay_in", "invoice_payment", "inflow"],
    ["payroll", "pay_out", "payroll", "outflow"],
    ["transfer", "transfer", "transfer", "neutral"],
    ["bill_accrual", "pay_out", "bill_accrual", "outflow"],
    ["invoice_accrual", "pay_in", "invoice_accrual", "inflow"],
  ] as const)(
    "preserves authoritative %s classification during a compatible %s correction",
    (existingClass, transactionType, expectedClass, expectedDirection) => {
      expect(correctedSourceClassification(transactionType, "transaction", existingClass)).toEqual({
        economicEventClass: expectedClass,
        direction: expectedDirection,
      });
    },
  );

  it("derives purchase and sale only when the source class is unknown", () => {
    expect(correctedSourceClassification("pay_out", "transaction", "other")).toEqual({
      economicEventClass: "purchase",
      direction: "outflow",
    });
    expect(correctedSourceClassification("pay_in", "transaction", undefined)).toEqual({
      economicEventClass: "sale",
      direction: "inflow",
    });
  });

  it("does not rewrite an authoritative payment into an opposite-direction event", () => {
    expect(() => correctedSourceClassification("pay_in", "transaction", "bill_payment")).toThrow(
      "conflicts with the source's bill payment economic event",
    );
    expect(() =>
      correctedSourceClassification("pay_out", "transaction", "invoice_payment"),
    ).toThrow("conflicts with the source's invoice payment economic event");
  });

  it("allows an explicit reviewer correction to replace an extracted event classification", () => {
    expect(
      correctedSourceClassification("pay_in", "document_transaction", "purchase", {
        economicEventClass: "invoice_payment",
        sourceIsReviewerEditable: true,
      }),
    ).toEqual({
      economicEventClass: "invoice_payment",
      direction: "inflow",
    });
    expect(
      correctedSourceClassification("pay_out", "document_transaction", "purchase", {
        economicEventClass: "bill_accrual",
        sourceIsReviewerEditable: true,
      }),
    ).toEqual({
      economicEventClass: "bill_accrual",
      direction: "outflow",
    });
  });

  it("rejects an explicit attempt to rewrite provider-owned event identity", () => {
    expect(() =>
      correctedSourceClassification("pay_out", "transaction", "bill_payment", {
        economicEventClass: "purchase",
        sourceIsReviewerEditable: false,
      }),
    ).toThrow("provider-owned and cannot be changed");
  });

  it("rejects an event class whose direction conflicts with the transaction type", () => {
    expect(() =>
      correctedSourceClassification("pay_in", "document_transaction", "purchase", {
        economicEventClass: "purchase",
        sourceIsReviewerEditable: true,
      }),
    ).toThrow("conflicts with the transaction type");
  });
});

describe("candidate correction line parties", () => {
  const EXPENSE = "expense-account";
  const BANK = "bank-account";
  const PAYABLE = "payable-account";
  const context = {
    entryPartyId: "vendor-now",
    counterpartyAccountIds: new Set([PAYABLE]),
  };

  it("puts the entry's party on payable and receivable lines when none is given", () => {
    expect(
      resolveCorrectionLinePartyIds(
        [
          { accountId: EXPENSE, originalDebit: "10" },
          { accountId: PAYABLE, originalDebit: null },
        ],
        [{ accountId: PAYABLE, originalDebit: null, partyId: "vendor-before" }],
        context,
      ),
    ).toEqual([null, "vendor-now"]);
  });

  it("keeps each other line's party from its predecessor on the same account and side, once", () => {
    expect(
      resolveCorrectionLinePartyIds(
        [
          { accountId: EXPENSE, originalDebit: "4" },
          { accountId: EXPENSE, originalDebit: "6" },
          { accountId: EXPENSE, originalDebit: "1" },
          { accountId: BANK, originalDebit: null },
        ],
        [
          { accountId: EXPENSE, originalDebit: "5", partyId: "courier" },
          { accountId: EXPENSE, originalDebit: "5", partyId: "printer" },
          // Same account, other side: not a predecessor of a debit line.
          { accountId: BANK, originalDebit: "1", partyId: "bank-side" },
        ],
        context,
      ),
    ).toEqual(["courier", "printer", null, null]);
  });

  it("lets an explicit party win, null included", () => {
    expect(
      resolveCorrectionLinePartyIds(
        [
          { accountId: PAYABLE, originalDebit: null, partyId: null },
          { accountId: EXPENSE, originalDebit: "3", partyId: "chosen" },
        ],
        [{ accountId: EXPENSE, originalDebit: "3", partyId: "courier" }],
        context,
      ),
    ).toEqual([null, "chosen"]);
  });
});
