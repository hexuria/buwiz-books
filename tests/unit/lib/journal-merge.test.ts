import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import {
  buildJournalMergePairKey,
  evaluateJournalMergePreflight,
  type JournalMergeFact,
  type JournalMergeFacts,
} from "../../../src/lib/journal-merge";

const canonicalId = "11111111-1111-4111-8111-111111111111";
const duplicateId = "22222222-2222-4222-8222-222222222222";

function journal(overrides: Partial<JournalMergeFact> = {}): JournalMergeFact {
  return {
    id: canonicalId,
    transactionNumber: "TXN-000001",
    transactionDate: "2026-07-20",
    transactionType: "pay_out",
    status: "posted",
    totalAmount: "125.50000000",
    currency: "USD",
    functionalCurrency: "USD",
    duplicateOfHeaderId: null,
    debitTotal: "125.50000000",
    creditTotal: "125.50000000",
    originalDebitTotal: "125.50000000",
    originalCreditTotal: "125.50000000",
    originalAmountsComplete: false,
    originalCurrencies: [],
    reconciliationCount: 0,
    domainOwners: [],
    economicEventClasses: ["purchase"],
    operationalOrigins: [],
    paymentIdentityTokens: [],
    ...overrides,
  };
}

function facts(overrides: Partial<JournalMergeFacts> = {}): JournalMergeFacts {
  return {
    canonical: journal(),
    duplicate: journal({
      id: duplicateId,
      transactionNumber: "TXN-000002",
    }),
    closedThrough: null,
    activeMergeIds: [],
    ...overrides,
  };
}

