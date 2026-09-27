// ============================================================================
// Token pricing → per-invocation cost, for spend visibility and the monthly
// cap (ai_findings #10: a BYOK integration that inlines whole documents had
// zero cost accounting).
//
// Prices are USD per MILLION tokens and WILL drift — they are a budgeting
// aid, not billing. An unknown model yields a null cost (logged, never
// blocking), so a new model can never silently price at zero OR wedge a
// tenant out of their AI features.
//
// CAVEAT: the monthly cap (spend.ts) SUMS cost_usd, and SUM skips nulls, so
// an unpriced model's calls never count against the cap. That is why Jev is
// never unpriced: see JEV_PLACEHOLDER_PRICE.
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

/**
 * TODO(jev-pricing): PLACEHOLDER. TypeSafe AI has not published Jev pricing
 * (ASSUMPTION A9 in adapters/jev.ts).
 *
 * Until it is confirmed, every Jev call is priced at the TOP of PRICE_TABLE
 * rather than left unpriced. An unpriced call records a null cost, which the
 * cap's SUM ignores, so a new data processor would run past the org's budget
 * unmetered. Over-counting a supposedly cheap classifier trips the cap early;
 * that is the safe direction. Replace this with the confirmed rate and add a
 * PRICE_TABLE row for the real model id.
 */
export const JEV_PLACEHOLDER_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 };

/**
 * Price for a model. `provider` only matters for Jev, which falls back to the
 * placeholder for ANY model id (an org chain override may name one this table
 * has never seen), so a Jev call is never unpriced.
 */
export function priceFor(
  model: string | null | undefined,
  provider?: string | null,
): ModelPrice | null {
  const fallback = provider === "jev" ? JEV_PLACEHOLDER_PRICE : null;
  if (!model) return fallback;
  // Longest prefix wins so "gpt-4o-mini" isn't captured by "gpt-4o".
  const matches = PRICE_TABLE.filter((entry) => model.startsWith(entry.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  return matches[0]?.price ?? fallback;
}

/**
 * Cost of one invocation in USD, or null when the model is unpriced.
 * Null is meaningful: it means "unknown", not "free".
 */
export function estimateCostUsd(input: {
  model: string | null | undefined;
  /** Provider of the hop; lets Jev fall back to its placeholder price. */
  provider?: string | null;
  tokensIn: number | null | undefined;
  tokensOut: number | null | undefined;
}): number | null {
  const price = priceFor(input.model, input.provider);
  if (!price) return null;
  const inTok = input.tokensIn ?? 0;
  const outTok = input.tokensOut ?? 0;
  if (inTok === 0 && outTok === 0) return null;
  const cost =
    (inTok / 1_000_000) * price.inputPerMTok + (outTok / 1_000_000) * price.outputPerMTok;
  // Sub-cent precision matters when a single page costs ~$0.0001.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
