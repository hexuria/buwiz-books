// ============================================================================
// Jev opt-in, against a real database.
//
// The opt-in is "jev" on organization_ai_settings.provider_allowlist: the
// same admin-only write (updateOrgAiConfig, behind updateOrgAiSettings) the
// settings UI already uses, audited like any other allowlist change. Pinned:
//
//   • default OFF: an org with no settings row never reaches Jev
//   • opting in persists, leaves an audit row, is what the router's cached
//     read path sees, and makes Jev the first hop (settings view, resolver,
//     and the production runtime's prepare())
//   • no OCR task ever gains Jev, and a saved override cannot smuggle it in
//   • a Jev key is usable only with the operator endpoint (JEV_BASE_URL),
//     which tenant data can never replace
//   • opting out removes Jev again
//   • Jev spend reaches the monthly cap (placeholder price, never null)
// ============================================================================
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { aiInvocations, organizationAiSettings } from "../../src/db/schema/ai";
import { activityLogs } from "../../src/db/schema/activity-logs";
import { encryptSecret } from "../../src/lib/crypto";
import { updateOrganizationSecrets } from "../../src/lib/org-secrets";
import { DEFAULT_CHAINS, DOCUMENT_TASKS, JEV_MODEL, JEV_TASKS } from "../../src/lib/ai/chains";
import { getOrgCredentials } from "../../src/lib/ai/credentials";
import { productionAiCompletionRuntime } from "../../src/lib/ai/facade-runtime";
import { logProviderInvocation } from "../../src/lib/ai/invoke";
import {
  addOrgAiCredential,
  getOrgAiConfig,
  updateOrgAiConfig,
} from "../../src/lib/ai/org-ai-config";
import { resolveChain } from "../../src/lib/ai/router";
import {
  getOrgAiSettings,
  invalidateOrgAiSettings,
  isProviderAllowed,
} from "../../src/lib/ai/settings";
import { AiSpendCapError, invalidateSpendCache, monthToDateSpendUsd } from "../../src/lib/ai/spend";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const JEV_KEY = "jev-TESTONLY-SECRET-0005";
const GEMINI_KEY = "AIzaSy-TESTONLY-GEMINI-0006";
const JEV_ENDPOINT = "https://jev.example.test/v1";
const JEV_HOP = { provider: "jev", model: JEV_MODEL };

