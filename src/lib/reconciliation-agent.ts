// ============================================================================
// Reconciliation Agent — Autonomous AI-driven reconciliation orchestrator
// Pure function: receives context → returns execution plan (no side effects)
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/** A single step in the agent's execution plan */
export interface AgentStep {
  action: "apply_suggestion" | "dismiss_suggestion" | "finalize";
  targetId: string; // suggestion ID or reconciliation ID
  reason: string; // human-readable justification
  confidence: number; // copied from suggestion (0 for finalize)
}

/** Result returned by the agent */
export interface AgentResult {
  steps: AgentStep[];
  autoApplied: number;
  escalated: number;
  canAutoFinalize: boolean;
  summary: string;
}

/** Minimal suggestion shape expected by the agent */
export interface AgentSuggestion {
  id: string;
  suggestionType: string;
  confidence: number;
  description: string;
  status: string;
  statementLineId?: string | null;
  journalLineId?: string | null;
}

/** Context required to run the agent */
export interface AgentContext {
  suggestions: AgentSuggestion[];
  unresolvedFlagCount: number;
  reconId: string;
  reconStatus: string;
  /** statement balance − ledger balance (should approach 0) */
  netDifference: number;
  /**
   * Count of this reconciliation's statement lines still unmatched. Mirrors the
   * human finalize gate's blocker — a non-zero count must prevent auto-finalize.
   */
  unmatchedStatementLines: number;
  /**
   * Whether the cleared/uncleared finalize gate could actually be computed (the
   * bank account is mapped to a ledger account). When false, the agent CANNOT
   * verify the reconciliation and must decline to auto-finalize — finalizing
   * ungated would bypass the whole check.
   */
  finalizeGateEvaluable: boolean;
  /** Whether the org has opted into autonomous finalization */
  autoFinalizeEnabled: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Suggestions ≥ this confidence are auto-applied without human review */
const AGENT_AUTO_APPLY_THRESHOLD = 95;

/** Net difference must be within this tolerance ($) for auto-finalize */
const NET_DIFF_TOLERANCE = 0.01;

/** Suggestion types the agent is allowed to auto-apply */
const AUTO_APPLY_TYPES = new Set(["auto_match", "date_fix", "ignore"]);

// ============================================================================
// Main Agent Function
// ============================================================================

/**
 * Run the reconciliation agent.
 *
 * The agent analyzes pending suggestions and produces an ordered list of
 * steps to execute. It does NOT have side effects — the caller is responsible
 * for executing the returned steps.
 *
 * Algorithm:
 * 1. Filter to pending suggestions only
 * 2. Sort by confidence descending
 * 3. Auto-apply: ≥95% confidence + allowed type → apply_suggestion step
 * 4. Dismiss duplicates that reference an already-applied statement line
 * 5. Escalate everything else (leave for human review)
 * 6. Evaluate finalize eligibility
 */
export function runReconciliationAgent(ctx: AgentContext): AgentResult {
  const steps: AgentStep[] = [];
  let autoApplied = 0;
  let escalated = 0;

  // Only operate on pending suggestions
  const pending = ctx.suggestions.filter((s) => s.status === "pending");

  if (pending.length === 0 && ctx.reconStatus === "finalized") {
    return {
      steps: [],
      autoApplied: 0,
      escalated: 0,
      canAutoFinalize: false,
      summary: "No pending suggestions. Reconciliation already finalized.",
    };
  }

  // Sort by confidence descending — process highest-confidence first
  const sorted = [...pending].sort((a, b) => b.confidence - a.confidence);

  // Track which statement lines have been resolved by the agent
  const resolvedStatementLines = new Set<string>();

  // ── Pass 1: Auto-apply high-confidence suggestions ──────────────────────
  for (const suggestion of sorted) {
    const conf = suggestion.confidence;

    if (conf >= AGENT_AUTO_APPLY_THRESHOLD && AUTO_APPLY_TYPES.has(suggestion.suggestionType)) {
      steps.push({
        action: "apply_suggestion",
        targetId: suggestion.id,
        reason: `Auto-applied: ${suggestion.suggestionType} with ${conf}% confidence — ${suggestion.description}`,
        confidence: conf,
      });
      autoApplied++;

      if (suggestion.statementLineId) {
        resolvedStatementLines.add(suggestion.statementLineId);
      }
    }
  }

  // ── Pass 2: Dismiss duplicates overlapping with applied suggestions ─────
  for (const suggestion of sorted) {
    // Skip already-processed suggestions
    if (steps.some((s) => s.targetId === suggestion.id)) continue;

    if (suggestion.suggestionType === "duplicate") {
      // If the related statement line was already resolved, dismiss the duplicate
      if (suggestion.statementLineId && resolvedStatementLines.has(suggestion.statementLineId)) {
        steps.push({
          action: "dismiss_suggestion",
          targetId: suggestion.id,
          reason: `Dismissed: duplicate suggestion — statement line already matched by higher-confidence suggestion`,
          confidence: suggestion.confidence,
        });
        continue;
      }
    }
  }

  // ── Pass 3: Count escalated (remaining unprocessed pending) ─────────────
  for (const suggestion of sorted) {
    if (!steps.some((s) => s.targetId === suggestion.id)) {
      escalated++;
    }
  }

  // ── Pass 4: Evaluate finalize eligibility ───────────────────────────────
  const allResolved = escalated === 0;
  const noFlags = ctx.unresolvedFlagCount === 0;
  const netZero = Math.abs(ctx.netDifference) <= NET_DIFF_TOLERANCE;
  const noUnmatchedStatements = ctx.unmatchedStatementLines === 0;
  const notFinalized = ctx.reconStatus !== "finalized";

  // Do NOT finalize in the same run that changed match state. The gate inputs
  // (netDifference / unmatchedStatementLines) are computed by the caller BEFORE these
  // apply steps run, so finalizing now would use stale, pre-mutation numbers and could
  // finalize an actually-unbalanced reconciliation (the human finalize path recomputes
  // at finalize time). When suggestions were auto-applied, defer finalize to a follow-up
  // run whose gate reflects the now-current match state. Dismissals don't touch match
  // state, so they don't force a deferral.
  const noMatchStateChangesThisRun = autoApplied === 0;

  // Parity with the human finalize gate (finalizeReconciliation): both require the
  // gate to be computable (bank mapped to a ledger account), zero unmatched statement
  // lines, and the cleared difference within tolerance. Missing any of these, the
  // human path throws; the autonomous agent simply declines to auto-finalize.
  const canAutoFinalize =
    ctx.autoFinalizeEnabled &&
    ctx.finalizeGateEvaluable &&
    allResolved &&
    noFlags &&
    noUnmatchedStatements &&
    noMatchStateChangesThisRun &&
    netZero &&
    notFinalized;

  if (canAutoFinalize) {
    steps.push({
      action: "finalize",
      targetId: ctx.reconId,
      reason: `Auto-finalized: all suggestions resolved, zero flags, net difference $${Math.abs(ctx.netDifference).toFixed(2)}`,
      confidence: 0,
    });
  }

  // ── Build summary ──────────────────────────────────────────────────────
  const parts: string[] = [];

  if (autoApplied > 0) {
    parts.push(`${autoApplied} suggestion${autoApplied > 1 ? "s" : ""} auto-applied`);
  }
  if (escalated > 0) {
    parts.push(
      `${escalated} item${escalated > 1 ? "s" : ""} need${escalated === 1 ? "s" : ""} review`,
    );
  }
  if (canAutoFinalize) {
    parts.push("reconciliation auto-finalized");
  } else if (ctx.autoFinalizeEnabled && autoApplied > 0 && escalated === 0 && notFinalized) {
    // Finalize was deferred only because this run changed match state (stale-gate
    // guard) — tell the user a re-run will evaluate it against fresh numbers.
    parts.push("run the agent again to evaluate finalization with the updated matches");
  }
  if (parts.length === 0) {
    parts.push("No actionable suggestions found");
  }

  const summary = parts.join(", ") + ".";

  return {
    steps,
    autoApplied,
    escalated,
    canAutoFinalize,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
  };
}
