// ============================================================================
// Cross-replica credential health.
//
// Pins the two defects this replaces: per-process state (a cooldown set by
// one replica must be visible to the next) and array-index identity (key
// identity must survive reordering).
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import postgres from "postgres";
import {
  credentialFingerprint,
  loadHealth,
  isAvailable,
  recordFailure,
  recordSuccess,
  markInvalid,
  earliestAvailableAt,
  HEALTH_CONSTANTS,
} from "../../src/lib/ai/provider-health";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("ai provider health", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  it("fingerprints are stable and never contain the key", () => {
    const key = "AIzaSyExampleKeyMaterial12345";
    const fp = credentialFingerprint(key);
    expect(fp).toBe(credentialFingerprint(key));
    expect(fp).not.toContain("AIza");
    expect(fp).toHaveLength(32);
    expect(credentialFingerprint("other")).not.toBe(fp);
  });

  it("treats unknown credentials as available", async () => {
    const orgId = crypto.randomUUID();
    const health = await loadHealth(orgId, [credentialFingerprint("never-seen")]);
    expect(isAvailable(health.get(credentialFingerprint("never-seen")))).toBe(true);
  });

  it("enters cooldown only after the failure threshold, and persists it", async () => {
    const orgId = crypto.randomUUID();
    const fp = credentialFingerprint(`key-${orgId}`);

    for (let i = 0; i < HEALTH_CONSTANTS.MAX_FAILURES_BEFORE_COOLDOWN - 1; i++) {
      await recordFailure(orgId, fp, "rate_limited");
      const health = await loadHealth(orgId, [fp]);
      expect(isAvailable(health.get(fp))).toBe(true);
    }

    await recordFailure(orgId, fp, "rate_limited");
    // A FRESH read — this is what a different replica would see.
    const health = await loadHealth(orgId, [fp]);
    const snapshot = health.get(fp);
    expect(snapshot?.cooldownUntil).toBeInstanceOf(Date);
    expect(isAvailable(snapshot)).toBe(false);
  });

  it("key identity survives reordering (the array-index bug)", async () => {
    const orgId = crypto.randomUUID();
    const keyA = `A-${orgId}`;
    const keyB = `B-${orgId}`;
    const fpA = credentialFingerprint(keyA);
    const fpB = credentialFingerprint(keyB);

    // Exhaust key A.
    for (let i = 0; i < HEALTH_CONSTANTS.MAX_FAILURES_BEFORE_COOLDOWN; i++) {
      await recordFailure(orgId, fpA, "rate_limited");
    }

    // Simulate the org deleting the first key: B is now index 0. Its health
    // must be untouched — under index identity it would inherit A's cooldown.
    const health = await loadHealth(orgId, [fpB, fpA]);
    expect(isAvailable(health.get(fpB))).toBe(true);
    expect(isAvailable(health.get(fpA))).toBe(false);
  });

  it("marks a rejected credential invalid and keeps it out of rotation", async () => {
    const orgId = crypto.randomUUID();
    const fp = credentialFingerprint(`bad-${orgId}`);
    await markInvalid(orgId, fp);
    const health = await loadHealth(orgId, [fp]);
    expect(health.get(fp)?.invalid).toBe(true);
    expect(isAvailable(health.get(fp))).toBe(false);
  });

  it("a success clears failures, cooldown, and the invalid flag", async () => {
    const orgId = crypto.randomUUID();
    const fp = credentialFingerprint(`recover-${orgId}`);
    for (let i = 0; i < HEALTH_CONSTANTS.MAX_FAILURES_BEFORE_COOLDOWN; i++) {
      await recordFailure(orgId, fp, "rate_limited");
    }
    expect(isAvailable((await loadHealth(orgId, [fp])).get(fp))).toBe(false);

    await recordSuccess(orgId, fp);
    const health = await loadHealth(orgId, [fp]);
    expect(health.get(fp)?.cooldownUntil).toBeNull();
    expect(health.get(fp)?.consecutiveFailures).toBe(0);
    expect(isAvailable(health.get(fp))).toBe(true);
  });

  it("reports the earliest availability across credentials", async () => {
    const orgId = crypto.randomUUID();
    const fp1 = credentialFingerprint(`e1-${orgId}`);
    const fp2 = credentialFingerprint(`e2-${orgId}`);
    for (let i = 0; i < HEALTH_CONSTANTS.MAX_FAILURES_BEFORE_COOLDOWN; i++) {
      await recordFailure(orgId, fp1, "rate_limited");
    }
    const health = await loadHealth(orgId, [fp1, fp2]);
    const earliest = earliestAvailableAt(health, [fp1, fp2]);
    expect(earliest).toBeInstanceOf(Date);
    expect(earliest!.getTime()).toBeGreaterThan(Date.now());
  });

  it("health is org-scoped — one tenant's cooldown never affects another", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    // Same key material shared across orgs (BYOK reuse is possible).
    const shared = "shared-key-material";
    const fp = credentialFingerprint(shared);

    for (let i = 0; i < HEALTH_CONSTANTS.MAX_FAILURES_BEFORE_COOLDOWN; i++) {
      await recordFailure(orgA, fp, "rate_limited");
    }

    expect(isAvailable((await loadHealth(orgA, [fp])).get(fp))).toBe(false);
    expect(isAvailable((await loadHealth(orgB, [fp])).get(fp))).toBe(true);
  });
});
