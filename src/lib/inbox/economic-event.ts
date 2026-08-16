import {
  ECONOMIC_EVENT_CLASSES,
  type EconomicEventClass,
  type TransactionDirection,
} from "./duplicate-matcher";

export interface EconomicEventClassification {
  economicEventClass: EconomicEventClass;
  direction: TransactionDirection;
}

const REVIEWER_EDITABLE_SOURCE_TYPES = new Set([
  "document_upload",
  "email_attachment",
  "email_body",
  "receipt",
  "receipt_upload",
]);

export function isReviewerEditableEconomicEventSource(
  recordType: string | null | undefined,
): boolean {
  return Boolean(recordType && REVIEWER_EDITABLE_SOURCE_TYPES.has(recordType));
}

export function directionForEconomicEventClass(
  economicEventClass: EconomicEventClass,
): TransactionDirection {
  if (["purchase", "bill_accrual", "bill_payment", "payroll"].includes(economicEventClass)) {
    return "outflow";
  }
  if (["sale", "invoice_accrual", "invoice_payment"].includes(economicEventClass)) {
    return "inflow";
  }
  if (economicEventClass === "transfer") return "neutral";
  return "unknown";
}

/**
 * Source/provider event identity is authoritative. Reviewer-facing transaction
 * type can supply identity only while the source is still unknown; it may
 * confirm an existing event's direction but must never silently turn a payment,
 * transfer, payroll run, or accrual into a generic purchase/sale.
 */
export function preserveAuthoritativeEconomicEvent(
  proposed: EconomicEventClassification,
  existingEconomicEventClass: string | null | undefined,
  options: { authoritative?: boolean } = {},
): EconomicEventClassification {
  if (options.authoritative === false) return proposed;
  const authoritativeClass =
    existingEconomicEventClass &&
    existingEconomicEventClass !== "other" &&
    ECONOMIC_EVENT_CLASSES.includes(existingEconomicEventClass as EconomicEventClass)
      ? (existingEconomicEventClass as EconomicEventClass)
      : null;
  if (!authoritativeClass) return proposed;

  const authoritativeDirection = directionForEconomicEventClass(authoritativeClass);
  if (proposed.direction !== "unknown" && proposed.direction !== authoritativeDirection) {
    throw new Error(
      `The selected transaction type conflicts with the source's ${authoritativeClass.replaceAll("_", " ")} economic event.`,
    );
  }
  return {
    economicEventClass: authoritativeClass,
    direction: authoritativeDirection,
  };
}
