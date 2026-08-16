/**
 * Nitro server route: POST /api/payments/stripe-checkout
 * Creates a Stripe Checkout Session for an invoice.
 * Server-only — never bundled to the client.
 */
import { defineEventHandler, readBody, createError, getRequestIP } from "h3";
import Stripe from "stripe";
import { db } from "../../../../src/db";
import { invoices } from "../../../../src/db/schema/invoices";
import { parties } from "../../../../src/db/schema/parties";
import { organization } from "../../../../src/db/schema/auth";
import { eq } from "drizzle-orm";
import { enforceRateLimit } from "../../../../src/lib/request-guards";
import { getOrganizationSecrets } from "../../../../src/lib/org-secrets";
import { moneyToCents } from "../../../../src/lib/money";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ invoiceId: string }>(event);

  const { invoiceId } = body ?? {};
  if (!invoiceId) throw createError({ statusCode: 400, message: "invoiceId is required" });
  enforceRateLimit({
    routeKey: "payments:stripe-checkout",
    orgId: invoiceId,
    userId: getRequestIP(event, { xForwardedFor: true }) ?? "unknown",
    limit: 10,
    windowMs: 60_000,
  });

  // Fetch invoice
  const [invoice] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      balanceDue: invoices.balanceDue,
      status: invoices.status,
      customerId: invoices.customerId,
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
  if (Number(invoice.balanceDue) <= 0)
    throw createError({ statusCode: 400, message: "No balance due" });
  if (!["sent", "viewed", "overdue", "partial"].includes(invoice.status)) {
    throw createError({ statusCode: 400, message: "Invoice is not payable" });
  }

  const secretKey = (await getOrganizationSecrets(db, invoice.organizationId)).stripeSecretKey;
  if (!secretKey) {
    throw createError({ statusCode: 500, message: "Stripe is not configured for this business." });
  }
  const stripe = new Stripe(secretKey);

  // Fetch org
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, invoice.organizationId))
    .limit(1);

  // Fetch customer email
  let customerEmail: string | undefined;
  if (invoice.customerId) {
    const [party] = await db
      .select({ email: parties.email })
      .from(parties)
      .where(eq(parties.id, invoice.customerId))
      .limit(1);
    customerEmail = party?.email ?? undefined;
  }

  const amountCents = moneyToCents(invoice.balanceDue);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: `Invoice #${invoice.invoiceNumber}`,
            description: org?.name ? `Payment to ${org.name}` : undefined,
          },
        },
      },
    ],
    customer_email: customerEmail,
    metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    // Redirect URLs are derived server-side only — never taken from the request
    // body (client-supplied URLs enable post-payment phishing redirects).
    success_url: `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/invoices/pay/${invoice.id}?paid=true`,
    cancel_url: `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/invoices/pay/${invoice.id}`,
  });

  if (!session.url)
    throw createError({ statusCode: 500, message: "Stripe did not return a checkout URL" });

  return { url: session.url };
});
