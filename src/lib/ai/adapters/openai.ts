// ============================================================================
// OpenAI adapter — also serves every OpenAI-COMPATIBLE endpoint (vLLM,
// Ollama, OpenRouter, Together, Groq) via a baseURL swap, which is why the
// provider abstraction has three SHAPES rather than N vendors
// (AI_MULTIPROVIDER_PLAN §2.1).
//
// Structured output uses json_schema with strict:true, so the Zod schema is
// converted through toStrictJsonSchema (Zod 4 native + the strict-mode
// post-pass OpenAI requires: additionalProperties:false and every property
// listed as required).
//
// Text tasks only — see the OCR-egress decision in redact.ts.
//
// A compatible endpoint is a THIRD PARTY chosen by the tenant, so the client
// built for it sends only what the request needs. Two SDK defaults are
// switched off there, and only there (first-party OpenAI is unchanged):
//   • OpenAI-Organization / OpenAI-Project — when these options are left
//     undefined the SDK fills them from OPENAI_ORG_ID / OPENAI_PROJECT_ID in
//     OUR environment, handing the operator's OpenAI account identity to an
//     arbitrary URL. They are set to null, the SDK's "send nothing".
//   • x-stainless-* — SDK telemetry on every request: OS, CPU architecture,
//     runtime and version, SDK version, retry count and timeout. The SDK has
//     no switch for these, so a fetch wrapper removes them at the wire, and
//     removes the two OpenAI-* headers too in case a later SDK release finds
//     another way to set them.
// ============================================================================

import OpenAI, { type ClientOptions } from "openai";
import type { z } from "zod";
import { AiProviderError, classifyByStatus, type AiErrorClass, type AiProvider } from "../errors";
import type { RedactedPrompt } from "../redact";
import { toStrictJsonSchema } from "../schema-strict";

const REQUEST_TIMEOUT_MS = 120_000;

function isFirstPartyOnlyHeader(name: string): boolean {
  // Headers#keys() yields lowercased names.
  return (
    name.startsWith("x-stainless-") || name === "openai-organization" || name === "openai-project"
  );
}

/** fetch for third-party endpoints: forwards the request minus SDK/operator headers. */
const thirdPartyFetch: NonNullable<ClientOptions["fetch"]> = (input, init) => {
  const headers = new Headers(init?.headers);
  // Collected first: deleting while iterating a Headers object skips entries.
  const stripped = [...headers.keys()].filter(isFirstPartyOnlyHeader);
  for (const name of stripped) headers.delete(name);
  // The global is resolved per call, not captured at module load.
  return fetch(input, { ...init, headers });
};

export interface OpenAiCallArgs<TOut> {
  apiKey: string;
  model: string;
  /** Set for openai_compatible gateways; omit for OpenAI proper. */
  baseURL?: string;
  /**
   * Provider errors are attributed to. Defaults to openai_compatible when a
   * baseURL is set and openai otherwise; wire-compatible vendors with their
   * own identity (jev) pass it explicitly.
   */
  provider?: AiProvider;
  prompt: RedactedPrompt;
  schema: z.ZodType<TOut>;
  schemaName: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Client overrides for adapters built on this one (see adapters/jev.ts): a
   * tighter timeout/retry budget, explicit null OpenAI org/project headers,
   * and a `fetch` seam so tests replay recorded bodies without a network.
   */
  clientOptions?: Pick<
    ClientOptions,
    "timeout" | "maxRetries" | "organization" | "project" | "fetch"
  >;
}

export interface OpenAiCallResult {
  text: string;
  usage: { tokensIn: number | null; tokensOut: number | null };
}

export function classifyOpenAiError(err: unknown): AiErrorClass {
  if (err instanceof OpenAI.APIError) {
    if (err.status) return classifyByStatus(err.status);
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (err instanceof OpenAI.APIConnectionError) return "network";
  return "unknown";
}

function scrub(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("***");
}

export async function generateStructuredOpenAi<TOut>(
  args: OpenAiCallArgs<TOut>,
): Promise<OpenAiCallResult> {
  const client = new OpenAI({
    apiKey: args.apiKey,
    ...(args.baseURL
      ? { baseURL: args.baseURL, organization: null, project: null, fetch: thirdPartyFetch }
      : {}),
    timeout: REQUEST_TIMEOUT_MS,
    ...args.clientOptions,
  });

  try {
    const response = await client.chat.completions.create({
      model: args.model,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      ...(args.maxOutputTokens !== undefined ? { max_tokens: args.maxOutputTokens } : {}),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: args.schemaName,
          strict: true,
          schema: toStrictJsonSchema(args.schema) as Record<string, unknown>,
        },
      },
      messages: [{ role: "user", content: String(args.prompt) }],
    });

    return {
      text: response.choices[0]?.message?.content ?? "",
      usage: {
        tokensIn: response.usage?.prompt_tokens ?? null,
        tokensOut: response.usage?.completion_tokens ?? null,
      },
    };
  } catch (err) {
    throw new AiProviderError({
      class: classifyOpenAiError(err),
      provider: args.provider ?? (args.baseURL ? "openai_compatible" : "openai"),
      status: err instanceof OpenAI.APIError ? (err.status ?? undefined) : undefined,
      cause: err,
      message: scrub(err instanceof Error ? err.message : String(err), args.apiKey),
    });
  }
}
