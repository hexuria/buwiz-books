// ============================================================================
// Jev adapter — TypeSafe AI's cheap "system one" document classifier.
//
//   ASSUMPTION: wire format unverified; confirm with TypeSafe AI before enabling.
//
// Everything AROUND the wire is real, tested plumbing: the per-org opt-in and
// first-hop placement (applyJevPolicy in chains.ts), redaction enforcement
// (below), pricing that cannot slip past the spend cap (pricing.ts),
// credentials and provider health (credentials.ts, facade-runtime.ts), mock
// responses, and recorded evals. The wire itself is ASSUMED to be OpenAI Chat
// Completions, so this adapter reuses the OpenAI adapter instead of
// duplicating it. Confirming Jev means checking this list:
//
//   A1  Endpoint: POST {JEV_BASE_URL}/chat/completions. JEV_BASE_URL is
//       operator configuration read in credentials.ts (https, or http on
//       loopback for local stubs).
//   A2  Auth: `Authorization: Bearer <key>`. Keys are org BYOK rows in
//       organization_ai_credentials; there is no env-key fallback, because no
//       other provider has one.
//   A3  Request: { model, messages: [{ role: "user", content }], temperature?,
//       max_tokens?, response_format: { type: "json_schema", json_schema:
//       { name, strict: true, schema } } }. One user message, no system role.
//   A4  Structured output accepts a strict JSON Schema: enums, every property
//       required, additionalProperties: false (see schema-strict.ts).
//   A5  Response: choices[0].message.content holds the JSON text; usage has
//       prompt_tokens / completion_tokens (estimated below when absent).
//   A6  Errors follow OpenAI status semantics: 401/403 key, 429 rate limit,
//       5xx overload, 408/504 timeout.
//   A7  Model id: JEV_MODEL ("jev-1") in chains.ts.
//   A8  Latency: answers well inside JEV_TIMEOUT_MS with one retry. After
//       that the chain falls back to Gemini.
//   A9  Price: unknown. pricing.ts carries a TODO(jev-pricing) placeholder.
//
// Not covered by any of the above: rate limits, data residency, retention,
// and the DPA. The opt-in stays off by default until those are settled.
// ============================================================================

import type { ClientOptions } from "openai";
import type { z } from "zod";
import { AiProviderError } from "../errors";
import { redactPII, type RedactedPrompt } from "../redact";
import { generateStructuredOpenAi, type OpenAiCallResult } from "./openai";

/** A8: a first hop must give way to Gemini quickly, not hold the call open. */
export const JEV_TIMEOUT_MS = 30_000;
export const JEV_MAX_RETRIES = 1;

export interface JevCallArgs<TOut> {
  apiKey: string;
  /** Operator endpoint (JEV_BASE_URL), attached to the credential by credentials.ts. */
  baseURL: string | undefined;
  model: string;
  /**
   * Branded: only toRedactedPrompt can produce one, so raw text does not
   * typecheck here, and assertRedactedForJev catches a cast at runtime. There
   * is deliberately no media field: Jev never receives document bytes.
   */
  prompt: RedactedPrompt;
  schema: z.ZodType<TOut>;
  schemaName: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Test seam: replays a recorded response body instead of calling Jev. */
  fetch?: ClientOptions["fetch"];
}

export interface JevCallResult extends OpenAiCallResult {
  /** True when Jev omitted usage and the token counts were estimated. */
  usageEstimated: boolean;
}

/**
 * Deliberately pessimistic token estimate (about 3 characters per token,
 * where English averages about 4). Used only when Jev omits usage, so the
 * call still carries a cost into the monthly spend cap.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Refuse egress unless the prompt is a fixed point of redaction.
 *
 * The RedactedPrompt brand is compile-time only, so a cast defeats it. A
 * single redaction pass is also not idempotent: PII glued to an already
 * masked run can survive it. In both cases the prompt still holds something
 * the redactor would mask, so Jev must not receive it. The refusal escalates
 * the chain (nothing was sent, the key is not at fault) and names PII kinds,
 * never values.
 */
export function assertRedactedForJev(prompt: string): void {
  const { hits } = redactPII(prompt);
  if (hits.length === 0) return;
  const kinds = [...new Set(hits.map((hit) => hit.kind))].join(", ");
  throw new AiProviderError({
    class: "egress_refused",
    provider: "jev",
    message: `Refused to send the prompt to Jev: it still contains redactable data (${kinds}).`,
  });
}

export async function generateStructuredJev<TOut>(args: JevCallArgs<TOut>): Promise<JevCallResult> {
  assertRedactedForJev(String(args.prompt));
  if (!args.baseURL) {
    throw new AiProviderError({
      class: "egress_refused",
      provider: "jev",
      message: "Jev endpoint (JEV_BASE_URL) is not configured.",
    });
  }

  let result: OpenAiCallResult;
  try {
    result = await generateStructuredOpenAi({
      apiKey: args.apiKey,
      baseURL: args.baseURL,
      provider: "jev",
      model: args.model,
      prompt: args.prompt,
      schema: args.schema,
      schemaName: args.schemaName,
      temperature: args.temperature,
      maxOutputTokens: args.maxOutputTokens,
      clientOptions: {
        timeout: JEV_TIMEOUT_MS,
        maxRetries: JEV_MAX_RETRIES,
        // The SDK would otherwise forward OPENAI_ORG_ID / OPENAI_PROJECT_ID
        // from the environment. Those identify an OpenAI account and must
        // never reach a third party.
        organization: null,
        project: null,
        ...(args.fetch ? { fetch: args.fetch } : {}),
      },
    });
  } catch (err) {
    // Gemini stays the fallback, unconditionally. A request Jev rejects (A3/A4
    // unverified: a 400 most likely means an unsupported response_format) or
    // a body the SDK cannot read (A5) must advance the chain rather than abort
    // the task, so every class that would not escalate is re-labelled.
    if (err instanceof AiProviderError && !err.escalateChain) {
      throw new AiProviderError({
        class: "schema_rejection",
        provider: "jev",
        status: err.status,
        cause: err.cause,
        message: err.message,
      });
    }
    throw err;
  }

  const { tokensIn, tokensOut } = result.usage;
  return {
    text: result.text,
    usage: {
      tokensIn: tokensIn ?? estimateTokens(String(args.prompt)),
      tokensOut: tokensOut ?? estimateTokens(result.text),
    },
    usageEstimated: tokensIn == null || tokensOut == null,
  };
}
