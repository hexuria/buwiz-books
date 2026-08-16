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
export function normalizeConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(scaled, 1);
}

/**
 * Convert a 0–1 confidence into the matcher's 0–100 domain.
 * NOTE: the 84 cap for LLM-sourced match suggestions is applied at the single
 * persistence choke point (see AI_NATIVE_ARCHITECTURE.md §2 wall 4), not here —
 * this is a pure scale conversion.
 */
export function toMatcherConfidence(c01: number): number {
  return Math.round(normalizeConfidence(c01) * 100);
}
