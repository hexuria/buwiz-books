// ============================================================================
// Token pricing → per-invocation cost, for spend visibility and the monthly
// cap (ai_findings #10: a BYOK integration that inlines whole documents had
// zero cost accounting).
//
// Prices are USD per MILLION tokens and WILL drift — they are a budgeting
// aid, not billing.
//
// A model missing from the table (a custom openai_compatible model, a newly
// renamed release, Jev — which has no published rate) is metered at
// UNPRICED_MODEL_FALLBACK_PRICE and logged once per model per process. It
// used to yield a null cost, which the month-to-date SUM reads as $0, so
// every call to an unpriced model was invisible to the spend cap: an org
// could run an unbounded bill on exactly the models nobody had reviewed.
// Over-counting is the safe direction for a cap the org can raise;
// under-counting silently switches it off. Add the model to PRICE_TABLE to
// meter it accurately.
// ============================================================================

import { createLogger } from "../logger";

const logger = createLogger("ai.pricing");

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
 * Rate for a model PRICE_TABLE does not know: the highest input rate and the
 * highest output rate in the table, so an unrecognized model is never metered
 * as cheaper than any model we do recognize. Derived rather than copied, so
 * adding a pricier model to the table raises it too.
 */
export const UNPRICED_MODEL_FALLBACK_PRICE: ModelPrice = {
  inputPerMTok: Math.max(...PRICE_TABLE.map((entry) => entry.price.inputPerMTok)),
  outputPerMTok: Math.max(...PRICE_TABLE.map((entry) => entry.price.outputPerMTok)),
};

/**
 * Characters per token assumed when a provider reports NO usage for a call
 * that succeeded. Deliberately low (English prose runs about 4 characters per
 * token, JSON about 3) so the estimate over-counts.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3;

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  // Longest prefix wins so "gpt-4o-mini" isn't captured by "gpt-4o".
  const matches = PRICE_TABLE.filter((entry) => model.startsWith(entry.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  return matches[0]?.price ?? null;
}

const warnedUnpricedModels = new Set<string>();

function warnUnpricedOnce(model: string | null | undefined): void {
  const key = model || "(unreported model)";
  if (warnedUnpricedModels.has(key)) return;
  warnedUnpricedModels.add(key);
  logger.warn("No price for model — metering at the conservative fallback rate", {
    model: key,
    fallbackInputPerMTok: UNPRICED_MODEL_FALLBACK_PRICE.inputPerMTok,
    fallbackOutputPerMTok: UNPRICED_MODEL_FALLBACK_PRICE.outputPerMTok,
  });
}

/**
 * Cost of one invocation in USD, or null when there is no usage to price
 * (a failed call). An unpriced model is metered at
 * UNPRICED_MODEL_FALLBACK_PRICE, never treated as free.
 */
export function estimateCostUsd(input: {
  model: string | null | undefined;
  tokensIn: number | null | undefined;
  tokensOut: number | null | undefined;
}): number | null {
  const inTok = input.tokensIn ?? 0;
  const outTok = input.tokensOut ?? 0;
  if (inTok === 0 && outTok === 0) return null;
  let price = priceFor(input.model);
  if (!price) {
    warnUnpricedOnce(input.model);
    price = UNPRICED_MODEL_FALLBACK_PRICE;
  }
  const cost =
    (inTok / 1_000_000) * price.inputPerMTok + (outTok / 1_000_000) * price.outputPerMTok;
  // Sub-cent precision matters when a single page costs ~$0.0001.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Token counts to meter for a call that SUCCEEDED. Some openai_compatible
 * gateways omit `usage` or report zeros; metering those as reported would
 * record a null cost, the same spend-cap bypass as an unpriced model. A
 * missing or zero count is estimated from the text actually sent or received
 * (a floor: the request's JSON schema also bills as input and is not counted),
 * and `estimated` says so, so telemetry never passes a guess off as a count.
 */
export function meteredUsage(
  reported: { tokensIn: number | null; tokensOut: number | null },
  promptText: string,
  responseText: string,
): { tokensIn: number; tokensOut: number; estimated: boolean } {
  const reportedIn = reported.tokensIn ?? 0;
  const reportedOut = reported.tokensOut ?? 0;
  const estimate = (text: string) => Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  const tokensIn = reportedIn > 0 ? reportedIn : estimate(promptText);
  const tokensOut = reportedOut > 0 ? reportedOut : estimate(responseText);
  return {
    tokensIn,
    tokensOut,
    estimated: tokensIn !== reportedIn || tokensOut !== reportedOut,
  };
}
