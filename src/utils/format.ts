import { formatCurrency as formatCurrencyValue } from "@/lib/format-currency";

/**
 * Format string or number as currency, defaulting to the org/app fallback currency.
 * Handles null/undefined/0 gracefully.
 */
export function formatCurrency(
  amount: string | number | null | undefined,
  currency = "USD",
): string {
  if (!amount || amount === "0" || amount === 0) return formatCurrencyValue(0, currency);
  const num = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  const formatted = formatCurrencyValue(Math.abs(num), currency);
  return num < 0 ? `-${formatted}` : formatted;
}
