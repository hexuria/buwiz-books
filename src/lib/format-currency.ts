export function formatCurrency(
  amount: number | string,
  currencyCode: string = "USD",
  locale: string = "en-US",
): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "";

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    // Fallback if currency code is invalid
    return `${currencyCode} ${num.toFixed(2)}`;
  }
}
