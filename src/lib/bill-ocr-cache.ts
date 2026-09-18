import { createHash } from "node:crypto";
import { billOcrOutputSchema, type BillOcrOutput } from "./ai/schemas/bill-ocr";

interface BillOcrCategoryContext {
  accountNumber: string;
  name: string;
  type: string;
  subtype?: string;
  parentName?: string;
}

export function billOcrContextHash(categories: readonly BillOcrCategoryContext[]): string {
  const stableCategories = [...categories].sort((left, right) =>
    `${left.accountNumber}:${left.name}`.localeCompare(`${right.accountNumber}:${right.name}`),
  );
  return createHash("sha256").update(JSON.stringify(stableCategories)).digest("hex");
}

export interface CachedBillOcr {
  result?: unknown;
  contextHash?: string;
  cachedAt?: string;
}

/**
 * Reuse a document's cached bill OCR only when the category-context hash
 * matches AND the payload still satisfies the live Zod schema with a
 * non-blank vendor name. Invalid or truncated cache rows (historical
 * writes, partial objects) must fall through to a fresh `aiComplete`.
 */
export function readValidCachedBillOcr(
  cached: CachedBillOcr | null | undefined,
  contextHash: string,
): BillOcrOutput | null {
  if (!cached || cached.contextHash !== contextHash) return null;
  const parsed = billOcrOutputSchema.safeParse(cached.result);
  if (!parsed.success) return null;
  if (!parsed.data.vendor.name.trim()) return null;
  return parsed.data;
}
