// ============================================================================
// Anthropic adapter.
//
// Uses the SDK's own Zod helper (`zodOutputFormat`) so the SAME Zod schema
// that validates the output also constrains generation — no second schema
// language. Errors are normalized to the shared AiProviderError taxonomy via
// the SDK's typed error classes (no substring matching, unlike Gemini).
//
// Per the adopted OCR-egress decision, this adapter serves TEXT tasks only;
// document/image media never routes here (enforced by the chain defaults in
// router.ts, which keep OCR categories Gemini-only).
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AiProviderError, classifyByStatus, type AiErrorClass } from "../errors";
import type { RedactedPrompt } from "../redact";

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicCallArgs<TOut> {
  apiKey: string;
  model: string;
  /** Branded: only redact.ts can produce this, so egress is always redacted. */
  prompt: RedactedPrompt;
  schema: z.ZodType<TOut>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AnthropicCallResult {
  text: string;
  usage: { tokensIn: number | null; tokensOut: number | null };
}

/** Map an SDK error to the shared taxonomy using typed classes, not messages. */
export function classifyAnthropicError(err: unknown): AiErrorClass {
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded_error is Anthropic-specific and not a generic 5xx.
    if (err.status === 529) return "overloaded";
    if (err.status) return classifyByStatus(err.status);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "network";
  return "unknown";
}

/** Strip anything resembling the credential from an error before it escapes. */
function scrub(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("***");
}

export async function generateStructuredAnthropic<TOut>(
  args: AnthropicCallArgs<TOut>,
): Promise<AnthropicCallResult> {
  const client = new Anthropic({ apiKey: args.apiKey, timeout: REQUEST_TIMEOUT_MS });

  try {
    const response = await client.messages.parse({
      model: args.model,
      max_tokens: args.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      output_format: zodOutputFormat(args.schema),
      messages: [{ role: "user", content: String(args.prompt) }],
    });

    // The façade re-validates with the same Zod schema, so hand back text and
    // keep exactly one validation path for every provider.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      usage: {
        tokensIn: response.usage?.input_tokens ?? null,
        tokensOut: response.usage?.output_tokens ?? null,
      },
    };
  } catch (err) {
    const cls = classifyAnthropicError(err);
    throw new AiProviderError({
      class: cls,
      provider: "anthropic",
      status: err instanceof Anthropic.APIError ? err.status : undefined,
      cause: err,
      message: scrub(err instanceof Error ? err.message : String(err), args.apiKey),
    });
  }
}
