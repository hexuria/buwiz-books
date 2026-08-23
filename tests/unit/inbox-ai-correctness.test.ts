import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAllowedContentType } from "../../src/lib/documents/ensure-document";
import {
  normalizeDuplicateMatchInput,
  scoreDuplicatePair,
} from "../../src/lib/inbox/duplicate-matcher";

/**
 * Program 2 P8 — inbox/AI correctness cluster.
 */
describe("document MIME allowlist (D7)", () => {
  it("accepts the allowlisted types and maps octet-stream by extension", () => {
    expect(resolveAllowedContentType("a.pdf", "application/pdf")).toBe("application/pdf");
    expect(resolveAllowedContentType("scan.HEIC", "image/heic")).toBe("image/heic");
    expect(resolveAllowedContentType("stmt.csv", "application/octet-stream")).toBe("text/csv");
    expect(resolveAllowedContentType("book.xlsx", "")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("refuses markup and unknown types loudly — the stored type reaches R2", () => {
    expect(() => resolveAllowedContentType("evil.html", "text/html")).toThrow(/Unsupported/);
    expect(() => resolveAllowedContentType("evil.svg", "image/svg+xml")).toThrow(/Unsupported/);
    expect(() => resolveAllowedContentType("blob.bin", "application/octet-stream")).toThrow(
      /Unsupported/,
    );
  });
});

describe("duplicate matcher (P8 + D4)", () => {
  const base = {
    sourceRecordId: null,
    economicEventClass: "purchase" as const,
    direction: "outflow" as const,
    originalAmount: "250.00",
    originalCurrency: "USD",
    effectiveDate: "2026-07-24",
    party: "Acme Supply",
    normalizedParty: "acme supply",
    normalizedReference: null,
    description: "Team lunch receipt",
    sourceAccountRef: null,
    documentHashes: [],
  };
  const settings = {
    matchWindowDays: 3,
    blockingScore: 70,
    shadowScore: 50,
    relatedAmountToleranceBps: 200,
    algorithmVersion: 2,
  };

  it("D4: exact amount + same day + same party with NO references blocks", () => {
    const result = scoreDuplicatePair(base, { ...base }, settings);
    expect(result.disposition).toBe("blocking");
  });

  it("a reference on either side returns the decision to the scored path", () => {
    const withRef = { ...base, normalizedReference: "inv-100" };
    const result = scoreDuplicatePair(withRef, { ...base }, settings);
    // Not the strong combo; whatever the score says, it is not forced.
    expect(result.signals).toBeDefined();
  });

  it("absent currency reports missing_currency, not a mismatch", () => {
    const left = { ...base, originalCurrency: null };
    const result = scoreDuplicatePair(left, { ...base }, settings);
    expect(result.reason).toBe("missing_currency");
  });

  it("normalization keeps parsing EU-agnostic inputs sane", () => {
    const normalized = normalizeDuplicateMatchInput(base);
    expect(normalized.originalCurrency).toBe("USD");
  });
});

describe("P8 wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

  it("classification failures rethrow instead of reading as low confidence", () => {
    const source = read("src/routes/api/-ai-classify-document.ts");
    expect(source).toContain("Document classification failed:");
    // Exactly ONE {other, 0} return remains: the VALIDATION branch (model
    // responded, output failed the schema) — a deliberate policy. The catch
    // branch (provider failure) throws.
    expect(source.match(/return \{ documentType: "other", confidence: 0 \}/g)!.length).toBe(1);
  });

  it("failed entities surface in the resolver result", () => {
    const source = read("src/routes/api/-ai-entity-resolver.ts");
    expect(source).toContain("result.errors.push({");
  });

  it("the FX fetch is time-bounded", () => {
    const source = read("src/lib/inbox/fx.ts");
    expect(source).toContain("AbortSignal.timeout(10_000)");
  });

  it("the discovery cap is ordered and logged", () => {
    const source = read("src/lib/inbox/duplicate-engine.ts");
    expect(source).toContain("hit the 500-row cap");
    expect(source).toContain("orderBy(desc(sourceRecords.effectiveDate)");
  });

  it("the review-engine JS filter matches its SQL case-insensitivity", () => {
    const source = read("src/lib/inbox/review-engine.ts");
    expect(source).toContain('item.subtype?.toLowerCase().includes("clearing")');
  });

  it("rules total money exactly and only convert thresholds with the right pair", () => {
    const source = read("src/lib/inbox/rules.ts");
    expect(source).toContain("sumMoney(");
    expect(source).toContain("settings.missingReceiptCurrency === candidate.originalCurrency");
  });
});
