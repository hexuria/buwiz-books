/**
 * CWT receivable arithmetic — Stage 3a.
 *
 * Kept DB-free so the hermetic unit project can load it without DATABASE_URL.
 * The paper and the ledger are two facts: this module only describes the
 * ledger fact. Posting lives in post-cwt-receivable.ts.
 *
 *   DR  CWT receivable                tax the customer withheld
 *       CR  Accounts receivable       the same amount
 *
 * The invoice is already fully owed. Cash arrived net of withholding. This
 * entry is what stops the withheld peso from looking like a discount.
 */
import { toScaled, ZERO } from "./money";

export class CwtAlreadyPostedError extends Error {
  constructor(certificateId: string, journalHeaderId: string) {
    super(
      `Certificate ${certificateId} already posted as journal ${journalHeaderId}. ` +
        `Posting it again would claim the same credit twice.`,
    );
    this.name = "CwtAlreadyPostedError";
  }
}

export class CwtNothingToPostError extends Error {
  constructor(certificateId: string) {
    super(`Certificate ${certificateId} withheld nothing, so there is no CWT receivable to post.`);
    this.name = "CwtNothingToPostError";
  }
}

export interface CwtReceivableSummary {
  taxWithheld: string;
  shouldPost: boolean;
}

export function summarizeCwtReceivable(taxWithheld: string): CwtReceivableSummary {
  const withheld = toScaled(taxWithheld);
  if (withheld < ZERO) {
    throw new Error(
      `CWT withheld cannot be negative (${taxWithheld}). A correction is its own reversing certificate.`,
    );
  }
  return { taxWithheld, shouldPost: withheld !== ZERO };
}
