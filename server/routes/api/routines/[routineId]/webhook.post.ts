/**
 * Nitro route: POST /api/routines/:routineId/webhook
 *
 * The generic webhook routine (Inbox v2 spec §3). A sender signs
 * `${timestamp}.${rawBody}` with the routine's secret (HMAC-SHA256, hex) and
 * sends X-Buwiz-Timestamp, X-Buwiz-Signature and X-Buwiz-Event-Id.
 *
 * Order matters, and every rejection happens before any row is written:
 *   1. malformed routine id, missing headers, stale/future timestamp
 *   2. body over the 1 MB cap (declared length first, then counted bytes)
 *   3. narrow no-session lookup of the routine's organization — the same
 *      pattern the Resend webhook uses to resolve its tenant
 *   4. inside withOrgContext(routine.organization_id): decrypt the routine's
 *      secret and verify the signature in constant time
 * Only then is the payload recorded as an ingestion event, deduplicated per
 * (organization, routine, event id), and handed to the `routine_webhook` job.
 */
import { createHash } from "node:crypto";
import { createError, defineEventHandler, getHeader, getRouterParam, type H3Event } from "h3";
import { and, eq, sql } from "drizzle-orm";
import { db, withOrgContext } from "../../../../../src/db";
import {
  ingestionEvents,
  integrationSources,
  processingJobs,
  workflowEvents,
} from "../../../../../src/db/schema/inbox";
import { routines } from "../../../../../src/db/schema/routines";
import { triggerWorker } from "../../../../../src/lib/jobs/trigger";
import { createLogger } from "../../../../../src/lib/logger";
import {
  ROUTINE_WEBHOOK_JOB_TYPE,
  ROUTINE_WEBHOOK_SOURCE_PROVIDER,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_TOLERANCE_SECONDS,
  parseHmacWebhookConfig,
  routineWebhookEventProvider,
} from "../../../../../src/lib/routines/config";
import { loadRoutineWebhookSecret } from "../../../../../src/lib/routines/secrets";
import {
  checkWebhookTimestamp,
  verifyRoutineWebhookSignature,
} from "../../../../../src/lib/routines/webhook-signature";

const logger = createLogger("api.routines.webhook");

const ROUTINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_MAX_LENGTH = 255;

function notFound() {
  return createError({ statusCode: 404, message: "Webhook routine not found." });
}

function unauthorized(message: string) {
  return createError({ statusCode: 401, message });
}

function tooLarge(limit: number) {
  return createError({
    statusCode: 413,
    message: `Webhook body exceeds the ${limit}-byte limit.`,
  });
}

/**
 * Read the raw body without ever buffering more than `maxBytes`: a declared
 * Content-Length over the cap is refused before reading, and an undeclared or
 * lying one is cut off as soon as the running total passes it.
 */
async function readBodyWithinLimit(event: H3Event, maxBytes: number): Promise<Buffer> {
  const declared = event.req.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      throw createError({ statusCode: 400, message: "Invalid Content-Length." });
    }
    if (length > maxBytes) throw tooLarge(maxBytes);
  }
  const stream = event.req.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function parsePayload(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw createError({ statusCode: 400, message: "Webhook body must be JSON." });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw createError({ statusCode: 400, message: "Webhook body must be a JSON object." });
  }
  return parsed as Record<string, unknown>;
}

