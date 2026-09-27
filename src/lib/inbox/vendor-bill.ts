/**
 * Which Inbox candidates are vendor bills.
 *
 * Bills-editor submissions are typed "bill". Emailed and uploaded papers arrive
 * as email_transaction / document_transaction whatever they are, so they count
 * as bills when their accounting (origin) source is classified bill_accrual,
 * whether by extraction or by a reviewer's explicit correction.
 */
const EXTRACTED_CANDIDATE_TYPES = new Set(["email_transaction", "document_transaction"]);

export function isVendorBillCandidate(
  candidateType: string,
  originEconomicEventClass: string | null,
): boolean {
  if (candidateType === "bill") return true;
  return (
    EXTRACTED_CANDIDATE_TYPES.has(candidateType) && originEconomicEventClass === "bill_accrual"
  );
}
