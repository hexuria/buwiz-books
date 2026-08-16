import { describe, expect, it } from "vitest";
import {
  legacySnapshotDigest,
  validateLegacyMatchSnapshot,
  validateLegacySurvivorPair,
  type LegacyDeletedHeaderSnapshot,
  type LegacyDeletedLineSnapshot,
  type LegacySurvivorFacts,
} from "../../../src/lib/legacy-match-conversion";

const historyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const organizationId = "test-organization";
const survivingId = "11111111-1111-4111-8111-111111111111";
const deletedId = "22222222-2222-4222-8222-222222222222";
const debitLineId = "33333333-3333-4333-8333-333333333333";
const creditLineId = "44444444-4444-4444-8444-444444444444";
const debitAccountId = "55555555-5555-4555-8555-555555555555";
const creditAccountId = "66666666-6666-4666-8666-666666666666";
const exchangeRateId = "77777777-7777-4777-8777-777777777777";

function header(overrides: Partial<LegacyDeletedHeaderSnapshot> = {}): LegacyDeletedHeaderSnapshot {
  return {
    id: deletedId,
    organizationId,
    transactionNumber: "TXN-000002",
    referenceNumber: "INV-42",
    idempotencyKey: null,
    transactionDate: "2026-07-20",
    transactionType: "pay_out",
    source: "document",
    memo: "Office supplies",
    partyId: null,
    totalAmount: "125.50000000",
    functionalCurrency: "USD",
    transactionCurrency: null,
    exchangeRateId: null,
    status: "posted",
    sourceDocumentId: null,
    sourceDocumentType: null,
    createdBy: "user-1",
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    updatedAt: new Date("2026-07-20T12:01:00.000Z"),
    postedAt: new Date("2026-07-20T12:01:00.000Z"),
    voidedAt: null,
    duplicateOfHeaderId: null,
    matchedFromIds: [],
    isMatched: false,
    ...overrides,
  };
}

function lines(overrides: Partial<LegacyDeletedLineSnapshot>[] = []): LegacyDeletedLineSnapshot[] {
  const values: LegacyDeletedLineSnapshot[] = [
    {
      id: debitLineId,
      journalHeaderId: deletedId,
      accountId: debitAccountId,
      debit: "125.50000000",
      credit: null,
      originalDebit: null,
      originalCredit: null,
      originalCurrency: null,
      exchangeRate: null,
      exchangeRateId: null,
      lineDescription: "Expense",
      partyId: null,
      departmentId: null,
      locationId: null,
      sortOrder: 0,
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
    },
    {
      id: creditLineId,
      journalHeaderId: deletedId,
      accountId: creditAccountId,
      debit: null,
      credit: "125.50000000",
      originalDebit: null,
      originalCredit: null,
      originalCurrency: null,
      exchangeRate: null,
      exchangeRateId: null,
      lineDescription: "Cash",
      partyId: null,
      departmentId: null,
      locationId: null,
      sortOrder: 1,
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
    },
  ];
  return values.map((line, index) => ({ ...line, ...overrides[index] }));
}

function validate(
  deletedHeaderSnapshot: unknown = header(),
  deletedLinesSnapshot: unknown = lines(),
) {
  return validateLegacyMatchSnapshot({
    historyId,
    organizationId,
    survivingHeaderId: survivingId,
    deletedHeaderSnapshot,
    deletedLinesSnapshot,
  });
}

function survivor(overrides: Partial<LegacySurvivorFacts> = {}): LegacySurvivorFacts {
  return {
    id: survivingId,
    organizationId,
    status: "posted",
    transactionType: "pay_out",
    source: "document",
    totalAmount: "125.50000000",
    functionalCurrency: "USD",
    transactionCurrency: null,
    duplicateOfHeaderId: null,
    matchedFromIds: [deletedId],
    isMatched: true,
    debitTotal: "125.50000000",
    creditTotal: "125.50000000",
    ...overrides,
  };
}

describe("legacy destructive match snapshot validation", () => {
  it("accepts a complete, posted, balanced same-currency snapshot", () => {
    const result = validate();
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.debitTotal).toBe("125.50000000");
    expect(result.value.effectiveCurrency).toBe("USD");
    expect(validateLegacySurvivorPair(survivor(), result.value)).toEqual([]);
  });

  it("rejects old snapshots that omit current currency and original-amount fields", () => {
    const oldHeader = { ...header() } as Record<string, unknown>;
    delete oldHeader.functionalCurrency;
    const oldLines = lines().map((line) => {
      const oldLine = { ...line } as Record<string, unknown>;
      delete oldLine.originalDebit;
      delete oldLine.originalCredit;
      delete oldLine.originalCurrency;
      delete oldLine.exchangeRate;
      delete oldLine.exchangeRateId;
      return oldLine;
    });

    const result = validate(oldHeader, oldLines);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid_header_snapshot", "invalid_line_snapshot"]),
    );
  });

  it("rejects unbalanced, cross-header, and nested snapshots", () => {
    const result = validate(
      header({ matchedFromIds: [survivingId], isMatched: true }),
      lines([{ debit: "124.00000000" }, { journalHeaderId: survivingId }]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "nested_legacy_match",
        "line_header_mismatch",
        "unbalanced_deleted_journal",
        "deleted_total_mismatch",
      ]),
    );
  });

  it("requires complete FX lineage for cross-currency snapshots", () => {
    const complete = validate(
      header({
        totalAmount: "137.50000000",
        transactionCurrency: "EUR",
        exchangeRateId,
      }),
      lines([
        {
          debit: "137.50000000",
          originalDebit: "125.00000000",
          originalCurrency: "EUR",
          exchangeRate: "1.1000000000",
          exchangeRateId,
        },
        {
          credit: "137.50000000",
          originalCredit: "125.00000000",
          originalCurrency: "EUR",
          exchangeRate: "1.1000000000",
          exchangeRateId,
        },
      ]),
    );
    expect(complete.valid).toBe(true);

    const incomplete = validate(
      header({ transactionCurrency: "EUR", exchangeRateId }),
      lines([{ originalDebit: "125.50000000" }, { originalCredit: "125.50000000" }]),
    );
    expect(incomplete.valid).toBe(false);
    if (incomplete.valid) return;
    expect(incomplete.issues.map((issue) => issue.code)).toContain("incomplete_fx_evidence");
  });

  it("rejects a partial same-currency original-amount trail", () => {
    const result = validate(
      header(),
      lines([
        {
          originalDebit: "125.50000000",
          originalCurrency: "USD",
          exchangeRate: "1.0000000000",
        },
      ]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["incomplete_original_amounts", "unbalanced_original_amounts"]),
    );
  });

  it("requires exact legacy linkage and safe pair compatibility", () => {
    const result = validate();
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const issues = validateLegacySurvivorPair(
      survivor({
        transactionType: "pay_in",
        transactionCurrency: "EUR",
        matchedFromIds: ["88888888-8888-4888-8888-888888888888"],
      }),
      result.value,
    );
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "legacy_linkage_mismatch",
        "legacy_currency_mismatch",
        "legacy_direction_mismatch",
      ]),
    );
  });

  it("computes a stable snapshot digest independent of object key order", () => {
    expect(legacySnapshotDigest({ a: 1, b: 2 }, [{ x: "y" }])).toBe(
      legacySnapshotDigest({ b: 2, a: 1 }, [{ x: "y" }]),
    );
  });
});
