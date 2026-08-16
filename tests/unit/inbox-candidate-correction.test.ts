import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { correctedSourceClassification } from "@/lib/inbox/candidate-correction";

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