describeDb("Jev opt-in (organization_ai_settings.provider_allowlist)", () => {
  let db: any;
  let sql: postgres.Sql;
  const actorId = "user-admin-jev";

  async function seedOrg(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(organization).values({
      id,
      name: `Jev Org ${id.slice(0, 8)}`,
      slug: `jev-${id.slice(0, 8)}`,
    });
    return id;
  }

  /** An org that opted in and holds both a Gemini and a Jev key. */
  async function seedOptedInOrg(): Promise<string> {
    const orgId = await seedOrg();
    await updateOrganizationSecrets(db, orgId, { geminiApiKeys: [GEMINI_KEY] });
    await addOrgAiCredential(db, { orgId, actorId, provider: "jev", apiKey: JEV_KEY });
    await updateOrgAiConfig(db, { orgId, actorId, providerAllowlist: ["jev"] });
    return orgId;
  }

  async function routerSettings(orgId: string) {
    invalidateOrgAiSettings(orgId);
    return getOrgAiSettings(db, orgId);
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await sql.end();
  });

  it("is off by default: no settings row means no Jev on any chain", async () => {
    const orgId = await seedOrg();

    const settings = await routerSettings(orgId);
    expect(settings.providerAllowlist).toBeNull();
    expect(isProviderAllowed(settings, "jev")).toBe(false);

    const config = await getOrgAiConfig(db, orgId);
    for (const chain of config.effectiveChains) {
      expect(
        chain.hops.some((hop) => hop.provider === "jev"),
        chain.task,
      ).toBe(false);
    }
    for (const task of JEV_TASKS) {
      const view = config.effectiveChains.find((chain) => chain.task === task)!;
      expect(view.hops.map(({ provider, model }) => ({ provider, model }))).toEqual(
        DEFAULT_CHAINS[task],
      );
    }
  });

  it("opting in persists 'jev' on the allowlist, audits it, and puts Jev first", async () => {
    const orgId = await seedOrg();

    await updateOrgAiConfig(db, { orgId, actorId, providerAllowlist: ["jev"] });

    // At rest: Gemini is force-kept (OCR needs it), Jev added.
    const [row] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, orgId));
    expect(row.providerAllowlist).toEqual(["gemini", "jev"]);
    expect(row.updatedBy).toBe(actorId);

    // Audited with a field-level diff.
    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.organizationId, orgId), eq(activityLogs.action, "ai_settings_updated")),
      );
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe(actorId);
    expect(logs[0].changes).toEqual({
      providerAllowlist: { old: null, new: ["gemini", "jev"] },
    });

    // The router's cached read path sees the opt-in.
    expect(isProviderAllowed(await routerSettings(orgId), "jev")).toBe(true);

    // The settings view shows what will run: Jev first, Gemini behind it.
    const config = await getOrgAiConfig(db, orgId);
    for (const task of JEV_TASKS) {
      const view = config.effectiveChains.find((chain) => chain.task === task)!;
      expect(view.hops).toEqual([
        { ...JEV_HOP, allowed: true },
        ...DEFAULT_CHAINS[task].map((hop) => ({ ...hop, allowed: true })),
      ]);
    }
    for (const view of config.effectiveChains.filter((chain) => !JEV_TASKS.has(chain.task))) {
      expect(
        view.hops.some((hop) => hop.provider === "jev"),
        view.task,
      ).toBe(false);
    }
  });

  it("the router puts Jev first only with an org Jev key AND the operator endpoint", async () => {
    const orgId = await seedOptedInOrg();
    const settings = await routerSettings(orgId);

    // No endpoint configured: the key is unusable, Gemini serves.
    vi.stubEnv("JEV_BASE_URL", "");
    let resolved = await resolveChain({ task: "ingest_triage", orgId, settings });
    expect(resolved.hops).toEqual(DEFAULT_CHAINS.ingest_triage);
    expect(resolved.filtered).toEqual([{ ...JEV_HOP, reason: "no_credentials" }]);

    // Plain http off loopback is refused: Jev would receive document text.
    vi.stubEnv("JEV_BASE_URL", "http://jev.example.test/v1");
    expect(await getOrgCredentials(db, orgId, "jev")).toEqual([]);

    // Endpoint configured: Jev leads, with the normalized operator URL.
    vi.stubEnv("JEV_BASE_URL", `${JEV_ENDPOINT}/`);
    resolved = await resolveChain({ task: "ingest_triage", orgId, settings });
    expect(resolved.hops).toEqual([JEV_HOP, ...DEFAULT_CHAINS.ingest_triage]);
    const [credential] = await getOrgCredentials(db, orgId, "jev");
    expect(credential.apiKey).toBe(JEV_KEY);
    expect(credential.baseUrl).toBe(JEV_ENDPOINT);

    // The production runtime agrees, end to end through its own DB reads.
    const prepared = await productionAiCompletionRuntime.prepare({
      task: "classify_document",
      orgId,
    });
    expect(prepared).toEqual({
      kind: "ready",
      hops: [JEV_HOP, ...DEFAULT_CHAINS.classify_document],
    });
  });

  it("no OCR task ever resolves to Jev for an opted-in org with a working Jev key", async () => {
    const orgId = await seedOptedInOrg();
    vi.stubEnv("JEV_BASE_URL", JEV_ENDPOINT);

    // Even a saved override naming Jev on an OCR task is cleaned at rest.
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      taskChains: {
        statement_ocr: [JEV_HOP, { provider: "gemini", model: "gemini-3.1-flash-image-preview" }],
        bill_ocr: [JEV_HOP],
      },
    });
    const [row] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, orgId));
    const stored = row.taskChains as Record<string, Array<{ provider: string }>>;
    expect(stored.statement_ocr).toEqual([
      { provider: "gemini", model: "gemini-3.1-flash-image-preview" },
    ]);
    expect(stored.bill_ocr).toEqual(DEFAULT_CHAINS.bill_ocr);

    for (const task of DOCUMENT_TASKS) {
      const prepared = await productionAiCompletionRuntime.prepare({ task, orgId });
      expect(prepared.kind, task).toBe("ready");
      if (prepared.kind === "ready") {
        expect(
          prepared.hops.every((hop) => hop.provider === "gemini"),
          `${task}: ${JSON.stringify(prepared.hops)}`,
        ).toBe(true);
      }
    }
  });

  it("a saved override cannot route another text task to Jev", async () => {
    const orgId = await seedOrg();
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      providerAllowlist: ["jev"],
      taskChains: {
        date_parse: [JEV_HOP],
        match_assist: [JEV_HOP, { provider: "gemini", model: "gemini-3-flash-preview" }],
        // On a Jev task an explicit placement is kept.
        ingest_triage: [
          { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
          { provider: "jev", model: "jev-2" },
        ],
      },
    });

    const [row] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, orgId));
    const stored = row.taskChains as Record<string, unknown>;
    expect(stored.date_parse).toBeUndefined();
    expect(stored.match_assist).toEqual([{ provider: "gemini", model: "gemini-3-flash-preview" }]);
    expect(stored.ingest_triage).toEqual([
      { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
      { provider: "jev", model: "jev-2" },
    ]);
  });

  it("a Jev credential cannot carry a tenant endpoint; the operator endpoint always wins", async () => {
    const orgId = await seedOrg();
    await expect(
      addOrgAiCredential(db, {
        orgId,
        actorId,
        provider: "jev",
        apiKey: JEV_KEY,
        baseUrl: "https://attacker.example/v1",
      }),
    ).rejects.toThrow(/only supported for openai_compatible/);

    // A row written around the admin API still cannot redirect Jev.
    await sql`
      INSERT INTO organization_ai_credentials (organization_id, provider, encrypted_key, base_url)
      VALUES (${orgId}, 'jev', ${encryptSecret(JEV_KEY)}, 'https://attacker.example/v1')`;
    vi.stubEnv("JEV_BASE_URL", JEV_ENDPOINT);
    const credentials = await getOrgCredentials(db, orgId, "jev");
    expect(credentials.map((credential) => credential.baseUrl)).toEqual([JEV_ENDPOINT]);
  });

  it("opting out removes Jev again, with its own audit row", async () => {
    const orgId = await seedOptedInOrg();

    await updateOrgAiConfig(db, { orgId, actorId, providerAllowlist: ["gemini"] });

    const [row] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, orgId));
    expect(row.providerAllowlist).toEqual(["gemini"]);
    expect(isProviderAllowed(await routerSettings(orgId), "jev")).toBe(false);

    const config = await getOrgAiConfig(db, orgId);
    for (const view of config.effectiveChains) {
      expect(
        view.hops.some((hop) => hop.provider === "jev"),
        view.task,
      ).toBe(false);
    }

    vi.stubEnv("JEV_BASE_URL", JEV_ENDPOINT);
    const prepared = await productionAiCompletionRuntime.prepare({ task: "ingest_triage", orgId });
    expect(prepared).toEqual({ kind: "ready", hops: DEFAULT_CHAINS.ingest_triage });

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.organizationId, orgId), eq(activityLogs.action, "ai_settings_updated")),
      );
    expect(logs.map((log: any) => log.changes.providerAllowlist)).toEqual(
      expect.arrayContaining([
        { old: null, new: ["gemini", "jev"] },
        { old: ["gemini", "jev"], new: ["gemini"] },
      ]),
    );
  });

  it("Jev calls are priced, so they count against the monthly spend cap", async () => {
    const orgId = await seedOptedInOrg();
    await updateOrgAiConfig(db, { orgId, actorId, monthlySpendCapUsd: 0.4 });

    const invocationId = await logProviderInvocation({
      orgId,
      task: "ingest_triage",
      provider: "jev",
      model: JEV_MODEL,
      tokensIn: 50_000,
      tokensOut: 10_000,
    });
    expect(invocationId).not.toBeNull();
    const [logged] = await db
      .select({ costUsd: aiInvocations.costUsd })
      .from(aiInvocations)
      .where(eq(aiInvocations.id, invocationId as string));
    // Placeholder $5 / $25 per MTok: 0.25 + 0.25.
    expect(Number(logged.costUsd)).toBeCloseTo(0.5, 6);

    invalidateSpendCache(orgId);
    expect(await monthToDateSpendUsd(db, orgId)).toBeCloseTo(0.5, 6);

    invalidateSpendCache(orgId);
    await expect(
      productionAiCompletionRuntime.prepare({ task: "ingest_triage", orgId }),
    ).rejects.toBeInstanceOf(AiSpendCapError);
  });
});
