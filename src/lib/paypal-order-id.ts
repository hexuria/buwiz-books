const PAYPAL_ORDER_ID_PATTERN = /^[A-Za-z0-9]{1,36}$/;

/** Validate an opaque PayPal order id before it can enter a credentialed URL. */
export function isValidPayPalOrderId(value: unknown): value is string {
  return typeof value === "string" && PAYPAL_ORDER_ID_PATTERN.test(value);
}
