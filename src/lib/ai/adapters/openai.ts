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
// ============================================================================

import OpenAI from "openai";
import type { z } from "zod";
import { AiProviderError, classifyByStatus, type AiErrorClass } from "../errors";
import type { RedactedPrompt } from "../redact";
import { toStrictJsonSchema } from "../schema-strict";

const REQUEST_TIMEOUT_MS = 120_000;

export interface OpenAiCallArgs<TOut> {
  apiKey: string;
  model: string;
  /** Set for openai_compatible gateways; omit for OpenAI proper. */
  baseURL?: string;
  prompt: RedactedPrompt;
  schema: z.ZodType<TOut>;
  schemaName: string;
  temperature?: number;
  maxOutputTokens?: number;
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
    ...(args.baseURL ? { baseURL: args.baseURL } : {}),
    timeout: REQUEST_TIMEOUT_MS,
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
      provider: args.baseURL ? "openai_compatible" : "openai",
      status: err instanceof OpenAI.APIError ? (err.status ?? undefined) : undefined,
      cause: err,
      message: scrub(err instanceof Error ? err.message : String(err), args.apiKey),
    });
  }
}
