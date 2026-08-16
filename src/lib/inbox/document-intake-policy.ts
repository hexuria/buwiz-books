export interface StandaloneTransactionFacts {
  economicEventClass: string;
  direction: string;
  originalAmount: string | null;
  effectiveDate: string | null;
}

const PROVEN_OTHER_EVENT_CLASSES = new Set([
  "purchase",
  "sale",
  "bill_accrual",
  "bill_payment",
  "invoice_accrual",
  "invoice_payment",
]);

/**
 * Standalone uploads create economic Inbox candidates only when the file is a
 * known single-transaction document, or when extraction proves that an
 * otherwise-unclassified file represents one concrete event.
 */
export function isStandaloneTransactionBearing(
  documentType: string,
  facts: StandaloneTransactionFacts,
): boolean {
  if (documentType === "receipt" || documentType === "bill" || documentType === "invoice") {
    return true;
  }
  if (documentType !== "other") return false;
  return Boolean(
    PROVEN_OTHER_EVENT_CLASSES.has(facts.economicEventClass) &&
    facts.direction !== "unknown" &&
    facts.originalAmount &&
    facts.effectiveDate,
  );
}
