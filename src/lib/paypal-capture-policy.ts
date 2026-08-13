import { isValidPayPalOrderId } from "./paypal-order-id";

export type PayPalCaptureInputResult =
  | { ok: true; orderId: string; invoiceId: string }
  | { ok: false; message: string };

/** Validate untrusted capture identifiers before any privileged side effect. */
export function validatePayPalCaptureInput(input: {
  orderId: unknown;
  invoiceId: unknown;
}): PayPalCaptureInputResult {
  if (!input.orderId || !input.invoiceId) {
    return { ok: false, message: "orderID and invoiceId are required" };
  }
  if (!isValidPayPalOrderId(input.orderId)) {
    return { ok: false, message: "orderID is not a valid PayPal order id" };
  }
  if (typeof input.invoiceId !== "string") {
    return { ok: false, message: "invoiceId is not valid" };
  }
  return { ok: true, orderId: input.orderId, invoiceId: input.invoiceId };
}
