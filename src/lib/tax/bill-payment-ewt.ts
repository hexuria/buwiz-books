/**
 * Split a bill payment when we withheld EWT.
 *
 * The payment amount is the A/P settlement — the full bill claim being
 * extinguished. Cash is that amount net of withholding. Treating the withheld
 * peso as a discount loses the payable we still owe the BIR.
 *
 *   DR  Accounts payable          paymentAmount
 *       CR  Cash                  paymentAmount − withheld
 *       CR  EWT payable           withheld
 */
import { fromScaled, toScaled, ZERO } from "./money";

export interface BillPaymentEwtSplit {
  accountsPayable: string;
  cash: string;
  ewtPayable: string;
  withheld: boolean;
}

export function splitBillPaymentWithEwt(
  paymentAmount: string,
  ewtWithheld = "0",
): BillPaymentEwtSplit {
  const payment = toScaled(paymentAmount);
  const withheld = toScaled(ewtWithheld);
  if (payment <= ZERO) throw new Error("Payment amount must be positive.");
  if (withheld < ZERO) throw new Error("EWT withheld cannot be negative.");
  if (withheld > payment) {
    throw new Error(
      `EWT withheld (${ewtWithheld}) exceeds the payment (${paymentAmount}). That would credit cash as a negative.`,
    );
  }
  return {
    accountsPayable: fromScaled(payment),
    cash: fromScaled((payment - withheld) as typeof payment),
    ewtPayable: fromScaled(withheld),
    withheld: withheld !== ZERO,
  };
}
