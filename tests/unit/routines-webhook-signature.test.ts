/**
 * HMAC verification for generic webhook routines (Inbox v2 §3).
 *
 * Pure: signs `${timestamp}.${eventId}.${rawBody}` and checks it in constant time within
 * a 300-second window. The route test pins the HTTP behavior; this file pins
 * the edges — tampering, wrong key, both clock directions, the exact boundary,
 * and malformed input that must never reach the comparison.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkWebhookTimestamp,
  signRoutineWebhook,
  verifyRoutineWebhookSignature,
} from "@/lib/routines/webhook-signature";

const SECRET = "bwz_whsec_test-secret-value";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const BODY = JSON.stringify({ invoice: "INV-1", amount: "12.50" });
const EVENT = "evt_0001";

function verify(overrides: Partial<Parameters<typeof verifyRoutineWebhookSignature>[0]> = {}) {
  const timestamp = overrides.timestamp ?? String(NOW_SECONDS);
  const rawBody = overrides.rawBody ?? BODY;
  const eventId = overrides.eventId ?? EVENT;
  return verifyRoutineWebhookSignature({
    secret: SECRET,
    timestamp,
    eventId,
    signature: overrides.signature ?? signRoutineWebhook(SECRET, timestamp, eventId, rawBody),
    rawBody,
    now: NOW,
    toleranceSeconds: 300,
    ...overrides,
  });
}

describe("routine webhook signatures", () => {
  it("signs timestamp.eventId.body with HMAC-SHA256 as lowercase hex", () => {
    const expected = createHmac("sha256", SECRET)
      .update(`${NOW_SECONDS}.${EVENT}.${BODY}`)
      .digest("hex");
    expect(signRoutineWebhook(SECRET, String(NOW_SECONDS), EVENT, BODY)).toBe(expected);
    expect(signRoutineWebhook(SECRET, String(NOW_SECONDS), EVENT, Buffer.from(BODY))).toBe(
      expected,
    );
  });

  it("binds the event id: a valid signature cannot be replayed under a new event id", () => {
    const signature = signRoutineWebhook(SECRET, String(NOW_SECONDS), EVENT, BODY);
    expect(verify({ signature, eventId: "evt_0002" })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("accepts a valid signature, in either hex case", () => {
    expect(verify()).toEqual({ ok: true });
    const upper = signRoutineWebhook(SECRET, String(NOW_SECONDS), EVENT, BODY).toUpperCase();
    expect(verify({ signature: upper })).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const signature = signRoutineWebhook(SECRET, String(NOW_SECONDS), EVENT, BODY);
    expect(verify({ signature, rawBody: BODY.replace("12.50", "1250.00") })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a signature made with another secret", () => {
    const signature = signRoutineWebhook("another-secret", String(NOW_SECONDS), EVENT, BODY);
    expect(verify({ signature })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("binds the timestamp: a valid signature cannot be moved to a fresh timestamp", () => {
    const old = String(NOW_SECONDS - 10);
    const signature = signRoutineWebhook(SECRET, old, EVENT, BODY);
    expect(verify({ timestamp: String(NOW_SECONDS), signature })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects stale and future timestamps beyond 300 seconds, accepting the boundary", () => {
    for (const offset of [-300, 300]) {
      expect(verify({ timestamp: String(NOW_SECONDS + offset) })).toEqual({ ok: true });
    }
    for (const offset of [-301, 301, -86_400]) {
      expect(verify({ timestamp: String(NOW_SECONDS + offset) })).toEqual({
        ok: false,
        reason: "timestamp_outside_tolerance",
      });
    }
  });

  it("rejects malformed timestamps before any HMAC work", () => {
    for (const timestamp of ["", "abc", "1.5", "-5", `${NOW_SECONDS}ms`, "1".repeat(13)]) {
      expect(checkWebhookTimestamp(timestamp, { now: NOW, toleranceSeconds: 300 })).toEqual({
        ok: false,
        reason: "malformed_timestamp",
      });
    }
  });

  it("rejects malformed signatures without comparing", () => {
    const good = signRoutineWebhook(SECRET, String(NOW_SECONDS), EVENT, BODY);
    for (const signature of [
      "",
      good.slice(0, 63),
      `${good}00`,
      `sha256=${good}`,
      "z".repeat(64),
    ]) {
      expect(verify({ signature })).toEqual({ ok: false, reason: "malformed_signature" });
    }
  });

  it("reports the parsed timestamp when it is fresh", () => {
    expect(checkWebhookTimestamp(String(NOW_SECONDS), { now: NOW, toleranceSeconds: 300 })).toEqual(
      { ok: true, epochSeconds: NOW_SECONDS },
    );
  });
});
