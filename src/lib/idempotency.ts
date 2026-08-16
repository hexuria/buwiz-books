import { createHash } from "node:crypto";

function canonicalizePayload(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Idempotency payloads cannot contain non-finite numbers.");
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : canonicalizePayload(entry)));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizePayload(entry)]),
    );
  }
  throw new Error(`Unsupported idempotency payload value: ${typeof value}.`);
}

/**
 * Bind an idempotency key to the exact logical request it represents.
 *
 * Object keys are sorted and undefined object fields are omitted so transport
 * serialization details do not change the digest. Array order remains
 * significant because posting-line order and repeated CSV rows are meaningful.
 */
export function idempotencyPayloadHash(scope: string, payload: unknown): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(JSON.stringify(canonicalizePayload(payload)))
    .digest("hex");
}

export function assertIdempotencyPayloadMatches(
  existingPayloadHash: unknown,
  incomingPayloadHash: string,
  artifact: string,
): void {
  // Rows created before payload-bound idempotency do not have a digest. Preserve
  // their historical replay behavior instead of guessing from incomplete data.
  if (typeof existingPayloadHash !== "string" || existingPayloadHash.length === 0) return;
  if (existingPayloadHash !== incomingPayloadHash) {
    throw new Error(
      `This idempotency key was already used for a different ${artifact} submission.`,
    );
  }
}

/**
 * Derive a stable RFC 4122 UUID from an organization-scoped request key.
 *
 * This lets tables without a dedicated idempotency column use their primary-key conflict as
 * the concurrency boundary. The caller's key is still kept separate from provider object IDs.
 */
export function scopedIdempotencyUuid(scope: string, idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(idempotencyKey)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
