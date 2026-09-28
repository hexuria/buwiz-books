/**
 * HMAC-SHA256 signatures for generic webhook routines (Inbox v2 spec §3).
 *
 * The sender signs `${timestamp}.${rawBody}` with the routine's secret and
 * sends:
 *
 *   X-Buwiz-Timestamp: <unix seconds>
 *   X-Buwiz-Signature: <lowercase or uppercase hex of the 32-byte HMAC>
 *   X-Buwiz-Event-Id:  <sender's unique id for this event>
 *
 * The key is the UTF-8 bytes of the whole secret string, exactly as returned
 * by the rotate-secret server function. The timestamp is inside the signed
 * material, so a captured request cannot be replayed with a fresh timestamp,
 * and it must be within the tolerance window, so an old one cannot be replayed
 * at all. Comparison is constant-time.
 *
 * Pure on purpose: no database, no clock except the injectable `now`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;

export type WebhookTimestampCheck =
  | { ok: true; epochSeconds: number }
  | { ok: false; reason: "malformed_timestamp" | "timestamp_outside_tolerance" };

export type WebhookSignatureCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "malformed_timestamp"
        | "timestamp_outside_tolerance"
        | "malformed_signature"
        | "signature_mismatch";
    };

/** The hex HMAC a sender must put in X-Buwiz-Signature. */
export function signRoutineWebhook(
  secret: string,
  timestamp: string,
  rawBody: Uint8Array | string,
): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/**
 * Accept a timestamp only within `toleranceSeconds` of `now`, in either
 * direction: a future-dated timestamp is as suspect as a stale one.
 */
export function checkWebhookTimestamp(
  timestamp: string,
  options: { now: Date; toleranceSeconds: number },
): WebhookTimestampCheck {
  if (!TIMESTAMP_PATTERN.test(timestamp)) return { ok: false, reason: "malformed_timestamp" };
  const epochSeconds = Number(timestamp);
  const nowSeconds = Math.floor(options.now.getTime() / 1000);
  if (Math.abs(nowSeconds - epochSeconds) > options.toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }
  return { ok: true, epochSeconds };
}

export function verifyRoutineWebhookSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: Uint8Array | string;
  now: Date;
  toleranceSeconds: number;
}): WebhookSignatureCheck {
  const freshness = checkWebhookTimestamp(input.timestamp, {
    now: input.now,
    toleranceSeconds: input.toleranceSeconds,
  });
  if (!freshness.ok) return freshness;
  if (!SIGNATURE_PATTERN.test(input.signature)) return { ok: false, reason: "malformed_signature" };

  const expected = Buffer.from(
    signRoutineWebhook(input.secret, input.timestamp, input.rawBody),
    "hex",
  );
  const provided = Buffer.from(input.signature, "hex");
  // Both are 32 bytes by construction (the pattern pins 64 hex chars), which
  // timingSafeEqual requires; the length check keeps that explicit.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}
