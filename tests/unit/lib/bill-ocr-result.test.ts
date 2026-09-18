import { describe, expect, it } from "vitest";
import {
  billOcrReviewIssues,
  findVendorByName,
  isBillOcrNeedsReview,
  requireBillVendorName,
} from "../../../src/lib/bill-ocr-result";

describe("isBillOcrNeedsReview", () => {
  it("accepts the server needs_review discriminant with issues", () => {
    expect(
      isBillOcrNeedsReview({ status: "needs_review", issues: ["invoice.amount: Required"] }),
    ).toBe(true);
  });

  it("accepts needs_review even when issues is missing", () => {
    expect(isBillOcrNeedsReview({ status: "needs_review" })).toBe(true);
  });

  it("does not treat an HTTP-style { status: 500 } payload as needs_review", () => {
    expect(isBillOcrNeedsReview({ status: 500, message: "Internal Server Error" })).toBe(false);
  });

  it("does not treat a successful bill OCR object as needs_review", () => {
    expect(
      isBillOcrNeedsReview({
        vendor: { name: "ACME GmbH" },
        invoice: { amount: 1234.56 },
        lineItems: [],
      }),
    ).toBe(false);
  });

  it("rejects null, primitives, and other status strings", () => {
    expect(isBillOcrNeedsReview(null)).toBe(false);
    expect(isBillOcrNeedsReview("needs_review")).toBe(false);
    expect(isBillOcrNeedsReview({ status: "error" })).toBe(false);
  });
});

describe("billOcrReviewIssues", () => {
  it("returns the provided issue strings", () => {
    expect(billOcrReviewIssues({ status: "needs_review", issues: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("falls back when issues is missing or not an array", () => {
    expect(billOcrReviewIssues({ status: "needs_review" })).toEqual(["unknown validation issue"]);
    expect(billOcrReviewIssues({ status: "needs_review", issues: "boom" })).toEqual([
      "unknown validation issue",
    ]);
  });
});

describe("requireBillVendorName", () => {
  const message =
    "Bill OCR result is missing a vendor name. Re-upload the document or create the bill manually.";

  it("returns the vendor name when present", () => {
    expect(requireBillVendorName({ vendor: { name: "AWS" } })).toBe("AWS");
  });

  it("throws a clear Error instead of TypeError when vendor is missing", () => {
    expect(() => requireBillVendorName({} as never)).toThrowError(message);
    expect(() => requireBillVendorName({ vendor: undefined })).toThrowError(message);
    expect(() => requireBillVendorName(null)).toThrowError(message);
    expect(() => requireBillVendorName(undefined)).toThrowError(message);
  });

  it("throws when vendor.name is blank", () => {
    expect(() => requireBillVendorName({ vendor: { name: "" } })).toThrowError(message);
    expect(() => requireBillVendorName({ vendor: { name: "   " } })).toThrowError(message);
  });
});

describe("findVendorByName", () => {
  it("matches a vendor case-insensitively", () => {
    const vendors = [
      { id: "1", name: "Acme GmbH" },
      { id: "2", name: "AWS" },
    ];
    expect(findVendorByName(vendors, "aws")?.id).toBe("2");
  });

  it("skips undefined and nameless entries instead of throwing", () => {
    const vendors = [undefined, { id: "1", name: undefined }, { id: "2", name: "AWS" }, null];
    expect(findVendorByName(vendors, "AWS")?.id).toBe("2");
    expect(findVendorByName(null, "AWS")).toBeUndefined();
    expect(findVendorByName(undefined, "AWS")).toBeUndefined();
  });
});
