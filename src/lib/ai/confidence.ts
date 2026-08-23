// ============================================================================
// Confidence scale conversions
//
// Two scales coexist in the app on purpose:
//  • AI boundary — 0–1. New AI storage (ai_action_proposals etc.) records 0–1.
//  • Reconciliation/matcher domain — 0–100 (auto-matcher thresholds, the
//    statement/suggestion columns). Untouched: changing those columns is churn
//    with no payoff, and AUTO_MATCH_THRESHOLD=85 / the 84 LLM cap live there.
//
// Existing response payloads keep whatever scale their clients already read
// (e.g. statement classification confidence stays 0–100 on the wire).
// These helpers are the only sanctioned converters between the two.
// ============================================================================

/**
 * Normalize a model-reported confidence to 0–1.
 * Models return either 0–1 or 0–100 regardless of prompt instructions;
 * anything > 1 is treated as a percentage. Non-numeric input becomes 0.
 */
export interface NormalizeConfidenceOptions {
  /**
   * "unit": the caller's prompt/schema pins the scale to 0-1, so a bare 1
   * unambiguously means full confidence. Only pass this where that contract
   * actually exists — the default treats 1 as ambiguous.
   */
  scaleHint?: "unit" | "unknown";
}

export function normalizeConfidence(
  raw: unknown,
  options: NormalizeConfidenceOptions = {},
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // A bare 1 is genuinely ambiguous at an unpinned boundary: it reads as
  // 100% on the 0-1 scale and as 1% on the 0-100 scale. It used to resolve
  // to 100% — the WORST reading, since a 1%-confident percentage answer
  // sailed over every auto-apply threshold. Ambiguity now resolves LOW
  // (audit PR-19) unless the caller's schema pins the unit scale.
  if (n === 1 && options.scaleHint !== "unit") return 0.01;
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(scaled, 1);
}

/**
 * Convert a 0–1 confidence into the matcher's 0–100 domain.
 * NOTE: the 84 cap for LLM-sourced match suggestions is applied at the single
 * persistence choke point (see AI_NATIVE_ARCHITECTURE.md §2 wall 4), not here —
 * this is a pure scale conversion.
 */
export function toMatcherConfidence(c01: number, options: NormalizeConfidenceOptions = {}): number {
  return Math.round(normalizeConfidence(c01, options) * 100);
}
