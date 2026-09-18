import { describe, expect, it } from "vitest";
import { billOcrContextHash, readValidCachedBillOcr } from "../../../src/lib/bill-ocr-cache";

const CONTEXT_HASH = billOcrContextHash([
  { accountNumber: "50200", name: "Hosting Fees", type: "expense" },
]);

const GOLDEN_BILL = {
  vendor: { name: "AWS", email: "billing@aws.com" },
  invoice: {
    invoiceNumber: "INV-1047",
    invoiceDate: "2026-02-01",
    dueDate: "2026-03-03",
    amount: 340.12,
    notes: "Cloud hosting for January",
  },
  lineItems: [
    { description: "EC2 usage", amount: 290.12, suggestedCategoryNumber: "50200" },
    { description: "S3 storage", amount: 50.0 },
  ],
  classification: {
    overallCategoryNumber: "50200",
    overallCategoryName: "Hosting Fees",
    confidence: 0.93,
    isUncategorized: false,
  },
  recurring: { isRecurring: true, frequency: "monthly", reasoning: "Monthly billing period" },
  confidence: 0.94,
};

describe("readValidCachedBillOcr", () => {
  it("returns the parsed result when hash matches and the payload is schema-valid with a vendor name", () => {
    const cached = {
      result: GOLDEN_BILL,
      contextHash: CONTEXT_HASH,
      cachedAt: "2026-09-18T00:00:00.000Z",
    };
    const parsed = readValidCachedBillOcr(cached, CONTEXT_HASH);
    expect(parsed).not.toBeNull();
    expect(parsed?.vendor.name).toBe("AWS");
    expect(parsed?.invoice.amount).toBe(340.12);
    expect(parsed?.lineItems).toHaveLength(2);
  });

  it("returns null when the cache is missing so parseBillDocument re-parses", () => {
    expect(readValidCachedBillOcr(null, CONTEXT_HASH)).toBeNull();
    expect(readValidCachedBillOcr(undefined, CONTEXT_HASH)).toBeNull();
  });

  it("returns null when the category-context hash does not match", () => {
    expect(
      readValidCachedBillOcr({ result: GOLDEN_BILL, contextHash: "stale-hash" }, CONTEXT_HASH),
    ).toBeNull();
  });

  it("returns null for a truncated payload missing vendor so parseBillDocument re-parses", () => {
    const truncated = {
      invoice: { amount: 12.5 },
      lineItems: [],
    };
    expect(
      readValidCachedBillOcr({ result: truncated, contextHash: CONTEXT_HASH }, CONTEXT_HASH),
    ).toBeNull();
  });

  it("returns null when vendor.name is missing from an otherwise present object", () => {
    expect(
      readValidCachedBillOcr(
        { result: { ...GOLDEN_BILL, vendor: {} }, contextHash: CONTEXT_HASH },
        CONTEXT_HASH,
      ),
    ).toBeNull();
  });

  it("returns null when vendor.name is blank even if Zod would accept the string", () => {
    expect(
      readValidCachedBillOcr(
        { result: { ...GOLDEN_BILL, vendor: { name: "" } }, contextHash: CONTEXT_HASH },
        CONTEXT_HASH,
      ),
    ).toBeNull();
    expect(
      readValidCachedBillOcr(
        { result: { ...GOLDEN_BILL, vendor: { name: "   " } }, contextHash: CONTEXT_HASH },
        CONTEXT_HASH,
      ),
    ).toBeNull();
  });

  it("returns null when required invoice.amount is missing", () => {
    const { amount: _amount, ...invoice } = GOLDEN_BILL.invoice;
    expect(
      readValidCachedBillOcr(
        { result: { ...GOLDEN_BILL, invoice }, contextHash: CONTEXT_HASH },
        CONTEXT_HASH,
      ),
    ).toBeNull();
  });
});
