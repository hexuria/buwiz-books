/**
 * Pure year-end true-up arithmetic.
 *
 * Kept out of annualization-posting.ts so unit tests can load it without
 * pulling the database client into the hermetic unit project.
 */
import { addAll, fromScaled, toScaled, ZERO, type ScaledMoney } from "./money";

export type AnnualizationOutcome = "exact" | "excess" | "deficiency";

export interface AnnualizationEntry {
  employeePartyId: string;
  refundOrDeficiency: string;
  uncollectibleDeficiency?: boolean;
}

export interface AnnualizationPostingSummary {
  totalRefund: string;
  totalCollectibleDeficiency: string;
  totalUncollectibleDeficiency: string;
  netWithholdingMovement: string;
  employeesRefunded: number;
  employeesWithDeficiency: number;
  outcome: AnnualizationOutcome;
}

export function summarizeAnnualizationPosting(
  entries: AnnualizationEntry[],
): AnnualizationPostingSummary {
  let refund = ZERO;
  let collectible = ZERO;
  let uncollectible = ZERO;
  let refunded = 0;
  let deficient = 0;

  for (const entry of entries) {
    const amount = toScaled(entry.refundOrDeficiency);
    if (amount > ZERO) {
      refund = addAll(refund, amount);
      refunded += 1;
    } else if (amount < ZERO) {
      const shortfall = -amount as ScaledMoney;
      deficient += 1;
      if (entry.uncollectibleDeficiency) {
        uncollectible = addAll(uncollectible, shortfall);
      } else {
        collectible = addAll(collectible, shortfall);
      }
    }
  }

  const totalDeficiency = addAll(collectible, uncollectible);
  const netMovement = (totalDeficiency - refund) as ScaledMoney;
  const outcome: AnnualizationOutcome =
    refund === ZERO && totalDeficiency === ZERO
      ? "exact"
      : refund > totalDeficiency
        ? "excess"
        : "deficiency";

  return {
    totalRefund: fromScaled(refund),
    totalCollectibleDeficiency: fromScaled(collectible),
    totalUncollectibleDeficiency: fromScaled(uncollectible),
    netWithholdingMovement: fromScaled(netMovement),
    employeesRefunded: refunded,
    employeesWithDeficiency: deficient,
    outcome,
  };
}
