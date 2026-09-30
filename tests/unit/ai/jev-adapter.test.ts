// ============================================================================
// Jev adapter: request/response mapping against a stubbed fetch, error
// mapping, and redaction enforcement. The wire format is an ASSUMPTION (see
// the header of src/lib/ai/adapters/jev.ts); these tests pin what we send and
// how we read the reply, so confirming Jev means diffing this file against
// TypeSafe AI's documentation.
// ============================================================================
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  JEV_MAX_RETRIES,
  JEV_TIMEOUT_MS,
  assertRedactedForJev,
  estimateTokens,
  generateStructuredJev,
  type JevCallArgs,
} from "../../../src/lib/ai/adapters/jev";
import { AiProviderError } from "../../../src/lib/ai/errors";
import { createAiComplete, type AiCompletionRuntime } from "../../../src/lib/ai/facade-core";
import { getTaskEntry } from "../../../src/lib/ai/prompts";
import { toRedactedPrompt, type RedactedPrompt } from "../../../src/lib/ai/redact";
import { toStrictJsonSchema } from "../../../src/lib/ai/schema-strict";
import { ingestTriageOutputSchema } from "../../../src/lib/ai/schemas/ingest-triage";

const BASE_URL = "https://jev.example.test/v1";
const API_KEY = "jev-TESTONLY-key-7781";
const TRIAGE_JSON =
  '{"docKind":"bill","confidence":0.91,"reasoning":"amount due and bill-to block"}';

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function chatCompletion(content: string | null, usage?: Record<string, number>) {
  return {
    id: "chatcmpl-jev-test",
    object: "chat.completion",
    created: 1_790_000_000,
    model: "jev-1",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  };
}

/** A fetch stub that records every request and answers with `reply`. */
function stubFetch(reply: () => Response) {
  const requests: CapturedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return reply();
  });
  return { fetch, requests };
}

function callArgs(overrides: Partial<JevCallArgs<unknown>> = {}): JevCallArgs<unknown> {
  return {
    apiKey: API_KEY,
    baseURL: BASE_URL,
    model: "jev-1",
    prompt: toRedactedPrompt("Filename: acme-bill.pdf\nMIME type: application/pdf").prompt,
    schema: ingestTriageOutputSchema,
    schemaName: "ingest_triage",
    temperature: 0.1,
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<AiProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderError);
    return error as AiProviderError;
  }
  throw new Error("expected the Jev call to reject");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Jev adapter — request mapping (ASSUMPTIONS A1-A4)", () => {
  it("POSTs an OpenAI-compatible chat completion to JEV_BASE_URL with the org key", async () => {
    const { fetch, requests } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    const args = callArgs({ fetch });

    await generateStructuredJev(args);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.body).toEqual({
      model: "jev-1",
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ingest_triage",
          strict: true,
          schema: toStrictJsonSchema(ingestTriageOutputSchema),
        },
      },
      messages: [{ role: "user", content: String(args.prompt) }],
    });
  });

  it("sends max_tokens only when the task sets an output budget", async () => {
    const { fetch, requests } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    await generateStructuredJev(callArgs({ fetch, temperature: undefined, maxOutputTokens: 256 }));
    expect(requests[0].body.max_tokens).toBe(256);
    expect(requests[0].body).not.toHaveProperty("temperature");
  });

  it("never forwards the deployment's OpenAI org/project identity to Jev", async () => {
    vi.stubEnv("OPENAI_ORG_ID", "org-TESTONLY-must-not-leak");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-TESTONLY-must-not-leak");
    const { fetch, requests } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));

    await generateStructuredJev(callArgs({ fetch }));

    expect(requests[0].headers.get("openai-organization")).toBeNull();
    expect(requests[0].headers.get("openai-project")).toBeNull();
  });

  it("keeps the first hop short: bounded timeout and a single retry", () => {
    expect(JEV_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(JEV_MAX_RETRIES).toBe(1);
  });
});

