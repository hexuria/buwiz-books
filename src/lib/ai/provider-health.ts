// ============================================================================
// Cross-replica provider/key health (AI_NATIVE_ARCHITECTURE §5).
//
// Replaces gemini-client's process-local healthMap, which had two defects:
//   • per-replica state, so a key exhausted on one Cloud Run instance stayed
//     "healthy" on the others (ai_findings #21)
//   • keyed on ARRAY INDEX, so deleting a key silently shifted every cooldown
//     onto the wrong key
//
// Identity here is a fingerprint of the key material (never the key itself),
// which is stable across array reordering and survives the later move to
// per-credential rows.
//
// Health writes ALWAYS use the raw pool, never ctx.db: a cooldown must not
// disappear when the caller's transaction rolls back.
// ============================================================================

import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiProviderHealth } from "../../db/schema/ai";
import { createLogger } from "../logger";

const logger = createLogger("ai.provider-health");

const MAX_FAILURES_BEFORE_COOLDOWN = 3;
const BASE_COOLDOWN_MS = 60_000;
const COOLDOWN_MULTIPLIER = 3;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Stable, non-reversible identity for a credential. Never store the key. */
export function credentialFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export interface HealthSnapshot {
  fingerprint: string;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  invalid: boolean;
}

/** Load health for a set of credentials in one query. */
export async function loadHealth(
  orgId: string,
  fingerprints: string[],
): Promise<Map<string, HealthSnapshot>> {
  if (fingerprints.length === 0) return new Map();
  try {
    const rows = await db
      .select()
      .from(aiProviderHealth)
      .where(
        and(
          eq(aiProviderHealth.organizationId, orgId),
          inArray(aiProviderHealth.credentialFingerprint, fingerprints),
        ),
      );
    return new Map(
      rows.map((r) => [
        r.credentialFingerprint,
        {
          fingerprint: r.credentialFingerprint,
          cooldownUntil: r.cooldownUntil,
          consecutiveFailures: r.consecutiveFailures ?? 0,
          invalid: r.invalid ?? false,
        },
      ]),
    );
  } catch (err) {
    // Health is an optimization: if the table is unavailable, every key is
    // simply considered available rather than failing the user's call.
    logger.warn("Failed to load provider health — treating all keys as available", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

export function isAvailable(snapshot: HealthSnapshot | undefined, now: Date = new Date()): boolean {
  if (!snapshot) return true;
  if (snapshot.invalid) return false;
  if (!snapshot.cooldownUntil) return true;
  return snapshot.cooldownUntil <= now;
}

/**
 * Record a transient failure. The counter increments and the cooldown is
 * computed IN SQL so concurrent replicas cannot lose increments.
 */
export async function recordFailure(
  orgId: string,
  fingerprint: string,
  errorClass: string,
): Promise<void> {
  try {
    await db
      .insert(aiProviderHealth)
      .values({
        organizationId: orgId,
        credentialFingerprint: fingerprint,
        consecutiveFailures: 1,
        lastErrorClass: errorClass,
      })
      .onConflictDoUpdate({
        target: [aiProviderHealth.organizationId, aiProviderHealth.credentialFingerprint],
        set: {
          consecutiveFailures: sql`
            CASE WHEN ${aiProviderHealth.consecutiveFailures} + 1 >= ${MAX_FAILURES_BEFORE_COOLDOWN}
                 THEN 0
                 ELSE ${aiProviderHealth.consecutiveFailures} + 1 END`,
          lockoutLevel: sql`
            CASE WHEN ${aiProviderHealth.consecutiveFailures} + 1 >= ${MAX_FAILURES_BEFORE_COOLDOWN}
                 THEN ${aiProviderHealth.lockoutLevel} + 1
                 ELSE ${aiProviderHealth.lockoutLevel} END`,
          cooldownUntil: sql`
            CASE WHEN ${aiProviderHealth.consecutiveFailures} + 1 >= ${MAX_FAILURES_BEFORE_COOLDOWN}
                 THEN now() + (least(
                        ${BASE_COOLDOWN_MS} * power(${COOLDOWN_MULTIPLIER}, ${aiProviderHealth.lockoutLevel}),
                        ${MAX_COOLDOWN_MS}
                      ) || ' milliseconds')::interval
                 ELSE ${aiProviderHealth.cooldownUntil} END`,
          lastErrorClass: errorClass,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn("Failed to record provider failure", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Take a rejected credential out of rotation for a long window. */
export async function markInvalid(orgId: string, fingerprint: string): Promise<void> {
  try {
    await db
      .insert(aiProviderHealth)
      .values({
        organizationId: orgId,
        credentialFingerprint: fingerprint,
        invalid: true,
        lastErrorClass: "invalid_key",
        cooldownUntil: new Date(Date.now() + MAX_COOLDOWN_MS),
      })
      .onConflictDoUpdate({
        target: [aiProviderHealth.organizationId, aiProviderHealth.credentialFingerprint],
        set: {
          invalid: true,
          lastErrorClass: "invalid_key",
          cooldownUntil: new Date(Date.now() + MAX_COOLDOWN_MS),
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn("Failed to mark credential invalid", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reset health after a success — written only on transition, so the hot
 * path stays read-mostly.
 */
export async function recordSuccess(orgId: string, fingerprint: string): Promise<void> {
  try {
    await db
      .update(aiProviderHealth)
      .set({
        consecutiveFailures: 0,
        lockoutLevel: 0,
        cooldownUntil: null,
        invalid: false,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiProviderHealth.organizationId, orgId),
          eq(aiProviderHealth.credentialFingerprint, fingerprint),
          or(
            sql`${aiProviderHealth.consecutiveFailures} > 0`,
            sql`${aiProviderHealth.cooldownUntil} IS NOT NULL`,
            eq(aiProviderHealth.invalid, true),
          ),
        ),
      );
  } catch (err) {
    logger.warn("Failed to record provider success", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Earliest moment any of these credentials becomes usable again. */
export function earliestAvailableAt(
  snapshots: Map<string, HealthSnapshot>,
  fingerprints: string[],
): Date | null {
  let earliest: Date | null = null;
  for (const fp of fingerprints) {
    const snap = snapshots.get(fp);
    if (!snap?.cooldownUntil) continue;
    if (!earliest || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  return earliest;
}

/** Exposed for tests that need a deterministic clock-free predicate. */
export const HEALTH_CONSTANTS = {
  MAX_FAILURES_BEFORE_COOLDOWN,
  BASE_COOLDOWN_MS,
  COOLDOWN_MULTIPLIER,
  MAX_COOLDOWN_MS,
};
