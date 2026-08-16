/**
 * Nitro server route: POST /api/payments/stripe-webhook
 * Receives Stripe Checkout events and records the payment against the invoice.
 * Server-only. Without this route a completed Stripe card payment would never mark the
 * invoice paid or post a ledger entry.
 *
 * Configure the endpoint in the Stripe dashboard and set STRIPE_WEBHOOK_SECRET.
 */
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import Stripe from "stripe";
import { recordCardInvoicePayment } from "../../../../src/lib/invoice-payments";
import { createLogger } from "../../../../src/lib/logger";

const logger = createLogger("api.payments.stripe-webhook");

export default defineEventHandler(async (event) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    throw createError({ statusCode: 500, message: "Stripe webhook is not configured." });
  }

  const rawBody = await readRawBody(event);
  const signature = getHeader(event, "stripe-signature");
  if (!rawBody || !signature) {
    throw createError({ statusCode: 400, message: "Missing body or signature" });
  }

  const stripe = new Stripe(secretKey);

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    logger.warn("Stripe webhook signature verification failed", { error: String(err) });
    throw createError({ statusCode: 400, message: "Invalid signature" });
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object as Stripe.Checkout.Session;
    const invoiceId = session.metadata?.invoiceId;
    // Only act on paid sessions with a linked invoice.
    if (invoiceId && session.payment_status === "paid") {
      const amount = (session.amount_total ?? 0) / 100;
      try {
        const result = await recordCardInvoicePayment({
          invoiceId,
          amount,
          paidVia: "stripe",
          externalRef: session.payment_intent ? String(session.payment_intent) : session.id,
          currency: session.currency ?? undefined,
          occurredAt: new Date(stripeEvent.created * 1000),
        });
        logger.info("Recorded Stripe payment", {
          invoiceId,
          status: result.status,
          alreadyRecorded: result.alreadyRecorded,
        });
      } catch (err) {
        // Log and 500 so Stripe retries — do NOT swallow, or the payment silently
        // never reaches the ledger.
        logger.error("Failed to record Stripe payment", { invoiceId, error: String(err) });
        throw createError({ statusCode: 500, message: "Failed to record payment" });
      }
    }
  }

  return { received: true };
});