describe("safe journal duplicate merge", () => {
  it("builds the same canonical pair key regardless of selection order", () => {
    expect(buildJournalMergePairKey(canonicalId, duplicateId)).toBe(
      buildJournalMergePairKey(duplicateId, canonicalId),
    );
  });

  it("accepts two balanced, posted, same-direction journals with exact amounts", () => {
    const preview = evaluateJournalMergePreflight(facts());
    expect(preview.eligible).toBe(true);
    expect(preview.blockers).toEqual([]);
  });

  it("rejects a cached amount that disagrees with immutable journal lines", () => {
    const preview = evaluateJournalMergePreflight(
      facts({
        duplicate: journal({
          id: duplicateId,
          totalAmount: "120.00000000",
        }),
      }),
    );
    expect(preview.eligible).toBe(false);
    expect(preview.checks.find((check) => check.key === "amount")?.passed).toBe(false);
  });

  it("compares foreign-currency economic amounts independently of functional FX totals", () => {
    const preview = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          totalAmount: "110.00000000",
          debitTotal: "110.00000000",
          creditTotal: "110.00000000",
          currency: "EUR",
          functionalCurrency: "USD",
          originalDebitTotal: "100.00000000",
          originalCreditTotal: "100.00000000",
          originalAmountsComplete: true,
          originalCurrencies: ["EUR"],
        }),
        duplicate: journal({
          id: duplicateId,
          totalAmount: "112.00000000",
          debitTotal: "112.00000000",
          creditTotal: "112.00000000",
          currency: "EUR",
          functionalCurrency: "USD",
          originalDebitTotal: "100.00000000",
          originalCreditTotal: "100.00000000",
          originalAmountsComplete: true,
          originalCurrencies: ["EUR"],
        }),
      }),
    );

    expect(preview.eligible).toBe(true);
    expect(preview.checks.find((check) => check.key === "amount")?.passed).toBe(true);
    expect(preview.checks.find((check) => check.key === "currency")?.passed).toBe(true);
  });

  it("rejects different original amounts even when functional totals happen to match", () => {
    const preview = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          currency: "EUR",
          functionalCurrency: "USD",
          originalDebitTotal: "100.00000000",
          originalCreditTotal: "100.00000000",
          originalAmountsComplete: true,
          originalCurrencies: ["EUR"],
        }),
        duplicate: journal({
          id: duplicateId,
          currency: "EUR",
          functionalCurrency: "USD",
          originalDebitTotal: "101.00000000",
          originalCreditTotal: "101.00000000",
          originalAmountsComplete: true,
          originalCurrencies: ["EUR"],
        }),
      }),
    );

    expect(preview.eligible).toBe(false);
    expect(preview.checks.find((check) => check.key === "amount")?.passed).toBe(false);
  });

  it("rejects incomplete or inconsistent original line currency data for foreign journals", () => {
    const incomplete = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          currency: "EUR",
          functionalCurrency: "USD",
          originalAmountsComplete: false,
          originalCurrencies: [],
        }),
        duplicate: journal({
          id: duplicateId,
          currency: "EUR",
          functionalCurrency: "USD",
          originalAmountsComplete: true,
          originalCurrencies: ["EUR"],
        }),
      }),
    );
    expect(incomplete.checks.find((check) => check.key === "currency")?.passed).toBe(false);

    const inconsistent = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          currency: "EUR",
          functionalCurrency: "USD",
          originalAmountsComplete: true,
          originalCurrencies: ["GBP"],
        }),
        duplicate: journal({
          id: duplicateId,
          currency: "EUR",
          functionalCurrency: "USD",
          originalAmountsComplete: true,
          originalCurrencies: ["EUR"],
        }),
      }),
    );
    expect(inconsistent.checks.find((check) => check.key === "currency")?.passed).toBe(false);
  });

  it("rejects cross-currency, opposite-direction, transfer, and locked-period pairs", () => {
    const crossCurrency = evaluateJournalMergePreflight(
      facts({
        duplicate: journal({ id: duplicateId, currency: "EUR" }),
      }),
    );
    expect(crossCurrency.checks.find((check) => check.key === "currency")?.passed).toBe(false);

    const oppositeDirection = evaluateJournalMergePreflight(
      facts({
        duplicate: journal({ id: duplicateId, transactionType: "pay_in" }),
      }),
    );
    expect(oppositeDirection.checks.find((check) => check.key === "direction")?.passed).toBe(false);

    const transfer = evaluateJournalMergePreflight(
      facts({
        canonical: journal({ transactionType: "transfer" }),
        duplicate: journal({ id: duplicateId, transactionType: "transfer" }),
      }),
    );
    expect(transfer.checks.find((check) => check.key === "direction")?.passed).toBe(false);

    const locked = evaluateJournalMergePreflight(facts({ closedThrough: "2026-07-20" }));
    expect(locked.checks.find((check) => check.key === "period")?.passed).toBe(false);
  });

  it("rejects incompatible accrual and payment event classes", () => {
    const preview = evaluateJournalMergePreflight(
      facts({
        canonical: journal({ economicEventClasses: ["bill_accrual"] }),
        duplicate: journal({
          id: duplicateId,
          economicEventClasses: ["bill_payment"],
        }),
      }),
    );
    expect(preview.eligible).toBe(false);
    expect(preview.checks.find((check) => check.key === "event_class")?.passed).toBe(false);
  });

  it("blocks distinct payment captures even when both journals belong to the same invoice", () => {
    const invoiceOwner = "invoice:33333333-3333-4333-8333-333333333333";
    const preview = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          transactionType: "pay_in",
          domainOwners: [invoiceOwner],
          economicEventClasses: ["invoice_payment"],
          operationalOrigins: [
            {
              sourceRecordId: "source-capture-a",
              integrationSourceId: "stripe-source",
              provider: "stripe",
              externalId: "pi_capture_1001",
              normalizedReference: "picapture1001",
              recordType: "invoice_payment",
              economicEventClass: "invoice_payment",
            },
          ],
          paymentIdentityTokens: ["reference:picapture1001"],
        }),
        duplicate: journal({
          id: duplicateId,
          transactionType: "pay_in",
          domainOwners: [invoiceOwner],
          economicEventClasses: ["invoice_payment"],
          operationalOrigins: [
            {
              sourceRecordId: "source-capture-b",
              integrationSourceId: "stripe-source",
              provider: "stripe",
              externalId: "pi_capture_1002",
              normalizedReference: "picapture1002",
              recordType: "invoice_payment",
              economicEventClass: "invoice_payment",
            },
          ],
          paymentIdentityTokens: ["reference:picapture1002"],
        }),
      }),
    );

    expect(preview.eligible).toBe(false);
    expect(preview.checks.find((check) => check.key === "domain")?.passed).toBe(true);
    expect(preview.checks.find((check) => check.key === "payment_identity")?.passed).toBe(false);
  });

  it("allows payment duplicate suppression only with one shared strong payment identity", () => {
    const sharedIdentity = "reference:picapture1001";
    const preview = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          transactionType: "pay_in",
          economicEventClasses: ["invoice_payment"],
          paymentIdentityTokens: [sharedIdentity],
        }),
        duplicate: journal({
          id: duplicateId,
          transactionType: "pay_in",
          economicEventClasses: ["invoice_payment"],
          paymentIdentityTokens: [sharedIdentity],
        }),
      }),
    );

    expect(preview.checks.find((check) => check.key === "payment_identity")?.passed).toBe(true);
    expect(preview.eligible).toBe(true);
  });

  it("requires the reconciled or operationally-owned journal to be canonical", () => {
    const reconciledDuplicate = evaluateJournalMergePreflight(
      facts({
        duplicate: journal({ id: duplicateId, reconciliationCount: 1 }),
      }),
    );
    expect(reconciledDuplicate.checks.find((check) => check.key === "reconciliation")?.passed).toBe(
      false,
    );
    expect(reconciledDuplicate.blockers.join(" ")).toContain(
      "reconciled journal must be selected as canonical",
    );

    const ownedDuplicate = evaluateJournalMergePreflight(
      facts({
        duplicate: journal({
          id: duplicateId,
          domainOwners: ["bill:33333333-3333-4333-8333-333333333333"],
        }),
      }),
    );
    expect(ownedDuplicate.checks.find((check) => check.key === "domain")?.passed).toBe(false);
  });

  it("never combines journals owned by different bills or invoices", () => {
    const preview = evaluateJournalMergePreflight(
      facts({
        canonical: journal({
          domainOwners: ["bill:33333333-3333-4333-8333-333333333333"],
        }),
        duplicate: journal({
          id: duplicateId,
          domainOwners: ["bill:44444444-4444-4444-8444-444444444444"],
        }),
      }),
    );
    expect(preview.eligible).toBe(false);
    expect(preview.checks.find((check) => check.key === "domain")?.passed).toBe(false);
  });

  it("rejects journals already suppressed or participating in an active merge", () => {
    const suppressed = evaluateJournalMergePreflight(
      facts({
        duplicate: journal({
          id: duplicateId,
          duplicateOfHeaderId: canonicalId,
        }),
      }),
    );
    expect(suppressed.checks.find((check) => check.key === "effective")?.passed).toBe(false);

    const active = evaluateJournalMergePreflight(
      facts({ activeMergeIds: ["55555555-5555-4555-8555-555555555555"] }),
    );
    expect(active.checks.find((check) => check.key === "not_already_merged")?.passed).toBe(false);
  });
});
