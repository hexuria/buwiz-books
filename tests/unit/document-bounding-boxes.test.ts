/**
 * Bounding-box identity is `(page, fieldId)`.
 *
 * Older rows encoded the page into the id (`p3_vendor_name`), which silently
 * broke every consumer lookup keyed on field TYPE — colour tables, friendly
 * labels, `line_item_` matching — for every page after the first. The read
 * path normalizes those ids away, so these cases pin the exact shape of that
 * normalization, including the ids it must leave alone.
 */
import { describe, expect, it } from "vitest";
import {
  isDocumentBoundingBox,
  normalizeBoundingBoxFieldId,
  parseDocumentBoundingBoxes,
} from "@/lib/document-types";

function box(overrides: Record<string, unknown> = {}) {
  return {
    fieldId: "vendor_name",
    label: "Vendor",
    bbox: [0.1, 0.2, 0.3, 0.4],
    page: 0,
    ...overrides,
  };
}

describe("normalizeBoundingBoxFieldId", () => {
  it("strips a single-digit legacy page prefix", () => {
    expect(normalizeBoundingBoxFieldId("p1_vendor_name")).toBe("vendor_name");
  });

  it("strips a multi-digit legacy page prefix", () => {
    expect(normalizeBoundingBoxFieldId("p12_total_amount")).toBe("total_amount");
  });

  it("leaves a bare field id untouched", () => {
    expect(normalizeBoundingBoxFieldId("vendor_name")).toBe("vendor_name");
    expect(normalizeBoundingBoxFieldId("total_amount")).toBe("total_amount");
  });

  it("does not eat the trailing index of a line-item id", () => {
    // `line_item_3` is a legitimate field id whose `_3` is its ordinal. The
    // prefix pattern is anchored, so only a LEADING `p{n}_` is removed.
    expect(normalizeBoundingBoxFieldId("line_item_3")).toBe("line_item_3");
    expect(normalizeBoundingBoxFieldId("p2_line_item_3")).toBe("line_item_3");
  });

  it("only strips a prefix that is literally p + digits + underscore", () => {
    // Field ids that merely start with "p" must survive intact.
    expect(normalizeBoundingBoxFieldId("payment_terms")).toBe("payment_terms");
    expect(normalizeBoundingBoxFieldId("po_number")).toBe("po_number");
    expect(normalizeBoundingBoxFieldId("p_1_weird")).toBe("p_1_weird");
    // …and a prefix that is not at the start is not a prefix.
    expect(normalizeBoundingBoxFieldId("total_p1_amount")).toBe("total_p1_amount");
  });
});

describe("isDocumentBoundingBox", () => {
  it("accepts a complete box and its optional fields", () => {
    expect(isDocumentBoundingBox(box())).toBe(true);
    expect(isDocumentBoundingBox(box({ text: "ACME", lineIndex: 2 }))).toBe(true);
  });

  it("rejects anything missing or mistyped", () => {
    expect(isDocumentBoundingBox(null)).toBe(false);
    expect(isDocumentBoundingBox("vendor_name")).toBe(false);
    expect(isDocumentBoundingBox(box({ fieldId: 7 }))).toBe(false);
    expect(isDocumentBoundingBox(box({ label: undefined }))).toBe(false);
    expect(isDocumentBoundingBox(box({ page: "0" }))).toBe(false);
    expect(isDocumentBoundingBox(box({ bbox: [0.1, 0.2, 0.3] }))).toBe(false);
    expect(isDocumentBoundingBox(box({ bbox: [0.1, 0.2, 0.3, "0.4"] }))).toBe(false);
    expect(isDocumentBoundingBox(box({ bbox: "0.1,0.2,0.3,0.4" }))).toBe(false);
    expect(isDocumentBoundingBox(box({ text: 12 }))).toBe(false);
    expect(isDocumentBoundingBox(box({ lineIndex: "2" }))).toBe(false);
  });
});

describe("parseDocumentBoundingBoxes", () => {
  it("returns an empty array for anything that is not an array", () => {
    expect(parseDocumentBoundingBoxes(null)).toEqual([]);
    expect(parseDocumentBoundingBoxes(undefined)).toEqual([]);
    expect(parseDocumentBoundingBoxes({ boxes: [] })).toEqual([]);
    expect(parseDocumentBoundingBoxes("[]")).toEqual([]);
    expect(parseDocumentBoundingBoxes(42)).toEqual([]);
  });

  it("normalizes legacy prefixes while preserving every other field", () => {
    const parsed = parseDocumentBoundingBoxes([
      box({ fieldId: "p1_vendor_name", page: 1, text: "ACME", lineIndex: 0 }),
      box({ fieldId: "p12_total_amount", page: 11 }),
      box({ fieldId: "line_item_3", page: 0 }),
    ]);
    expect(parsed.map((entry) => entry.fieldId)).toEqual([
      "vendor_name",
      "total_amount",
      "line_item_3",
    ]);
    expect(parsed[0]).toMatchObject({ page: 1, label: "Vendor", text: "ACME", lineIndex: 0 });
    expect(parsed[0].bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
    // Position stays in `page` — normalization must not renumber it.
    expect(parsed.map((entry) => entry.page)).toEqual([1, 11, 0]);
  });

  it("drops malformed entries instead of failing the whole read", () => {
    const parsed = parseDocumentBoundingBoxes([
      box({ fieldId: "p1_vendor_name" }),
      null,
      "not-a-box",
      { fieldId: "orphan" },
      box({ bbox: [0, 1, 2] }),
      box({ page: null }),
      box({ fieldId: "total_amount", page: 1 }),
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((entry) => entry.fieldId)).toEqual(["vendor_name", "total_amount"]);
  });

  it("returns already-normal boxes unchanged, without copying them", () => {
    const clean = box({ fieldId: "invoice_number" });
    const [parsed] = parseDocumentBoundingBoxes([clean]);
    expect(parsed).toBe(clean);
  });
});