describe("Jev adapter — response mapping (ASSUMPTION A5)", () => {
  it("returns choices[0].message.content verbatim with the reported usage", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(chatCompletion(TRIAGE_JSON, { prompt_tokens: 212, completion_tokens: 31 })),
    );

    const result = await generateStructuredJev(callArgs({ fetch }));

    expect(result).toEqual({
      text: TRIAGE_JSON,
      usage: { tokensIn: 212, tokensOut: 31 },
      usageEstimated: false,
    });
  });

  it("estimates usage pessimistically when Jev omits it, so the spend cap still sees the call", async () => {
    const { fetch } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    const args = callArgs({ fetch });

    const result = await generateStructuredJev(args);

    expect(result.usageEstimated).toBe(true);
    expect(result.usage.tokensIn).toBe(estimateTokens(String(args.prompt)));
    expect(result.usage.tokensOut).toBe(estimateTokens(TRIAGE_JSON));
    // About 3 characters per token: an over-count next to the ~4 typical.
    expect(estimateTokens("x".repeat(300))).toBe(100);
  });

  it("maps a null content to empty text (the façade's schema check then escalates)", async () => {
    const { fetch } = stubFetch(() => jsonResponse(chatCompletion(null, { prompt_tokens: 5 })));
    const result = await generateStructuredJev(callArgs({ fetch }));
    expect(result.text).toBe("");
  });
});

