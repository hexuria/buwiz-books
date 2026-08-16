/**
 * Nitro server route: POST /api/payments/paypal-order
 * Creates a PayPal order for an invoice.
 * Server-only — never bundled to the client.
 */
import { defineEventHandler, readBody, createError, getRequestIP } from "h3";
import { db } from "../../../../src/db";
import { invoices } from "../../../../src/db/schema/invoices";
import { organization } from "../../../../src/db/schema/auth";
import { eq } from "drizzle-orm";
import { enforceRateLimit } from "../../../../src/lib/request-guards";
import { getOrganizationSecrets } from "../../../../src/lib/org-secrets";
import { parseOrgMetadata } from "../../../../src/lib/org-metadata";
import { centsToMoney, moneyToCents } from "../../../../src/lib/money";

async function getPayPalToken(
  clientId: string,
  clientSecret: string,
  mode: string,
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw createError({ statusCode: 500, message: "PayPal is not configured on this server." });
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
  const body = await readBody<{ invoiceId: string }>(event);
  const { invoiceId } = body ?? {};
  if (!invoiceId) throw createError({ statusCode: 400, message: "invoiceId is required" });
  enforceRateLimit({
    routeKey: "payments:paypal-order",
    orgId: invoiceId,
    userId: getRequestIP(event, { xForwardedFor: true }) ?? "unknown",
    limit: 10,
    windowMs: 60_000,
  });

  const [invoice] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
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
  if (!["sent", "viewed", "overdue", "partial"].includes(invoice.status)) {
    throw createError({ statusCode: 400, message: "Invoice is not payable" });
  }

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

  const res = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: invoice.id,
          description: `Invoice #${invoice.invoiceNumber}`,
          amount: { currency_code: "USD", value: centsToMoney(moneyToCents(invoice.balanceDue)) },
        },
      ],
    }),
  });

  if (!res.ok)
    throw createError({
      statusCode: 500,
      message: `PayPal create order failed: ${await res.text()}`,
    });
  const order = (await res.json()) as { id: string };
  return { orderID: order.id };
});
