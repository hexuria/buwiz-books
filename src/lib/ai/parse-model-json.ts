// ============================================================================
// Model output parsing — the single place raw model text becomes typed data.
//
// Every AI endpoint feeds its response text through parseModelJson with the
// task's Zod schema. Bad model output never throws here: the discriminated
// union is the contract, and each route decides what ok:false means for its
// clients (throw a clean error, return needs_review, park as data, …).
// ============================================================================

import type { z } from "zod";

export type ModelParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; needsReview: true; issues: string[]; rawText: string };

/**
 * Strip Markdown code fences from a model response.
 * Centralizes the per-route ```json / ``` handling previously duplicated
 * across every AI endpoint.
 */
export function stripJsonFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    // Drop the opening fence line (``` or ```json etc.)
    text = text.replace(/^```[a-zA-Z]*\s*/u, "");
    // Drop a trailing fence if present
    text = text.replace(/\s*```\s*$/u, "");
    text = text.trim();
  }
  return text;
}

/**
 * Parse raw model text into schema-validated data.
 * Never throws on malformed model output — returns ok:false with the issues.
 */
export function parseModelJson<T>(schema: z.ZodType<T>, rawText: string): ModelParseResult<T> {
  const jsonText = stripJsonFences(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      needsReview: true,
      issues: [`Model returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
      rawText,
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      needsReview: true,
      issues: result.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      ),
      rawText,
    };
  }

  return { ok: true, data: result.data };
}
