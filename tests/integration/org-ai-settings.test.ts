// ============================================================================
// Per-org AI credentials + settings — the Phase 4 admin surface.
//
// Three invariants are pinned here, each one a live defect class:
//
//   • ai_findings #25 generalized: NO read path may return key material for
//     ANY provider. Known keys are seeded and every read is searched for the
//     raw substring, not merely eyeballed for a mask.
//   • enforceOcrPolicy is applied ON SAVE, not just on read — a direct call
//     that points statement_ocr at Anthropic must persist a Gemini-only chain,
//     so no later read can resurrect the widened egress.
//   • Revocation is honored by the resolver the router actually consumes
//     (getOrgCredentials), not only by the admin list.
//
// Plus: settings writes leave an audit trail.
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { organizationAiSettings } from "../../src/db/schema/ai";
import { activityLogs } from "../../src/db/schema/activity-logs";
import { updateOrganizationSecrets } from "../../src/lib/org-secrets";
import { getOrgCredentials } from "../../src/lib/ai/credentials";
import { DEFAULT_CHAINS } from "../../src/lib/ai/chains";
import {
  aiConfigEntityId,
  addOrgAiCredential,
  getOrgAiConfig,
  listOrgAiCredentials,
  revokeOrgAiCredential,
  updateOrgAiConfig,
} from "../../src/lib/ai/org-ai-config";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Distinctive, greppable key material — a substring search for these is the
// regression guard.
const GEMINI_LEGACY_KEY = "AIzaSy-LEGACY-GEMINI-SECRET-0001";
const ANTHROPIC_KEY = "sk-ant-TESTONLY-ANTHROPIC-SECRET-0002";
const OPENAI_KEY = "sk-TESTONLY-OPENAI-SECRET-0003";
const COMPATIBLE_KEY = "TESTONLY-COMPATIBLE-SECRET-0004";
const ALL_SECRETS = [GEMINI_LEGACY_KEY, ANTHROPIC_KEY, OPENAI_KEY, COMPATIBLE_KEY];

