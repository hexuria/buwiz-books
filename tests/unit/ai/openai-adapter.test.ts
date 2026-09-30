// ============================================================================
// What leaves the process when the OpenAI adapter calls out. A stubbed fetch
// records the request at the wire, after the SDK has added every header it
// adds, so these assertions hold whatever the SDK does internally.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructuredOpenAi } from "../../../src/lib/ai/adapters/openai";
import { toRedactedPrompt } from "../../../src/lib/ai/redact";

const OPERATOR_ORG = "org-OPERATOR-ONLY";
const OPERATOR_PROJECT = "proj-OPERATOR-ONLY";
const schema = z.object({ ok: z.boolean() });

interface SeenRequest {
  url: string;
  headers: Headers;
}

function stubFetch(): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"ok":true}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return seen;
}

function call(overrides: { apiKey: string; model: string; baseURL?: string }) {
  return generateStructuredOpenAi({
    ...overrides,
    prompt: toRedactedPrompt("Categorize: JOLLIBEE MAKATI 245.00").prompt,
    schema,
    schemaName: "probe",
  });
}

beforeEach(() => {
  // Operator-level OpenAI identity, as a deployment might set it.
  vi.stubEnv("OPENAI_ORG_ID", OPERATOR_ORG);
  vi.stubEnv("OPENAI_PROJECT_ID", OPERATOR_PROJECT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAI adapter — openai_compatible (third-party) endpoints", () => {
  it("sends no SDK telemetry and no operator OpenAI ids", async () => {
    const seen = stubFetch();

    const result = await call({
      apiKey: "tenant-gateway-key",
      model: "jev-ledger-7b",
      baseURL: "https://llm.example.test/v1",
    });

    expect(result).toEqual({ text: '{"ok":true}', usage: { tokensIn: 11, tokensOut: 3 } });
    expect(seen).toHaveLength(1);
    const [{ url, headers }] = seen;
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect([...headers.keys()].filter((name) => name.startsWith("x-stainless-"))).toEqual([]);
    expect(headers.has("openai-organization")).toBe(false);
    expect(headers.has("openai-project")).toBe(false);
    expect(JSON.stringify([...headers.entries()])).not.toContain("OPERATOR-ONLY");
    // What the request needs still goes.
    expect(headers.get("authorization")).toBe("Bearer tenant-gateway-key");
    expect(headers.get("content-type")).toContain("application/json");
  });
});

describe("OpenAI adapter — first-party OpenAI", () => {
  it("keeps the SDK's default headers, including the configured org and project", async () => {
    const seen = stubFetch();

    await call({ apiKey: "sk-first-party", model: "gpt-4o-mini" });

    expect(seen).toHaveLength(1);
    const [{ url, headers }] = seen;
    expect(url.endsWith("/chat/completions")).toBe(true);
    expect(headers.get("openai-organization")).toBe(OPERATOR_ORG);
    expect(headers.get("openai-project")).toBe(OPERATOR_PROJECT);
    expect(headers.get("x-stainless-os")).toBeTruthy();
    expect(headers.get("x-stainless-arch")).toBeTruthy();
    expect(headers.get("x-stainless-runtime")).toBeTruthy();
    expect(headers.get("authorization")).toBe("Bearer sk-first-party");
  });
});
