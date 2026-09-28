// ============================================================================
// Inbox stage 2 planning: which placeholder line is the category, who the
// counterparty is, and what the documents say. Pure; no database, no model.
// ============================================================================
import { describe, expect, it } from "vitest";
import { collectDocumentFacts } from "@/lib/inbox/candidate-document-facts";
import { planCandidateClassification } from "@/lib/inbox/classification-plan";

const placeholder = (id: string, side: "debit" | "credit") => ({
  id,
  accountId: null,
  predictionEvidence: { source: "document_extraction", accountSelection: "not_inferred" },
  originalDebit: side === "debit" ? "84.25000000" : null,
  originalCredit: side === "credit" ? "84.25000000" : null,
});
const LINES = [placeholder("debit-line", "debit"), placeholder("credit-line", "credit")];
const NO_FACTS = collectDocumentFacts([], { from: null });

function plan(
  economicEventClass: string | null,
  overrides: Partial<Parameters<typeof planCandidateClassification>[0]> = {},
) {
  return planCandidateClassification({
    candidate: { memo: "Printer paper", transactionType: "pay_out" },
    lines: LINES,
    economicEventClass,
    facts: { ...NO_FACTS, partyName: "Staples" },
    ...overrides,
  });
}

describe("planCandidateClassification", () => {
  it.each(["purchase", "bill_accrual", "payroll"])(
    "%s categorizes the DEBIT line against expense-side accounts",
    (event) => {
      const result = plan(event);
      expect(result.direction).toBe("outflow");
      expect(result.categoryLines).toEqual([
        {
          lineIndex: 0,
          side: "debit",
          direction: "outflow",
          description: "Printer paper",
          amount: "84.25",
        },
      ]);
      expect(result.lineIdByIndex.get(0)).toBe("debit-line");
    },
  );

  it.each(["sale", "invoice_accrual"])("%s categorizes the CREDIT line", (event) => {
    const result = plan(event, { candidate: { memo: "Consulting", transactionType: "pay_in" } });
    expect(result.direction).toBe("inflow");
    expect(result.categoryLines).toMatchObject([{ lineIndex: 1, side: "credit" }]);
    expect(result.lineIdByIndex.get(1)).toBe("credit-line");
    expect(result.role).toBe("customer");
  });

  it.each([
    ["bill_payment", "vendor"],
    ["invoice_payment", "customer"],
    ["transfer", null],
  ] as const)("%s has no category line (both sides are balance-sheet picks)", (event, role) => {
    const result = plan(event);
    expect(result.categoryLines).toEqual([]);
    expect(result.role).toBe(role);
  });

  it("matches a vendor for purchases, an employee for payroll", () => {
    expect(plan("purchase").partyQuery).toMatchObject({ name: "Staples", entityType: "vendor" });
    expect(plan("payroll").role).toBe("employee");
  });

  it("never plans over a line a reviewer already chose", () => {
    const reviewed = [{ ...LINES[0], accountId: "acct-1", predictionEvidence: null }, LINES[1]];
    expect(plan("purchase", { lines: reviewed }).categoryLines).toEqual([]);
  });

  it("asks nothing about a counterparty it knows nothing about", () => {
    expect(plan("purchase", { facts: NO_FACTS }).partyQuery).toBeNull();
  });
});

describe("collectDocumentFacts", () => {
  const inboxExtraction = (result: Record<string, unknown>) => ({
    inboxExtraction: { version: 1, cachedAt: "2026-07-24T00:00:00.000Z", result },
  });

  it("reads identity and payee details from the inbox extraction, first document wins", () => {
    const facts = collectDocumentFacts(
      [
        {
          id: "doc-1",
          documentType: "bill",
          metadata: {
            ...inboxExtraction({
              party: "Acme Supply Co",
              partyEmail: "Billing@Acme.test",
              partyTaxId: "123-456-789-000",
              payeeBankAccountNumber: "9876543210",
              payeeBankRoutingNumber: "026009593",
            }),
            triage: { docKind: "bill", confidence: 0.93, version: 1, cachedAt: "x" },
          },
          aiTransactionCache: null,
        },
        {
          id: "doc-2",
          documentType: "receipt",
          metadata: inboxExtraction({ party: "Someone Else", payeeBankAccountNumber: "1111" }),
          aiTransactionCache: null,
        },
      ],
      { from: '"Acme AP" <ap@acme.test>' },
    );
    expect(facts).toMatchObject({
      documentIds: ["doc-1", "doc-2"],
      kind: "bill",
      partyName: "Acme Supply Co",
      partyTaxId: "123-456-789-000",
      partyEmails: ["billing@acme.test", "ap@acme.test"],
      payeeBankAccountNumber: "9876543210",
      payeeBankRoutingNumber: "026009593",
      paymentDetailsDocumentId: "doc-1",
    });
  });

  it("falls back to bill OCR, then the receipt parse, for names and line items", () => {
    const facts = collectDocumentFacts(
      [
        {
          id: "doc-1",
          documentType: "other",
          metadata: {
            billOcr: {
              result: {
                vendor: { name: "ACME GmbH", email: "rechnung@acme.test" },
                lineItems: [{ description: "Consulting", amount: 1234.56 }],
              },
              contextHash: "h",
              cachedAt: "x",
            },
          },
          aiTransactionCache: null,
        },
      ],
      { from: null },
    );
    expect(facts).toMatchObject({
      kind: null,
      partyName: "ACME GmbH",
      partyEmails: ["rechnung@acme.test"],
      lineItems: [{ description: "Consulting", amount: "1234.56" }],
      payeeBankAccountNumber: null,
    });
  });

  it("uses a sender display name only when it is not a mailbox label", () => {
    expect(collectDocumentFacts([], { from: '"Blue Bottle" <hello@bb.test>' }).partyName).toBe(
      "Blue Bottle",
    );
    expect(collectDocumentFacts([], { from: '"No Reply" <x@y.test>' }).partyName).toBeNull();
    expect(collectDocumentFacts([], { from: '"billing" <x@y.test>' }).partyName).toBeNull();
  });
});
