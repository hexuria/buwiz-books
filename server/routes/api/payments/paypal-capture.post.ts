/**
 * Nitro server route: POST /api/payments/paypal-capture
 * Captures an approved PayPal order and marks the invoice as paid.
 * Server-only — never bundled to the client.
 */
import { defineEventHandler, readBody, createError, getRequestIP } from "h3";
import { db } from "../../../../src/db";
import { invoices } from "../../../../src/db/schema/invoices";
import { organization } from "../../../../src/db/schema/auth";
import { eq } from "drizzle-orm";
import { recordCardInvoicePayment } from "../../../../src/lib/invoice-payments";
import { enforceRateLimit } from "../../../../src/lib/request-guards";
import { getOrganizationSecrets } from "../../../../src/lib/org-secrets";
import { parseOrgMetadata } from "../../../../src/lib/org-metadata";
import { moneyToCents } from "../../../../src/lib/money";
import { createLogger } from "../../../../src/lib/logger";

const logger = createLogger("api.payments.paypal-capture");

/**
 * PayPal order ids are opaque alphanumeric tokens (17 characters in practice,
 * 36 is the documented maximum). The id arrives on an unauthenticated request
 * body and is placed in the path of an outbound call that carries the
 * merchant's OAuth token, so it must not be able to contain "/", ".", "?", "#"
 * or an escape — those let a caller steer the request at another PayPal
 * endpoint (e.g. a refund) with the merchant's credentials.
 */
const PAYPAL_ORDER_ID_PATTERN = /^[A-Za-z0-9]{1,36}$/;

async function getPayPalToken(
  clientId: string,
  clientSecret: string,
  mode: string,
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw createError({ statusCode: 500, message: "PayPal is not configured." });
  }
  const base = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok)
    throw createError({ statusCode: 500, message: `PayPal auth failed: ${await res.text()}` });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ orderID: string; invoiceId: string }>(event);
  const { orderID, invoiceId } = body ?? {};
  if (!orderID || !invoiceId)
    throw createError({ statusCode: 400, message: "orderID and invoiceId are required" });
  if (typeof orderID !== "string" || !PAYPAL_ORDER_ID_PATTERN.test(orderID))
    throw createError({ statusCode: 400, message: "orderID is not a valid PayPal order id" });
  enforceRateLimit({
    routeKey: "payments:paypal-capture",
    orgId: invoiceId,
    userId: getRequestIP(event, { xForwardedFor: true }) ?? "unknown",
    limit: 10,
    windowMs: 60_000,
  });

  // Fetch the invoice BEFORE capturing so the payment can be verified against it
  const [invoice] = await db
    .select({
      id: invoices.id,
      total: invoices.total,
      balanceDue: invoices.balanceDue,
      status: invoices.status,
      organizationId: invoices.organizationId,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!invoice) throw createError({ statusCode: 404, message: "Invoice not found" });
  if (invoice.status === "paid")
    throw createError({ statusCode: 400, message: "Invoice is already paid" });
  if (invoice.status === "voided")
    throw createError({ statusCode: 400, message: "Invoice is voided" });

  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, invoice.organizationId))
    .limit(1);
  const meta = parseOrgMetadata(org?.metadata);
  const secrets = await getOrganizationSecrets(db, invoice.organizationId);
  if (!meta.paypalClientId || !secrets.paypalClientSecret) {
    throw createError({ statusCode: 500, message: "PayPal is not configured for this business." });
  }
  const mode = meta.paypalMode ?? "sandbox";
  const accessToken = await getPayPalToken(meta.paypalClientId, secrets.paypalClientSecret, mode);
  const base = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    // Log the upstream detail server-side only; echoing it back would turn this
    // route into an oracle over the merchant's PayPal account.
    logger.error("PayPal capture failed", {
      invoiceId,
      status: res.status,
      error: await res.text(),
    });
    throw createError({ statusCode: 500, message: "PayPal capture failed." });
  }

  const capture = (await res.json()) as {
    status: string;
    purchase_units: Array<{
      reference_id?: string;
      payments: {
        captures: Array<{
          id: string;
          status?: string;
          amount?: { currency_code: string; value: string };
        }>;
      };
    }>;
  };

  const unit = capture.purchase_units?.[0];
  const capturedPayment = unit?.payments?.captures?.[0];
  const captureID = capturedPayment?.id ?? "";

  if (capture.status === "COMPLETED") {
    // Verify the PayPal order was created for THIS invoice.
    // paypal-order.post.ts sets reference_id = invoice.id at order creation.
    if (unit?.reference_id !== invoice.id) {
      throw createError({
        statusCode: 400,
        message: "Payment verification failed: order does not match this invoice.",
      });
    }

    // Verify the captured amount covers the invoice balance due (USD only,
    // matching the currency used at order creation).
    const capturedValue = capturedPayment?.amount?.value ?? "0";
    const capturedAmount = Number(capturedValue);
    const currency = capturedPayment?.amount?.currency_code;
    if (currency !== "USD" || moneyToCents(capturedValue) !== moneyToCents(invoice.balanceDue)) {
      throw createError({
        statusCode: 400,
        message: "Payment verification failed: captured amount does not match the balance due.",
      });
    }

    // Post the payment to the general ledger (DR deposit, CR A/R) and update the invoice's
    // paid/balance/status. Idempotent on captureID so webhook/retry double-fires are safe.
    await recordCardInvoicePayment({
      invoiceId,
      amount: capturedAmount,
      paidVia: "paypal",
      externalRef: captureID || orderID,
      currency,
    });
  }

  return { status: capture.status, captureID };
});
