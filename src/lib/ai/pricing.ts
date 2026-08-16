// ============================================================================
// Token pricing → per-invocation cost, for spend visibility and the monthly
// cap (ai_findings #10: a BYOK integration that inlines whole documents had
// zero cost accounting).
//
// Prices are USD per MILLION tokens and WILL drift — they are a budgeting
// aid, not billing. An unknown model yields a null cost (logged, never
// blocking), so a new model can never silently price at zero OR wedge a
// tenant out of their AI features.
// ============================================================================

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

/**
 * Keyed by a model-id PREFIX so pinned snapshot ids
 * ("claude-sonnet-5-20260101") match their family entry.
 */
const PRICE_TABLE: Array<{ prefix: string; price: ModelPrice }> = [
  // Anthropic
  { prefix: "claude-opus-4", price: { inputPerMTok: 5, outputPerMTok: 25 } },
  { prefix: "claude-sonnet-5", price: { inputPerMTok: 3, outputPerMTok: 15 } },
  { prefix: "claude-haiku-4", price: { inputPerMTok: 1, outputPerMTok: 5 } },
  // Google (flash tiers are the OCR workhorses — cheap per page)
  { prefix: "gemini-3.1-flash", price: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { prefix: "gemini-3-flash", price: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { prefix: "gemini-2.5-flash", price: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { prefix: "gemini-3.1-pro", price: { inputPerMTok: 1.25, outputPerMTok: 5 } },
  { prefix: "gemini-3-pro", price: { inputPerMTok: 1.25, outputPerMTok: 5 } },
  { prefix: "gemini-embedding", price: { inputPerMTok: 0.15, outputPerMTok: 0 } },
  // OpenAI
  { prefix: "gpt-4o-mini", price: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { prefix: "gpt-4o", price: { inputPerMTok: 2.5, outputPerMTok: 10 } },
  { prefix: "gpt-4.1", price: { inputPerMTok: 2, outputPerMTok: 8 } },
];

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  // Longest prefix wins so "gpt-4o-mini" isn't captured by "gpt-4o".
  const matches = PRICE_TABLE.filter((entry) => model.startsWith(entry.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  return matches[0]?.price ?? null;
}

/**
 * Cost of one invocation in USD, or null when the model is unpriced.
 * Null is meaningful: it means "unknown", not "free".
 */
export function estimateCostUsd(input: {
  model: string | null | undefined;
  tokensIn: number | null | undefined;
  tokensOut: number | null | undefined;
}): number | null {
  const price = priceFor(input.model);
  if (!price) return null;
  const inTok = input.tokensIn ?? 0;
  const outTok = input.tokensOut ?? 0;
  if (inTok === 0 && outTok === 0) return null;
  const cost =
    (inTok / 1_000_000) * price.inputPerMTok + (outTok / 1_000_000) * price.outputPerMTok;
  // Sub-cent precision matters when a single page costs ~$0.0001.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
