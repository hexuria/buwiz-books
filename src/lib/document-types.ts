/**
 * Bounding-box identity is `(page, fieldId)`.
 *
 * `fieldId` is a SEMANTIC TYPE TAG — consumers look it up in colour tables
 * and friendly-label maps, and match it with `line_item_` patterns. Position
 * belongs in `page`, which is required here. Older rows encoded the page into
 * the id instead (`p3_vendor_name`), which silently broke every one of those
 * lookups for pages after the first; `normalizeBoundingBoxFieldId` strips
 * that prefix on read so no migration is needed.
 */
export interface DocumentBoundingBox {
  fieldId: string;
  label: string;
  text?: string;
  bbox: [number, number, number, number];
  page: number;
  lineIndex?: number;
}

export interface DocumentViewerData {
  imageUrl: string | null;
  imageUrls: string[];
  pageCount: number;
  documentUrl: string | null;
  boundingBoxes: DocumentBoundingBox[];
  filename: string;
}

const LEGACY_PAGE_PREFIX = /^p\d+_/;

/** Strip the legacy `p{n}_` page prefix from a stored fieldId. */
export function normalizeBoundingBoxFieldId(fieldId: string): string {
  return fieldId.replace(LEGACY_PAGE_PREFIX, "");
}

export function isDocumentBoundingBox(value: unknown): value is DocumentBoundingBox {
  if (!value || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  return (
    typeof box.fieldId === "string" &&
    typeof box.label === "string" &&
    Array.isArray(box.bbox) &&
    box.bbox.length === 4 &&
    box.bbox.every((coord) => typeof coord === "number") &&
    typeof box.page === "number" &&
    (box.text === undefined || typeof box.text === "string") &&
    (box.lineIndex === undefined || typeof box.lineIndex === "number")
  );
}

/** Validate and normalize a stored `ocr_bounding_boxes` column value. */
export function parseDocumentBoundingBoxes(value: unknown): DocumentBoundingBox[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isDocumentBoundingBox).map((box) => {
    const fieldId = normalizeBoundingBoxFieldId(box.fieldId);
    return fieldId === box.fieldId ? box : { ...box, fieldId };
  });
}
