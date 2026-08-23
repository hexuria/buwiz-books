const INTERNAL_SCALE = 8;
const SCALE_FACTOR = 10n ** BigInt(INTERNAL_SCALE);
const RATE_SCALE = 10;
const RATE_SCALE_FACTOR = 10n ** BigInt(RATE_SCALE);

function parseDecimalToScaled(
  value: string | number | null | undefined,
  scale: number,
  label: string,
): bigint {
  if (value == null || value === "") return 0n;
  const normalized = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > scale) {
    throw new Error(`${label} supports at most ${scale} decimal places`);
  }
  const factor = 10n ** BigInt(scale);
  const scaled = BigInt(whole) * factor + BigInt(fraction.padEnd(scale, "0"));
  return negative ? -scaled : scaled;
}

export function parseMoneyToScaled(value: string | number | null | undefined): bigint {
  return parseDecimalToScaled(value, INTERNAL_SCALE, "Money amount");
}

export function parseRateToScaled(value: string | number | null | undefined): bigint {
  return parseDecimalToScaled(value, RATE_SCALE, "Exchange rate");
}

export function scaledToMoney(value: bigint): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const whole = unsigned / SCALE_FACTOR;
  const fraction = (unsigned % SCALE_FACTOR).toString().padStart(INTERNAL_SCALE, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const rendered = trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
  return negative ? `-${rendered}` : rendered;
}

export function multiplyMoney(value: string, rate: string): string {
  const amount = parseMoneyToScaled(value);
  const scaledRate = parseRateToScaled(rate);
  const unroundedProduct = amount * scaledRate;
  const roundedProduct =
    unroundedProduct >= 0n
      ? (unroundedProduct + RATE_SCALE_FACTOR / 2n) / RATE_SCALE_FACTOR
      : (unroundedProduct - RATE_SCALE_FACTOR / 2n) / RATE_SCALE_FACTOR;
  return scaledToMoney(roundedProduct);
}

/**
 * Convert a balanced set of journal lines to functional currency WITHOUT
 * breaking the balance (audit, ledger core).
 *
 * Per-line conversion rounds each product half-up at scale 8, so the two
 * sides could drift apart by a few 1e-8 units even when the original entry
 * balanced exactly — and the balance constraint then rejects input the user
 * cannot fix. Because sum(amount_i × rate) = (sum amount_i) × rate exactly
 * in scaled-integer arithmetic, both sides share ONE true rounded target
 * when the originals balance; each side's per-line roundings are nudged by
 * 1e-8 steps (largest-remainder first) until the side sums to that target.
 * When the originals do NOT balance, lines convert plainly — the caller's
 * balance validation then reports the genuine imbalance.
 */
export function convertBalancedLines(
  lines: Array<{ originalDebit: string | null; originalCredit: string | null }>,
  rate: string,
): Array<{ functionalDebit: string | null; functionalCredit: string | null }> {
  const scaledRate = parseRateToScaled(rate);
  const roundProduct = (product: bigint): bigint =>
    product >= 0n
      ? (product + RATE_SCALE_FACTOR / 2n) / RATE_SCALE_FACTOR
      : (product - RATE_SCALE_FACTOR / 2n) / RATE_SCALE_FACTOR;

  type Side = {
    index: number;
    unrounded: bigint;
    rounded: bigint;
  };
  const debits: Side[] = [];
  const credits: Side[] = [];
  let originalDebitTotal = 0n;
  let originalCreditTotal = 0n;

  for (const [index, line] of lines.entries()) {
    if (line.originalDebit != null && line.originalDebit !== "") {
      const amount = parseMoneyToScaled(line.originalDebit);
      originalDebitTotal += amount;
      const unrounded = amount * scaledRate;
      debits.push({ index, unrounded, rounded: roundProduct(unrounded) });
    }
    if (line.originalCredit != null && line.originalCredit !== "") {
      const amount = parseMoneyToScaled(line.originalCredit);
      originalCreditTotal += amount;
      const unrounded = amount * scaledRate;
      credits.push({ index, unrounded, rounded: roundProduct(unrounded) });
    }
  }

  const balanced = originalDebitTotal === originalCreditTotal && originalDebitTotal !== 0n;
  if (balanced) {
    const target = roundProduct(originalDebitTotal * scaledRate);
    for (const side of [debits, credits]) {
      let diff = target - side.reduce((sum, entry) => sum + entry.rounded, 0n);
      if (diff === 0n) continue;
      const step = diff > 0n ? 1n : -1n;
      // Largest-remainder: nudge the lines whose rounding moved furthest in
      // the direction we need, one 1e-8 unit at a time.
      const byRemainder = [...side].sort((a, b) => {
        const ra = a.unrounded - a.rounded * RATE_SCALE_FACTOR;
        const rb = b.unrounded - b.rounded * RATE_SCALE_FACTOR;
        const cmp = step > 0n ? rb - ra : ra - rb;
        return cmp > 0n ? 1 : cmp < 0n ? -1 : 0;
      });
      let cursor = 0;
      while (diff !== 0n) {
        byRemainder[cursor % byRemainder.length].rounded += step;
        diff -= step;
        cursor += 1;
      }
    }
  }

  const debitByIndex = new Map(debits.map((entry) => [entry.index, entry.rounded]));
  const creditByIndex = new Map(credits.map((entry) => [entry.index, entry.rounded]));
  return lines.map((_, index) => ({
    functionalDebit: debitByIndex.has(index) ? scaledToMoney(debitByIndex.get(index)!) : null,
    functionalCredit: creditByIndex.has(index) ? scaledToMoney(creditByIndex.get(index)!) : null,
  }));
}

export function sumMoney(values: Array<string | null | undefined>): string {
  return scaledToMoney(values.reduce((total, value) => total + parseMoneyToScaled(value), 0n));
}

export function compareMoney(left: string, right: string): number {
  const a = parseMoneyToScaled(left);
  const b = parseMoneyToScaled(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

export function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Currency must be a three-letter ISO 4217 code");
  }
  return currency;
}

export function formatMoney(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(`Invalid money amount: ${value}`);
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

export const MONEY_INTERNAL_SCALE = INTERNAL_SCALE;
export const RATE_INTERNAL_SCALE = RATE_SCALE;
