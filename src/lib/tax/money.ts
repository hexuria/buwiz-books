/**
 * Money primitives for the Philippine tax engine.
 *
 * Built on `src/lib/inbox/money.ts` (BigInt at scale 8, matching the
 * `decimal(20,8)` ledger columns) rather than `src/lib/money.ts` (integer cents
 * at 2dp), per DECISIONS D-N6. The repo has both, and the bill/invoice posting
 * paths currently use NEITHER — they sum `Number.parseFloat` and call
 * `.toFixed(2)`. A 12% VAT or 5% EWT computed in one and asserted in another
 * disagrees at the sub-centavo boundary, so the tax layer commits to one.
 *
 * The BIR rounding rule is HALF-UP AT TWO DECIMAL PLACES, applied ONCE per tax
 * computation. This module states it explicitly at every site rather than
 * inheriting whatever a caller's helper does — the whole point of D-N6.
 *
 * Amounts cross this boundary as decimal STRINGS, never numbers: Drizzle returns
 * `decimal` as a string, and parsing to a float is exactly the bug the ledger
 * columns were widened to avoid.
 */
import { parseMoneyToScaled, scaledToMoney, MONEY_INTERNAL_SCALE } from "../inbox/money";

/** One centavo, expressed at the internal scale. 10^(8-2). */
const CENTAVO = 10n ** BigInt(MONEY_INTERNAL_SCALE - 2);

/** A peso amount held at scale 8. Branded so a raw bigint cannot masquerade as one. */
declare const SCALED_BRAND: unique symbol;
export type ScaledMoney = bigint & { readonly [SCALED_BRAND]?: true };

export function toScaled(value: string | number | null | undefined): ScaledMoney {
  return parseMoneyToScaled(value) as ScaledMoney;
}

export function fromScaled(value: ScaledMoney): string {
  return scaledToMoney(value);
}

/** Render at exactly two decimals — the form of every figure on a BIR return. */
export function toPesoString(value: ScaledMoney): string {
  const rounded = roundToCentavos(value);
  const negative = rounded < 0n;
  const unsigned = negative ? -rounded : rounded;
  const whole = unsigned / 10n ** BigInt(MONEY_INTERNAL_SCALE);
  const centavos = (unsigned % 10n ** BigInt(MONEY_INTERNAL_SCALE)) / CENTAVO;
  return `${negative ? "-" : ""}${whole}.${centavos.toString().padStart(2, "0")}`;
}

export function addAll(...values: ScaledMoney[]): ScaledMoney {
  return values.reduce((total, value) => total + value, 0n) as ScaledMoney;
}

/** Never below zero. Withholding tax and taxable bases have no negative meaning. */
export function clampAtZero(value: ScaledMoney): ScaledMoney {
  return (value < 0n ? 0n : value) as ScaledMoney;
}

export function maxOf(a: ScaledMoney, b: ScaledMoney): ScaledMoney {
  return (a > b ? a : b) as ScaledMoney;
}

export function minOf(a: ScaledMoney, b: ScaledMoney): ScaledMoney {
  return (a < b ? a : b) as ScaledMoney;
}

/**
 * The BIR rounding rule: half-up at two decimal places.
 *
 * Ties go AWAY FROM ZERO, which is the ordinary reading of "half-up". BIR does
 * not prescribe a rule for negatives because a negative tax does not arise;
 * the symmetric behaviour is chosen so a reversal rounds to the mirror of what
 * it reverses, rather than drifting by a centavo.
 */
export function roundToCentavos(value: ScaledMoney): ScaledMoney {
  const half = CENTAVO / 2n;
  const rounded =
    value >= 0n ? ((value + half) / CENTAVO) * CENTAVO : -(((-value + half) / CENTAVO) * CENTAVO);
  return rounded as ScaledMoney;
}

/**
 * `base × rateBps / 10000`, rounded half-up to centavos.
 *
 * Rates are basis points so they are exact integers — 1500 is 15%, with no
 * float anywhere. The division and the rounding happen in ONE step: dividing
 * first and rounding after introduces a systematic drift that shows up as
 * centavo disagreements between a return total and the sum of its detail rows,
 * which is precisely what the reconciliation invariant would flag.
 */
export function applyRateBps(base: ScaledMoney, rateBps: number): ScaledMoney {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new RangeError(`rateBps must be an integer in [0, 10000], received ${rateBps}`);
  }
  const denominator = 10_000n * CENTAVO;
  const numerator = base * BigInt(rateBps);
  const half = denominator / 2n;
  const centavos =
    numerator >= 0n ? (numerator + half) / denominator : -((-numerator + half) / denominator);
  return (centavos * CENTAVO) as ScaledMoney;
}

/** Percentage of a base, for the de minimis ceiling expressed as a % of the regional SMW. */
export function applyPercent(base: ScaledMoney, percent: number): ScaledMoney {
  return applyRateBps(base, Math.round(percent * 100));
}

/**
 * `total / divisor`, rounded half-up to centavos.
 *
 * The cumulative average method's Step 2 divides year-to-date compensation by
 * the number of payroll periods it spans, and the result is carried at two
 * decimals — not at full precision, and not truncated. RR 11-2018's own
 * Illustration 12 proves it: ₱215,000 ÷ 7 is printed as ₱30,714.29, and
 * ₱355,000 ÷ 11 as ₱32,272.73. Carrying full precision instead produces a flat
 * monthly figure and loses the characteristic centavo jitter the RR shows.
 *
 * BigInt division truncates, so the rounding is explicit here rather than
 * emergent.
 */
export function divideHalfUp(total: ScaledMoney, divisor: number): ScaledMoney {
  if (!Number.isInteger(divisor) || divisor <= 0) {
    throw new RangeError(`divisor must be a positive integer, received ${divisor}`);
  }
  const denominator = BigInt(divisor) * CENTAVO;
  const half = denominator / 2n;
  const centavos = total >= 0n ? (total + half) / denominator : -((-total + half) / denominator);
  return (centavos * CENTAVO) as ScaledMoney;
}

/** Multiply by a whole number of periods. Exact — no rounding, nothing to round. */
export function multiplyByPeriods(value: ScaledMoney, periods: number): ScaledMoney {
  if (!Number.isInteger(periods) || periods < 0) {
    throw new RangeError(`periods must be a non-negative integer, received ${periods}`);
  }
  return (value * BigInt(periods)) as ScaledMoney;
}

export const TAX_MONEY_SCALE = MONEY_INTERNAL_SCALE;
export const ZERO = 0n as ScaledMoney;
