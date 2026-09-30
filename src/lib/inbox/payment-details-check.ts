// ============================================================================
// The payment-details-change check (inbox v2 §5).
//
// A document that asks to be paid to a bank account other than the one on
// file for a known payee is the classic invoice-fraud path, so it always needs
// a human: the finding is blocking, the system never resolves it (not even a
// reviewer's line edit clears it), and nothing ever copies the document's bank
// details onto the party. Evidence carries last-four digits only.
// ============================================================================

import { createHash } from "node:crypto";
import type { DbExecutor } from "@/db";
import { reviewFindings } from "@/db/schema/inbox";
import { detectPaymentDetailsChange } from "@/lib/party-match/normalize";
import { loadPartyPaymentDetails } from "@/lib/party-match/queries";
import type { DocumentFacts } from "./candidate-document-facts";

/** System rule raised when a document's payee bank details differ from the party's. */
export const PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY = "party_payment_details_changed";

function paymentDetailsFingerprint(
  candidateId: string,
  partyId: string,
  printed: { accountNumber: string | null; routingNumber: string | null },
): string {
  const digest = createHash("sha256")
    .update(`${printed.accountNumber ?? ""}\0${printed.routingNumber ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${candidateId}:party-payment-details:${partyId}:${digest}`;
}

/**
 * Raise the blocking payment-details finding when the document's payee bank
 * details differ from the party's stored ones. Shared with the reviewer's
 * correction path. Idempotent per (candidate, party, printed details): a
 * finding a human already resolved for these exact details stays resolved.
 */
export async function raisePaymentDetailsFindingIfChanged(
  db: DbExecutor,
  input: {
    orgId: string;
    inboxItemId: string;
    candidateId: string;
    partyId: string;
    facts: Pick<
      DocumentFacts,
      "payeeBankAccountNumber" | "payeeBankRoutingNumber" | "paymentDetailsDocumentId"
    >;
  },
): Promise<boolean> {
  const printed = {
    accountNumber: input.facts.payeeBankAccountNumber,
    routingNumber: input.facts.payeeBankRoutingNumber,
  };
  if (!printed.accountNumber && !printed.routingNumber) return false;
  const party = await loadPartyPaymentDetails(db, input.orgId, input.partyId);
  if (!party) return false;
  const change = detectPaymentDetailsChange(party, printed);
  if (!change) return false;
  await db
    .insert(reviewFindings)
    .values({
      organizationId: input.orgId,
      inboxItemId: input.inboxItemId,
      candidateId: input.candidateId,
      ruleKey: PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY,
      impact: "blocking",
      subjectType: "transaction_candidate",
      subjectId: input.candidateId,
      fingerprint: paymentDetailsFingerprint(input.candidateId, input.partyId, printed),
      message: `This document asks for payment to bank details that differ from the ones on file for ${party.name.slice(0, 120)}. Confirm the change with the payee through a contact you already trust before approving.`,
      evidence: {
        partyId: party.id,
        fields: change.fields,
        stored: change.stored,
        document: change.document,
        documentId: input.facts.paymentDetailsDocumentId,
      },
    })
    .onConflictDoNothing();
  return true;
}
