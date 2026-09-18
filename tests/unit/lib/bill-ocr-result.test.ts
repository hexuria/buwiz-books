import { describe, expect, it } from "vitest";
import { billOcrReviewIssues, isBillOcrNeedsReview } from "../../../src/lib/bill-ocr-result";

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
