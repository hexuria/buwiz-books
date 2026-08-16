import { describe, expect, it } from "vitest";
import {
  amountToMinorUnits,
  canonicalizeSourcePair,
  descriptionSimilarity,
  matchSourceAgainstCandidates,
  normalizeAmountForCurrency,
  normalizeDuplicateMatchInput,
  normalizeParty,
  normalizeReference,
  scoreDuplicatePair,
  type DuplicateMatcherInput,
} from "@/lib/inbox/duplicate-matcher";

function purchase(overrides: Partial<DuplicateMatcherInput> = {}): DuplicateMatcherInput {
  return {
    sourceRecordId: crypto.randomUUID(),
    economicEventClass: "purchase",
    direction: "outflow",
    originalAmount: "125.50",
    originalCurrency: "USD",
    effectiveDate: "2026-07-24",
    party: "Acme Office Supplies, Inc.",
    reference: "INV-2048",
    description: "Acme office supplies printer paper",
    provider: "ramp",
    sourceAccountRef: "card-4242",
    recordState: "active",
    ...overrides,
  };
}

describe("duplicate matcher normalization", () => {
  it("normalizes merchant and reference values deterministically", () => {
    expect(normalizeParty("  ÁCME & Sons, LLC ")).toBe("acme and sons");
    expect(normalizeReference(" INV-20 / 48 ")).toBe("inv2048");
    expect(descriptionSimilarity("Acme printer paper", "Printer paper from Acme")).toBe(1);
  });

  it("compares fixed-point values at ISO currency precision", () => {
    expect(amountToMinorUnits("1,234.567", "USD")).toBe(123457n);
    expect(amountToMinorUnits("1234.6", "JPY")).toBe(1235n);
    expect(amountToMinorUnits("12.3456", "KWD")).toBe(12346n);
    expect(normalizeAmountForCurrency("1234.49", "JPY")).toBe("1234");
    expect(normalizeAmountForCurrency("1234.50", "JPY")).toBe("1235");
    expect(normalizeAmountForCurrency("12.3454", "KWD")).toBe("12.345");
  });

  it("changes the matcher input hash when evidence changes", () => {
    const before = normalizeDuplicateMatchInput(purchase({ documentHashes: [] }));
    const after = normalizeDuplicateMatchInput(
      purchase({
        sourceRecordId: before.sourceRecordId,
        documentHashes: ["ABC123"],
      }),
    );

    expect(before.inputHash).not.toBe(after.inputHash);
    expect(after.documentHashes).toEqual(["abc123"]);
  });

  it("hashes equivalent currency amount formatting identically", () => {
    const left = normalizeDuplicateMatchInput(
      purchase({ sourceRecordId: "same-source", originalAmount: "125.5" }),
    );
    const right = normalizeDuplicateMatchInput(
      purchase({ sourceRecordId: "same-source", originalAmount: "125.50" }),
    );

    expect(left.originalAmount).toBe("125.50");
    expect(left.inputHash).toBe(right.inputHash);
  });

  it("hashes precision-equivalent JPY inputs identically but keeps currencies distinct", () => {
    const jpyLeft = normalizeDuplicateMatchInput(
      purchase({
        sourceRecordId: "same-source",
        originalAmount: "1234.4",
        originalCurrency: "JPY",
      }),
    );
    const jpyRight = normalizeDuplicateMatchInput(
      purchase({
        sourceRecordId: "same-source",
        originalAmount: "1234",
        originalCurrency: "JPY",
      }),
    );
    const usd = normalizeDuplicateMatchInput(
      purchase({
        sourceRecordId: "same-source",
        originalAmount: "1234",
        originalCurrency: "USD",
      }),
    );

    expect(jpyLeft.originalAmount).toBe("1234");
    expect(jpyLeft.inputHash).toBe(jpyRight.inputHash);
    expect(jpyLeft.inputHash).not.toBe(usd.inputHash);
  });
});

