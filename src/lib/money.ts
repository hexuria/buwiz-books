/**
 * Fixed-precision helpers for the application's two-decimal currencies.
 *
 * Monetary values are converted to integer minor units before arithmetic so invoice
 * totals and payment balances never depend on binary floating-point addition.
 */
export function moneyToCents(value: string | number, field = "amount"): number {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${field} must be a valid monetary amount`);
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const thirdDigit = Number(fraction[2] ?? "0");
  const padded = fraction.padEnd(2, "0");
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (thirdDigit >= 5) cents += 1;
  cents = negative ? -cents : cents;

  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${field} is outside the supported range`);
  }
  return cents;
}

export function centsToMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("Money cents must be a safe integer");
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function calculateLineAmountCents(
  quantity: string | number,
  unitPrice: string | number,
): number {
  const quantityNumber = Number(quantity);
  if (!Number.isFinite(quantityNumber) || quantityNumber < 0) {
    throw new Error("Line-item quantity must be a non-negative number");
  }
  const unitPriceCents = moneyToCents(unitPrice, "Line-item unit price");
  if (unitPriceCents < 0) throw new Error("Line-item unit price cannot be negative");
  return Math.round(quantityNumber * unitPriceCents);
}

export type InvoiceAmounts = {
  lineAmounts: string[];
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
};

export function calculateInvoiceAmounts(
  lineItems: Array<{ quantity: string | number; unitPrice: string | number }>,
  discountAmount: string | number,
  taxAmount: string | number,
): InvoiceAmounts {
  const lineAmountCents = lineItems.map((item) =>
    calculateLineAmountCents(item.quantity, item.unitPrice),
  );
  const subtotalCents = lineAmountCents.reduce((sum, amount) => sum + amount, 0);
  const discountCents = moneyToCents(discountAmount, "Discount");
  const taxCents = moneyToCents(taxAmount, "Tax");

  if (discountCents < 0 || discountCents > subtotalCents) {
    throw new Error("Discount must be between zero and the invoice subtotal");
  }
  if (taxCents < 0) throw new Error("Tax cannot be negative");

  const totalCents = subtotalCents - discountCents + taxCents;
  return {
    lineAmounts: lineAmountCents.map(centsToMoney),
    subtotal: centsToMoney(subtotalCents),
    discountAmount: centsToMoney(discountCents),
    taxAmount: centsToMoney(taxCents),
    total: centsToMoney(totalCents),
  };
}
