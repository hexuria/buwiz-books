// ============================================================================
// Bill OCR client-side result discriminant.
//
// parseBillDocument returns either ParsedBillData or
// `{ status: "needs_review", issues }`. TanStack/HTTP error payloads also
// carry a `status` key (a number) and often have no `issues`. `"status" in`
// therefore cannot be the discriminant — it would treat `{ status: 500 }` as
// needs_review and then throw on `issues.slice`.
// ============================================================================

export interface BillOcrNeedsReview {
  status: "needs_review";
  issues?: unknown;
}

export function isBillOcrNeedsReview(value: unknown): value is BillOcrNeedsReview {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "needs_review"
  );
}

/** Issues list for the upload-job error message; never throws on a missing array. */
export function billOcrReviewIssues(result: BillOcrNeedsReview): string[] {
  return Array.isArray(result.issues) ? result.issues.map(String) : ["unknown validation issue"];
}
