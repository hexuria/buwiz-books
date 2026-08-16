/** Verified Stripe subscription events for Enterprise Business Groups. */
import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import Stripe from "stripe";
import { processEnterpriseStripeEvent } from "../../../../src/lib/enterprise/stripe-entitlements";
import { createLogger } from "../../../../src/lib/logger";

const logger = createLogger("api.enterprise.stripe-webhook");

export default defineEventHandler(async (requestEvent) => {
  const secretKey = process.env.STRIPE_ENTERPRISE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_ENTERPRISE_WEBHOOK_SECRET;
  const priceId = process.env.STRIPE_ENTERPRISE_PRICE_ID;
  if (!secretKey || !webhookSecret || !priceId || !process.env.DATABASE_URL_ADMIN) {
    throw createError({ statusCode: 500, message: "Enterprise billing is not configured." });
  }

  const rawBody = await readRawBody(requestEvent);
  const signature = getHeader(requestEvent, "stripe-signature");
  if (!rawBody || !signature) {
    throw createError({ statusCode: 400, message: "Missing body or signature." });
  }

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (error) {
    logger.warn("Enterprise Stripe signature verification failed", { error: String(error) });
    throw createError({ statusCode: 400, message: "Invalid signature." });
  }

  try {
    const result = await processEnterpriseStripeEvent(stripe, event, priceId);
    if (result.status === "ignored" && result.failureCode) {
      logger.warn("Enterprise Stripe event quarantined", {
        eventId: event.id,
        eventType: event.type,
        failureCode: result.failureCode,
      });
    }
    return {
      received: true,
      status: result.status,
      duplicate: result.duplicate,
      failureCode: result.failureCode,
    };
  } catch (error) {
    logger.error("Enterprise Stripe processing failed", {
      eventId: event.id,
      eventType: event.type,
      error: String(error),
    });
    throw createError({ statusCode: 500, message: "Enterprise entitlement update failed." });
  }
});