describeDb("org AI credentials + settings", () => {
  let db: any;
  let sql: postgres.Sql;
  let orgId: string;
  const actorId = "user-admin-ai-settings";

  async function seedOrg(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(organization).values({
      id,
      name: `AI Settings Org ${id.slice(0, 8)}`,
      slug: `ai-settings-${id.slice(0, 8)}`,
    });
    return id;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    orgId = await seedOrg();
    // Legacy Gemini keys still live in organization_secrets.
    await updateOrganizationSecrets(db, orgId, { geminiApiKeys: [GEMINI_LEGACY_KEY] });
  });

  afterAll(async () => {
    await sql.end();
  });

  // ── Credential CRUD ────────────────────────────────────────────────────────

  it("rejects a blank key", async () => {
    await expect(
      addOrgAiCredential(db, { orgId, actorId, provider: "anthropic", apiKey: "   " }),
    ).rejects.toThrow(/apiKey is required/);
  });

  it("rejects an unknown provider", async () => {
    await expect(
      addOrgAiCredential(db, { orgId, actorId, provider: "skynet", apiKey: "x" }),
    ).rejects.toThrow(/Unsupported provider/);
  });

  it("requires a base URL for openai_compatible and forbids it elsewhere", async () => {
    await expect(
      addOrgAiCredential(db, {
        orgId,
        actorId,
        provider: "openai_compatible",
        apiKey: COMPATIBLE_KEY,
      }),
    ).rejects.toThrow(/baseUrl is required/);

    await expect(
      addOrgAiCredential(db, {
        orgId,
        actorId,
        provider: "anthropic",
        apiKey: ANTHROPIC_KEY,
        baseUrl: "https://example.com/v1",
      }),
    ).rejects.toThrow(/only supported for openai_compatible/);

    await expect(
      addOrgAiCredential(db, {
        orgId,
        actorId,
        provider: "openai_compatible",
        apiKey: COMPATIBLE_KEY,
        baseUrl: "ftp://not-http",
      }),
    ).rejects.toThrow(/http or https/);
  });

  it("stores credentials encrypted and returns only a mask", async () => {
    const anthropic = await addOrgAiCredential(db, {
      orgId,
      actorId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      label: "Primary Claude key",
    });
    expect(anthropic.mask).toBe(`••••${ANTHROPIC_KEY.slice(-4)}`);
    expect(anthropic.mask).not.toContain("sk-ant");

    await addOrgAiCredential(db, {
      orgId,
      actorId,
      provider: "openai",
      apiKey: OPENAI_KEY,
    });
    await addOrgAiCredential(db, {
      orgId,
      actorId,
      provider: "openai_compatible",
      apiKey: COMPATIBLE_KEY,
      baseUrl: "https://gateway.example.com/v1/",
    });

    // Ciphertext at rest — never the plaintext.
    const stored = await sql`
      SELECT encrypted_key, base_url FROM organization_ai_credentials
      WHERE organization_id = ${orgId}`;
    expect(stored.length).toBe(3);
    for (const row of stored) {
      expect(row.encrypted_key.startsWith("enc:v1:")).toBe(true);
      for (const secret of ALL_SECRETS) {
        expect(row.encrypted_key).not.toContain(secret);
      }
    }
    // Trailing slash normalized away.
    expect(stored.some((r: any) => r.base_url === "https://gateway.example.com/v1")).toBe(true);
  });

  // ── (a) The ai_findings #25 regression guard, generalized ──────────────────

  it("NO read endpoint returns raw key material for ANY provider", async () => {
    const credentials = await listOrgAiCredentials(db, orgId);
    const config = await getOrgAiConfig(db, orgId);

    const payloads: Record<string, unknown> = {
      listOrgAiCredentials: credentials,
      getOrgAiConfig: config,
    };

    for (const [endpoint, payload] of Object.entries(payloads)) {
      const serialized = JSON.stringify(payload);
      for (const secret of ALL_SECRETS) {
        expect(
          serialized.includes(secret),
          `${endpoint} leaked key material for ${secret.slice(0, 10)}…`,
        ).toBe(false);
      }
      // Nor the ciphertext envelope — the encrypted blob is still key material.
      expect(serialized).not.toContain("enc:v1:");
      expect(serialized).not.toContain("encryptedKey");
    }

    // …and the masks that ARE returned are last-4 only.
    for (const row of credentials) {
      expect(row.mask.startsWith("••••")).toBe(true);
      expect(row.mask.length).toBeLessThanOrEqual(12);
    }
  });

  it("surfaces legacy Gemini keys as read-only pseudo-rows", async () => {
    const credentials = await listOrgAiCredentials(db, orgId);
    const legacy = credentials.filter((c) => c.legacy);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].provider).toBe("gemini");
    expect(legacy[0].id).toBe("legacy:gemini:0");
    expect(legacy[0].mask).toBe(`••••${GEMINI_LEGACY_KEY.slice(-4)}`);
    // A legacy pseudo-row has no real row to revoke.
    await expect(
      revokeOrgAiCredential(db, { orgId, actorId, credentialId: legacy[0].id }),
    ).rejects.toThrow(/Legacy/);
  });

  // ── (b) enforceOcrPolicy is applied ON SAVE ────────────────────────────────

  it("a non-Gemini chain for statement_ocr persists as Gemini-only", async () => {
    const policyOrg = await seedOrg();
    await updateOrgAiConfig(db, {
      orgId: policyOrg,
      actorId,
      taskChains: {
        statement_ocr: [{ provider: "anthropic", model: "claude-sonnet-5" }],
        receipt_ocr: [
          { provider: "gemini", model: "gemini-3.1-flash-image-preview" },
          { provider: "openai", model: "gpt-5" },
        ],
        // Text tasks may legitimately escalate off Gemini.
        transaction_parse: [
          { provider: "gemini", model: "gemini-3-flash-preview" },
          { provider: "anthropic", model: "claude-haiku-4-5" },
        ],
      },
    });

    const [row] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, policyOrg));

    const chains = row.taskChains as Record<string, { provider: string }[]>;

    // Wholly non-Gemini ⇒ falls back to the Gemini default, never empty.
    expect(chains.statement_ocr).toEqual(DEFAULT_CHAINS.statement_ocr);
    expect(chains.statement_ocr.every((h) => h.provider === "gemini")).toBe(true);

    // Mixed ⇒ the non-Gemini hop is stripped at rest.
    expect(chains.receipt_ocr.every((h) => h.provider === "gemini")).toBe(true);
    expect(chains.receipt_ocr).toHaveLength(1);

    // Text task keeps its escalation hop.
    expect(chains.transaction_parse.map((h) => h.provider)).toEqual(["gemini", "anthropic"]);

    // The UI's effective view agrees.
    const config = await getOrgAiConfig(db, policyOrg);
    const ocr = config.effectiveChains.find((c) => c.task === "statement_ocr")!;
    expect(ocr.documentTask).toBe(true);
    expect(ocr.hops.every((h) => h.provider === "gemini")).toBe(true);
  });

  // ── (c) Revocation ─────────────────────────────────────────────────────────

  it("revocation removes the credential from the router's resolver", async () => {
    const revokeOrg = await seedOrg();
    const created = await addOrgAiCredential(db, {
      orgId: revokeOrg,
      actorId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });

    const before = await getOrgCredentials(revokeOrg, "anthropic");
    expect(before.map((c) => c.credentialId)).toContain(created.id);

    await revokeOrgAiCredential(db, { orgId: revokeOrg, actorId, credentialId: created.id });

    const after = await getOrgCredentials(revokeOrg, "anthropic");
    expect(after).toHaveLength(0);

    // The admin list keeps the row, flagged — revocation is a soft delete.
    const listed = await listOrgAiCredentials(db, revokeOrg);
    const row = listed.find((c) => c.id === created.id)!;
    expect(row.revokedAt).toBeInstanceOf(Date);

    // Revoking twice is not silently successful.
    await expect(
      revokeOrgAiCredential(db, { orgId: revokeOrg, actorId, credentialId: created.id }),
    ).rejects.toThrow(/not found/);

    // Cross-org revocation is impossible.
    const other = await addOrgAiCredential(db, {
      orgId: revokeOrg,
      actorId,
      provider: "openai",
      apiKey: OPENAI_KEY,
    });
    await expect(
      revokeOrgAiCredential(db, { orgId, actorId, credentialId: other.id }),
    ).rejects.toThrow(/not found/);
  });

  // ── (d) Audit trail ────────────────────────────────────────────────────────

  it("a settings write emits an activity_logs row with a field-level diff", async () => {
    const auditOrg = await seedOrg();
    await updateOrgAiConfig(db, {
      orgId: auditOrg,
      actorId,
      killSwitch: true,
      monthlySpendCapUsd: 25,
    });

    const rows = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.organizationId, auditOrg),
          eq(activityLogs.action, "ai_settings_updated"),
        ),
      );

    expect(rows).toHaveLength(1);
    // activity_logs.entity_id is `uuid NOT NULL` but org ids are text, so the
    // row keys on a deterministic UUIDv5 surrogate derived from the org id.
    expect(rows[0].entityId).toBe(aiConfigEntityId(auditOrg));
    expect(rows[0].entityType).toBe("ai_settings");
    expect(rows[0].actorId).toBe(actorId);
    expect(rows[0].changes).toEqual({
      killSwitch: { old: false, new: true },
      monthlySpendCapUsd: { old: null, new: 25 },
    });
  });

  it("credential mutations are audited too, with masks instead of keys", async () => {
    const auditOrg = await seedOrg();
    const created = await addOrgAiCredential(db, {
      orgId: auditOrg,
      actorId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      label: "Ops key",
    });
    await revokeOrgAiCredential(db, { orgId: auditOrg, actorId, credentialId: created.id });

    const rows = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.organizationId, auditOrg));

    expect(rows.map((r: any) => r.action).sort()).toEqual([
      "ai_credential_added",
      "ai_credential_revoked",
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(OPENAI_KEY);
    expect(serialized).toContain(`••••${OPENAI_KEY.slice(-4)}`);
  });

  // ── Settings normalization ─────────────────────────────────────────────────

  it("a provider allowlist always keeps Gemini, and an empty list resets to default", async () => {
    const listOrg = await seedOrg();

    await updateOrgAiConfig(db, {
      orgId: listOrg,
      actorId,
      providerAllowlist: ["anthropic", "bogus_provider"],
    });
    let config = await getOrgAiConfig(db, listOrg);
    // Gemini is force-included: document tasks are Gemini-only, so an
    // allowlist without it would silently disable every OCR path.
    expect(config.providerAllowlist).toEqual(["gemini", "anthropic"]);

    // Anthropic escalation now shows as permitted in the effective chain.
    const parse = config.effectiveChains.find((c) => c.task === "transaction_parse")!;
    expect(parse.hops.find((h) => h.provider === "anthropic")?.allowed).toBe(true);

    await updateOrgAiConfig(db, { orgId: listOrg, actorId, providerAllowlist: [] });
    config = await getOrgAiConfig(db, listOrg);
    expect(config.providerAllowlist).toBeNull();
    const parseAfter = config.effectiveChains.find((c) => c.task === "transaction_parse")!;
    expect(parseAfter.hops.find((h) => h.provider === "anthropic")?.allowed).toBe(false);
    expect(parseAfter.hops.find((h) => h.provider === "gemini")?.allowed).toBe(true);
  });

  it("defaults to the built-in chains when the org has no settings row", async () => {
    const freshOrg = await seedOrg();
    const config = await getOrgAiConfig(db, freshOrg);
    expect(config.killSwitch).toBe(false);
    expect(config.providerAllowlist).toBeNull();
    expect(config.taskChains).toBeNull();
    expect(config.effectiveChains.length).toBe(Object.keys(DEFAULT_CHAINS).length);
    const statement = config.effectiveChains.find((c) => c.task === "statement_ocr")!;
    expect(statement.source).toBe("default");
    expect(statement.hops.map((h) => h.model)).toEqual(
      DEFAULT_CHAINS.statement_ocr.map((h) => h.model),
    );
  });

  it("rejects an out-of-range spend cap and an empty patch", async () => {
    const capOrg = await seedOrg();
    await expect(
      updateOrgAiConfig(db, { orgId: capOrg, actorId, monthlySpendCapUsd: -5 }),
    ).rejects.toThrow(/positive number/);
    await expect(updateOrgAiConfig(db, { orgId: capOrg, actorId })).rejects.toThrow(
      /No AI settings fields/,
    );
  });
});