export default defineEventHandler(async (event) => {
  const routineId = getRouterParam(event, "routineId");
  if (!routineId || !ROUTINE_ID_PATTERN.test(routineId)) throw notFound();

  const timestamp = getHeader(event, "x-buwiz-timestamp")?.trim();
  const signature = getHeader(event, "x-buwiz-signature")?.trim();
  const eventId = getHeader(event, "x-buwiz-event-id")?.trim();
  if (!timestamp || !signature || !eventId) {
    throw createError({
      statusCode: 400,
      message: "X-Buwiz-Timestamp, X-Buwiz-Signature and X-Buwiz-Event-Id are required.",
    });
  }
  if (eventId.length > EVENT_ID_MAX_LENGTH) {
    throw createError({
      statusCode: 400,
      message: `X-Buwiz-Event-Id must be at most ${EVENT_ID_MAX_LENGTH} characters.`,
    });
  }

  // Cheap rejection first: a stale or future-dated request needs no secret.
  const receivedAt = new Date();
  const freshness = checkWebhookTimestamp(timestamp, {
    now: receivedAt,
    toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
  });
  if (!freshness.ok) {
    logger.warn("Routine webhook rejected before verification", {
      routineId,
      reason: freshness.reason,
    });
    throw unauthorized("Webhook timestamp is missing, malformed, or outside the tolerance window.");
  }

  const rawBody = await readBodyWithinLimit(event, WEBHOOK_MAX_BODY_BYTES);

  // Narrow no-session lookup: which organization owns this routine? Nothing
  // else is read before the org context exists, exactly like the Resend
  // webhook's recipient lookup.
  const [owner] = await db
    .select({ organizationId: routines.organizationId })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.triggerKind, "webhook")))
    .limit(1);
  if (!owner) throw notFound();

  const outcome = await withOrgContext(owner.organizationId, "system", "admin", async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(and(eq(routines.organizationId, owner.organizationId), eq(routines.id, routineId)))
      .limit(1);
    const config = routine ? parseHmacWebhookConfig(routine.triggerConfig) : null;
    if (!routine || routine.triggerKind !== "webhook" || !config) throw notFound();

    // A routine's own limits may only tighten the hard ceilings.
    const maxBytes = Math.min(config.max_bytes, WEBHOOK_MAX_BODY_BYTES);
    if (rawBody.byteLength > maxBytes) throw tooLarge(maxBytes);
    const secret = await loadRoutineWebhookSecret(tx, {
      orgId: owner.organizationId,
      routineId: routine.id,
      secretRef: config.secret_ref,
    });
    const verification = secret
      ? verifyRoutineWebhookSignature({
          secret,
          timestamp,
          signature,
          rawBody,
          now: receivedAt,
          toleranceSeconds: Math.min(config.tolerance_s, WEBHOOK_TOLERANCE_SECONDS),
        })
      : ({ ok: false, reason: "no_signing_secret" } as const);
    if (!verification.ok) {
      logger.warn("Routine webhook signature verification failed", {
        organizationId: owner.organizationId,
        routineId,
        reason: verification.reason,
      });
      throw unauthorized("Invalid webhook signature.");
    }

    // ---- Verified. Nothing above wrote a row. ----
    const payload = parsePayload(rawBody);
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const provider = routineWebhookEventProvider(routine.id);

    const [source] = await tx
      .insert(integrationSources)
      .values({
        organizationId: owner.organizationId,
        provider: ROUTINE_WEBHOOK_SOURCE_PROVIDER,
        channel: "webhook",
        externalSourceId: routine.id,
        name: routine.name,
      })
      .onConflictDoUpdate({
        target: [
          integrationSources.organizationId,
          integrationSources.provider,
          integrationSources.externalSourceId,
        ],
        targetWhere: sql`${integrationSources.externalSourceId} is not null`,
        set: { name: routine.name, updatedAt: new Date() },
      })
      .returning();

    const [ingestionEvent] = await tx
      .insert(ingestionEvents)
      .values({
        organizationId: owner.organizationId,
        routineId: routine.id,
        sourceId: source.id,
        channel: "webhook",
        provider,
        providerEventId: eventId,
        externalObjectId: eventId,
        externalVersion: "1",
        payloadHash,
        payload,
        headers: { "x-buwiz-event-id": eventId, "x-buwiz-timestamp": timestamp },
        status: routine.enabled ? "received" : "skipped",
        occurredAt: new Date(freshness.epochSeconds * 1000),
        processedAt: routine.enabled ? null : receivedAt,
      })
      .onConflictDoNothing()
      .returning();

    if (!ingestionEvent) {
      // Duplicate delivery. The unique index suppressed the insert; say so in
      // the audit trail instead of letting the retry vanish. One row per
      // distinct delivery attempt (senders re-sign retries with a fresh
      // timestamp); a byte-identical replay collapses into the same row.
      const [existing] = await tx
        .select({ id: ingestionEvents.id, payloadHash: ingestionEvents.payloadHash })
        .from(ingestionEvents)
        .where(
          and(
            eq(ingestionEvents.organizationId, owner.organizationId),
            eq(ingestionEvents.provider, provider),
            eq(ingestionEvents.providerEventId, eventId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Duplicate routine webhook event could not be resolved.");
      await tx
        .insert(workflowEvents)
        .values({
          organizationId: owner.organizationId,
          entityType: "ingestion_event",
          entityId: existing.id,
          action: "exact_replay_suppressed",
          actorType: "system",
          idempotencyKey: `exact-replay:routine-webhook:${existing.id}:${timestamp}`,
          data: {
            replayType: "provider_identity",
            routineId: routine.id,
            eventId,
            // A replayed id carrying a DIFFERENT body is worth a human's look.
            samePayload: existing.payloadHash === payloadHash,
          },
        })
        .onConflictDoNothing();
      return { received: true, duplicate: true, ingestionEventId: existing.id, queued: false };
    }

    if (!routine.enabled) {
      await tx
        .insert(workflowEvents)
        .values({
          organizationId: owner.organizationId,
          entityType: "ingestion_event",
          entityId: ingestionEvent.id,
          action: "routine_disabled_skipped",
          actorType: "system",
          idempotencyKey: `routine-disabled:ingestion:${ingestionEvent.id}`,
          data: {
            routineId: routine.id,
            eventId,
            reason: "The routine is disabled; the payload was recorded, not processed.",
          },
        })
        .onConflictDoNothing();
      return {
        received: true,
        processed: false,
        reason: "routine_disabled",
        ingestionEventId: ingestionEvent.id,
        queued: false,
      };
    }

    await tx.insert(processingJobs).values({
      organizationId: owner.organizationId,
      routineId: routine.id,
      ingestionEventId: ingestionEvent.id,
      jobType: ROUTINE_WEBHOOK_JOB_TYPE,
      dedupeKey: `routine-webhook:${ingestionEvent.id}`,
      payload: { routineId: routine.id, ingestionEventId: ingestionEvent.id },
    });
    logger.info("Routine webhook payload queued", {
      organizationId: owner.organizationId,
      routineId: routine.id,
      ingestionEventId: ingestionEvent.id,
    });
    return { received: true, ingestionEventId: ingestionEvent.id, queued: true };
  });

  // Kick the worker only after the enqueue transaction committed.
  if (outcome.queued) triggerWorker([ROUTINE_WEBHOOK_JOB_TYPE]);
  return outcome;
});
