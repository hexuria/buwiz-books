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