describe("deterministic duplicate scoring", () => {
  it("forces identical document evidence to 100 even when email facts are incomplete", () => {
    const email = purchase({
      economicEventClass: "other",
      direction: "unknown",
      originalAmount: null,
      originalCurrency: null,
      effectiveDate: null,
      party: null,
      reference: null,
      description: "Forwarded purchase email",
      provider: "resend",
      sourceAccountRef: null,
      documentHashes: ["same-sha-256"],
    });
    const receipt = purchase({
      documentContentHashes: ["SAME-SHA-256"],
    });

    expect(scoreDuplicatePair(email, receipt)).toEqual(
      expect.objectContaining({
        eligible: true,
        matchClass: "duplicate",
        disposition: "blocking",
        score: 100,
        reason: "exact_document",
      }),
    );
  });

  it("does not let document identity override contradictory accounting semantics", () => {
    const inflow = purchase({
      direction: "inflow",
      economicEventClass: "sale",
      documentHashes: ["same-document"],
    });
    const outflow = purchase({ documentHashes: ["same-document"] });

    expect(scoreDuplicatePair(inflow, outflow)).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: "opposite_direction",
      }),
    );
  });

  it("scores reference, party, date, description, and source-account signals", () => {
    const result = scoreDuplicatePair(purchase(), purchase());

    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        matchClass: "duplicate",
        disposition: "blocking",
        score: 100,
        reason: "candidate_duplicate",
      }),
    );
    expect(result.signals).toEqual(
      expect.objectContaining({
        exactReference: true,
        exactParty: true,
        exactSourceAccount: true,
        dateDifferenceDays: 0,
        dateScore: 15,
        descriptionSimilarity: 1,
        descriptionScore: 20,
        amountsEqual: true,
        currenciesEqual: true,
      }),
    );
  });

  it("supports duplicates from the same provider and account when source records differ", () => {
    const left = purchase({ sourceRecordId: "record-a" });
    const right = purchase({ sourceRecordId: "record-b" });

    expect(scoreDuplicatePair(left, right).matchClass).toBe("duplicate");
  });

  it("does not promote amount and date alone into a duplicate case", () => {
    const left = purchase({
      party: null,
      reference: null,
      description: null,
      provider: null,
      sourceAccountRef: null,
    });
    const right = purchase({
      party: null,
      reference: null,
      description: null,
      provider: null,
      sourceAccountRef: null,
    });
    const result = scoreDuplicatePair(left, right);

    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        matchClass: "none",
        disposition: "none",
        score: 15,
        reason: "insufficient_identity",
      }),
    );
  });

  it("excludes distinct strong invoice references", () => {
    const result = scoreDuplicatePair(
      purchase({ reference: "INV-1001" }),
      purchase({ reference: "INV-1002" }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: "distinct_reference",
      }),
    );
  });

  it("excludes accrual/payment pairs and transfers", () => {
    expect(
      scoreDuplicatePair(
        purchase({ economicEventClass: "bill_accrual" }),
        purchase({ economicEventClass: "bill_payment" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "incompatible_event_class" }));

    expect(
      scoreDuplicatePair(
        purchase({ economicEventClass: "transfer" }),
        purchase({ economicEventClass: "transfer" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "transfer_excluded" }));
  });

  it("records slight amount differences as related shadow suggestions", () => {
    const result = scoreDuplicatePair(
      purchase({ originalAmount: "100.00" }),
      purchase({ originalAmount: "101.00" }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        matchClass: "related",
        disposition: "shadow",
        score: 69,
        reason: "related_activity",
      }),
    );
    expect(result.signals.amountDifferenceIsSlight).toBe(true);
  });

  it("records strongly identified cross-currency activity as related, never blocking", () => {
    const result = scoreDuplicatePair(
      purchase({ originalAmount: "100", originalCurrency: "USD" }),
      purchase({ originalAmount: "5,800", originalCurrency: "PHP" }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        matchClass: "related",
        disposition: "shadow",
        score: 69,
      }),
    );
  });

  it("respects the date window and configurable thresholds", () => {
    const outside = scoreDuplicatePair(purchase(), purchase({ effectiveDate: "2026-07-28" }));
    expect(outside.reason).toBe("outside_date_window");

    const thresholdAdjusted = scoreDuplicatePair(
      purchase({
        party: null,
        provider: null,
        sourceAccountRef: null,
        description: "Acme printer paper",
      }),
      purchase({
        party: null,
        provider: null,
        sourceAccountRef: null,
        description: "Acme printer paper",
      }),
      { blockingScore: 70, shadowScore: 80, matchWindowDays: 5 },
    );
    // shadowScore is safely clamped to the blocking threshold.
    expect(thresholdAdjusted.disposition).toBe("blocking");
  });

  it("does not reopen inactive source records", () => {
    expect(scoreDuplicatePair(purchase({ recordState: "superseded" }), purchase())).toEqual(
      expect.objectContaining({ eligible: false, reason: "inactive_source" }),
    );
  });
});

describe("duplicate matcher service helpers", () => {
  it("returns only actionable cases when re-matching a changed source", () => {
    const source = purchase({ sourceRecordId: "source" });
    const candidates = [
      purchase({ sourceRecordId: "duplicate" }),
      purchase({
        sourceRecordId: "unrelated",
        originalAmount: "900",
        reference: null,
        party: "Different Vendor",
        description: "Unrelated hotel booking",
      }),
    ];

    const matches = matchSourceAgainstCandidates(source, candidates);
    expect(matches).toHaveLength(1);
    expect(matches[0].candidate.sourceRecordId).toBe("duplicate");
  });

  it("orders source pairs canonically and rejects self-pairs", () => {
    expect(canonicalizeSourcePair("b", "a")).toEqual({
      leftSourceRecordId: "a",
      rightSourceRecordId: "b",
    });
    expect(() => canonicalizeSourcePair("a", "a")).toThrow("requires two distinct source records");
  });
});
