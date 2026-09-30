// ============================================================================
// The monthly spend cap must see calls to models that have no price entry.
//
// Before: estimateCostUsd returned null for an unpriced model, the
// month-to-date SUM read that as $0, and a custom openai_compatible model
// could spend without limit under a cap that looked enforced. These tests go
// through the real telemetry write, the real SUM, and the real prepare() gate.
// ============================================================================
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { aiInvocations, organizationAiSettings } from "../../src/db/schema/ai";
import { organization } from "../../src/db/schema/auth";
import { productionAiCompletionRuntime } from "../../src/lib/ai/facade-runtime";
import { logProviderInvocation } from "../../src/lib/ai/invoke";
import { addOrgAiCredential } from "../../src/lib/ai/org-ai-config";
import {
  FALLBACK_CHARS_PER_TOKEN,
  priceFor,
  UNPRICED_MODEL_FALLBACK_PRICE,
} from "../../src/lib/ai/pricing";
import { getTaskEntry } from "../../src/lib/ai/prompts";
import { toRedactedPrompt } from "../../src/lib/ai/redact";
import { invalidateOrgAiSettings } from "../../src/lib/ai/settings";
import { AiSpendCapError, invalidateSpendCache } from "../../src/lib/ai/spend";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** A custom gateway model — deliberately absent from the price table. */
const UNPRICED_MODEL = "jev-ledger-7b";

describeDb("spend cap — models without a price entry", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedOrgWithCap(capUsd: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(organization).values({
      id,
      name: `Unpriced Spend Org ${id.slice(0, 8)}`,
      slug: `unpriced-spend-${id.slice(0, 8)}`,
    });
    await db
      .insert(organizationAiSettings)
      .values({ organizationId: id, monthlySpendCapUsd: capUsd });
    invalidateOrgAiSettings(id);
    invalidateSpendCache(id);
    return id;
  }

  it("records a fallback cost for an unpriced model and blocks the org once the cap is reached", async () => {
    expect(priceFor(UNPRICED_MODEL)).toBeNull();
    const orgId = await seedOrgWithCap("1.00");

    // Under the cap, prepare() gets past the spend check and stops only for
    // want of credentials.
    await expect(
      productionAiCompletionRuntime.prepare({ task: "date_parse", orgId }),
    ).resolves.toMatchObject({ kind: "no_credentials" });

    const tokensIn = 150_000;
    const tokensOut = 20_000;
    const invocationId = await logProviderInvocation({
      orgId,
      task: "transaction_parse",
      provider: "openai_compatible",
      model: UNPRICED_MODEL,
      tokensIn,
      tokensOut,
    });
    expect(invocationId).not.toBeNull();

    const [row] = await db.select().from(aiInvocations).where(eq(aiInvocations.id, invocationId!));
    const expectedCost =
      (tokensIn / 1_000_000) * UNPRICED_MODEL_FALLBACK_PRICE.inputPerMTok +
      (tokensOut / 1_000_000) * UNPRICED_MODEL_FALLBACK_PRICE.outputPerMTok;
    expect(expectedCost).toBeGreaterThanOrEqual(1);
    expect(row.tokensIn).toBe(tokensIn);
    expect(row.tokensOut).toBe(tokensOut);
    expect(Number(row.costUsd)).toBeCloseTo(expectedCost, 6);

    invalidateSpendCache(orgId);
    await expect(
      productionAiCompletionRuntime.prepare({ task: "date_parse", orgId }),
    ).rejects.toBeInstanceOf(AiSpendCapError);
  });

  it("meters an openai_compatible call whose gateway reports no usage", async () => {
    const orgId = await seedOrgWithCap("0.000001");
    await addOrgAiCredential(db, {
      orgId,
      actorId: "user-unpriced-spend",
      provider: "openai_compatible",
      apiKey: "TESTONLY-COMPATIBLE-GATEWAY-KEY",
      baseUrl: "https://llm.example.test/v1",
    });

    const responseText = '{"date":"2026-01-31"}';
    const seenHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers));
        // A gateway that omits `usage` entirely.
        return new Response(
          JSON.stringify({
            id: "chatcmpl-no-usage",
            object: "chat.completion",
            created: 0,
            model: UNPRICED_MODEL,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: responseText },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const entry = getTaskEntry("date_parse");
    const { prompt, hits } = toRedactedPrompt("Parse this date: 31/01/2026");
    const result = await productionAiCompletionRuntime.invokeHop({
      hop: { provider: "openai_compatible", model: UNPRICED_MODEL },
      position: 0,
      task: "date_parse",
      prompt,
      schema: entry.schema,
      ctx: { orgId },
      entry,
      redactionHits: hits.length,
    });

    expect(result.text).toBe(responseText);
    // The production wiring hands the credential's base URL to the adapter,
    // so the third-party header policy applies on this path.
    expect(seenHeaders).toHaveLength(1);
    expect([...seenHeaders[0].keys()].some((name) => name.startsWith("x-stainless-"))).toBe(false);

    const [row] = await db
      .select()
      .from(aiInvocations)
      .where(eq(aiInvocations.id, result.invocationId!));
    expect(row.provider).toBe("openai_compatible");
    expect(row.tokensIn).toBe(Math.ceil(String(prompt).length / FALLBACK_CHARS_PER_TOKEN));
    expect(row.tokensOut).toBe(Math.ceil(responseText.length / FALLBACK_CHARS_PER_TOKEN));
    expect(row.configSnapshot).toMatchObject({ usageEstimated: true });
    expect(Number(row.costUsd)).toBeGreaterThan(0);

    invalidateSpendCache(orgId);
    await expect(
      productionAiCompletionRuntime.prepare({ task: "date_parse", orgId }),
    ).rejects.toBeInstanceOf(AiSpendCapError);
  });
});
