/**
 * Remit withheld EWT to the BIR — Stage 3b.
 *
 * The withholding payment stored the agent fact. This writes the remittance
 * journal that clears EWT payable:
 *
 *   DR  EWT payable                   tax remitted
 *       CR  Cash / checking           the same amount
 *
 * Months 1–2 of a quarter remit on 0619-E. Month 3 remits the quarter on
 * 1601-EQ. Filing a 0619-E in month 3 double-remits.
 */
import { addAll, fromScaled, toScaled, ZERO } from "./money";
import { remittanceObligationsFor, type EwtFormCode } from "./ewt";

export interface EwtRemittanceSummary {
  formCode: EwtFormCode;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  taxWithheld: string;
  shouldPost: boolean;
  note: string;
}

export function summarizeEwtRemittance(input: {
  month: number;
  year: number;
  amounts: string[];
}): EwtRemittanceSummary {
  const [obligation] = remittanceObligationsFor(input.month, input.year);
  if (!obligation) {
    throw new Error(
      `No remittance obligation for ${input.year}-${String(input.month).padStart(2, "0")}`,
    );
  }
  const total = input.amounts.reduce((sum, amount) => addAll(sum, toScaled(amount)), ZERO);
  return {
    formCode: obligation.formCode,
    periodStart: obligation.periodStart,
    periodEnd: obligation.periodEnd,
    dueDate: obligation.dueDate,
    taxWithheld: fromScaled(total),
    shouldPost: total !== ZERO,
    note: obligation.note,
  };
}