describe("Jev adapter — error mapping (ASSUMPTION A6)", () => {
  it("a rejected key is a credential failure attributed to jev, with the key scrubbed", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ error: { message: `Incorrect API key provided: ${API_KEY}` } }, 401),
    );

    const error = await captureError(generateStructuredJev(callArgs({ fetch })));

    expect(error.provider).toBe("jev");
    expect(error.errorClass).toBe("invalid_key");
    expect(error.isCredentialFailure).toBe(true);
    expect(error.escalateChain).toBe(true);
    expect(error.message).not.toContain(API_KEY);
  });

  it("rate limits and overloads stay transient and escalate to Gemini", async () => {
    const noRetry = { "x-should-retry": "false" };
    const rateLimited = await captureError(
      generateStructuredJev(
        callArgs({ fetch: stubFetch(() => jsonResponse({}, 429, noRetry)).fetch }),
      ),
    );
    expect(rateLimited.errorClass).toBe("rate_limited");
    expect(rateLimited.retryableSameProvider).toBe(true);

    const overloaded = await captureError(
      generateStructuredJev(
        callArgs({ fetch: stubFetch(() => jsonResponse({}, 503, noRetry)).fetch }),
      ),
    );
    expect(overloaded.errorClass).toBe("overloaded");
    expect(overloaded.escalateChain).toBe(true);
  });

  it("a request Jev rejects (e.g. unsupported response_format) escalates instead of aborting", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ error: { message: "response_format json_schema is not supported" } }, 400),
    );

    const error = await captureError(generateStructuredJev(callArgs({ fetch })));

    expect(error.provider).toBe("jev");
    expect(error.errorClass).toBe("schema_rejection");
    expect(error.status).toBe(400);
    expect(error.escalateChain).toBe(true);
    expect(error.isCredentialFailure).toBe(false);
  });

  it("a reply that is not the assumed chat-completion shape escalates instead of aborting", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response("<html>gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = await captureError(generateStructuredJev(callArgs({ fetch })));

    expect(error.errorClass).toBe("schema_rejection");
    expect(error.escalateChain).toBe(true);
  });

  it("refuses to call Jev when the operator endpoint is missing", async () => {
    const { fetch } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));

    const error = await captureError(
      generateStructuredJev(callArgs({ fetch, baseURL: undefined })),
    );

    expect(error.errorClass).toBe("egress_refused");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Jev adapter — redaction enforcement", () => {
  it("accepts only a RedactedPrompt, and has no field that could carry document bytes", () => {
    expectTypeOf<JevCallArgs<unknown>["prompt"]>().toEqualTypeOf<RedactedPrompt>();
    expectTypeOf<string>().not.toExtend<RedactedPrompt>();
    expectTypeOf<
      "media" extends keyof JevCallArgs<unknown> ? true : false
    >().toEqualTypeOf<false>();

    // @ts-expect-error — raw text is not a RedactedPrompt; only toRedactedPrompt mints one.
    const raw: JevCallArgs<unknown>["prompt"] = "Account #12345678901";
    void raw;
  });

  it("rejects an unredacted prompt smuggled past the type with a cast, before any network call", async () => {
    const { fetch } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    const smuggled = "Filename: payroll.csv\nSSN 123-45-6789" as RedactedPrompt;

    const error = await captureError(generateStructuredJev(callArgs({ fetch, prompt: smuggled })));

    expect(error.provider).toBe("jev");
    expect(error.errorClass).toBe("egress_refused");
    expect(error.escalateChain).toBe(true);
    expect(error.isCredentialFailure).toBe(false);
    expect(error.retryableSameProvider).toBe(false);
    // The refusal names the kind of data, never the value.
    expect(error.message).toContain("ssn");
    expect(error.message).not.toContain("123-45-6789");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the masked form of a prompt that went through toRedactedPrompt", async () => {
    const { fetch, requests } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    const { prompt } = toRedactedPrompt(
      "Filename: payroll.csv\nSSN 123-45-6789\nAcct: 1234567890123",
    );

    await generateStructuredJev(callArgs({ fetch, prompt }));

    const content = JSON.stringify(requests[0].body.messages);
    expect(content).not.toContain("123-45-6789");
    expect(content).not.toContain("1234567890123");
    expect(content).toContain("6789");
  });

  it("sends the fixed-point mask of PII that a single pass used to leave behind", async () => {
    // The SSN is glued to a masked-looking run. Redaction repeats until the
    // text stops changing, so the SSN is masked once the X-run becomes stars,
    // and that result is a fixed point Jev may receive.
    const { prompt } = toRedactedPrompt("Filename: 219-44-2138XXXX-5620-1278.pdf");
    expect(String(prompt)).toBe("Filename: *****2138****1278.pdf");
    expect(() => assertRedactedForJev(String(prompt))).not.toThrow();

    const { fetch, requests } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    await generateStructuredJev(callArgs({ fetch, prompt }));
    const content = JSON.stringify(requests[0].body.messages);
    expect(content).toContain("*****2138****1278");
    expect(content).not.toContain("219-44-2138");
    expect(content).not.toContain("5620");
  });

  it("a refused Jev hop falls back to Gemini through the façade, and Jev never sees the text", async () => {
    const { fetch } = stubFetch(() => jsonResponse(chatCompletion(TRIAGE_JSON)));
    const geminiAnswer = '{"docKind":"other","confidence":0.4,"reasoning":"filename only"}';
    const runtime: AiCompletionRuntime = {
      prepare: async () => ({
        kind: "ready",
        hops: [
          { provider: "jev", model: "jev-1" },
          { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
        ],
      }),
      invokeHop: async (input) => {
        if (input.hop.provider === "jev") {
          // The façade redacts before this hop, and that pass is now a fixed
          // point, so a real filename no longer leaves residual PII. This
          // cast is the remaining way a prompt still holds an SSN: Jev must
          // refuse it without a network call so the chain can fall back.
          const smuggled = "Filename: payroll.csv\nSSN 123-45-6789" as RedactedPrompt;
          const result = await generateStructuredJev({
            apiKey: API_KEY,
            baseURL: BASE_URL,
            model: input.hop.model,
            prompt: smuggled,
            schema: input.schema,
            schemaName: "ingest_triage",
            fetch,
          });
          return { text: result.text, invocationId: null, model: input.hop.model };
        }
        return { text: geminiAnswer, invocationId: null, model: input.hop.model };
      },
      recordValidationOutcome: async () => {},
    };

    const result = await createAiComplete(runtime)({
      task: "ingest_triage",
      input: { filename: "payroll.csv", mimeType: "application/pdf" },
      ctx: { orgId: "org-jev-redaction" },
    });

    expect(result).toMatchObject({ ok: true, model: "gemini-3.1-flash-lite-preview" });
    expect(fetch).not.toHaveBeenCalled();
    // Same façade, same prompt builder: the task entry is the real one.
    expect(getTaskEntry("ingest_triage").schema).toBe(ingestTriageOutputSchema);
  });
});
