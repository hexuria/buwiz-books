/**
 * Unit tests for runReconciliationAgent's auto-finalize gate.
 *
 * The autonomous agent shares the cleared/uncleared math with the human finalize
 * path (computeFinalizeBalances), so its auto-finalize verdict must apply the SAME
 * blockers the human gate does — otherwise the two paths can disagree:
 *   - unmatched statement lines block finalize (fix #2)
 *   - a bank account with no ledger mapping means the gate can't be computed, so the
 *     agent must decline to auto-finalize rather than finalize ungated (fix #3 parity)
 */
import { describe, it, expect } from "vitest";
import { runReconciliationAgent, type AgentContext } from "../../../src/lib/reconciliation-agent";

function baseContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    suggestions: [],
    unresolvedFlagCount: 0,
    reconId: "recon-1",
    reconStatus: "in_progress",
    netDifference: 0,
    unmatchedStatementLines: 0,
    finalizeGateEvaluable: true,
    autoFinalizeEnabled: true,
    ...overrides,
  };
}

describe("runReconciliationAgent — auto-finalize gate parity with the human finalize gate", () => {
  it("auto-finalizes when the gate is evaluable, no unmatched lines, and the difference is within tolerance", () => {
    const r = runReconciliationAgent(baseContext());
    expect(r.canAutoFinalize).toBe(true);
    expect(r.steps.some((s) => s.action === "finalize")).toBe(true);
  });

  it("does NOT auto-finalize when statement lines remain unmatched (fix #2)", () => {
    const r = runReconciliationAgent(baseContext({ unmatchedStatementLines: 1 }));
    expect(r.canAutoFinalize).toBe(false);
    expect(r.steps.some((s) => s.action === "finalize")).toBe(false);
  });

  it("does NOT auto-finalize when the gate is not evaluable — bank account has no ledger mapping (fix #3 parity)", () => {
    const r = runReconciliationAgent(baseContext({ finalizeGateEvaluable: false }));
    expect(r.canAutoFinalize).toBe(false);
    expect(r.steps.some((s) => s.action === "finalize")).toBe(false);
  });

  it("does NOT auto-finalize when the cleared difference exceeds tolerance", () => {
    const r = runReconciliationAgent(baseContext({ netDifference: 5 }));
    expect(r.canAutoFinalize).toBe(false);
  });

  it("does NOT auto-finalize when auto-finalize is disabled for the org", () => {
    const r = runReconciliationAgent(baseContext({ autoFinalizeEnabled: false }));
    expect(r.canAutoFinalize).toBe(false);
  });

  it("does NOT auto-finalize when unresolved flags remain", () => {
    const r = runReconciliationAgent(baseContext({ unresolvedFlagCount: 2 }));
    expect(r.canAutoFinalize).toBe(false);
  });

  it("does NOT auto-finalize in the same run that auto-applied suggestions (stale-gate guard)", () => {
    // The gate inputs (netDifference/unmatchedStatementLines) are computed BEFORE the
    // apply steps execute. Applying a suggestion mutates match state, so finalizing in
    // the same run would use stale numbers — the agent must defer to a follow-up run.
    const r = runReconciliationAgent(
      baseContext({
        suggestions: [
          {
            id: "s1",
            suggestionType: "auto_match",
            confidence: 99,
            description: "high-confidence match",
            status: "pending",
            statementLineId: "line-1",
            journalLineId: "jl-1",
          },
        ],
      }),
    );
    expect(r.steps.some((s) => s.action === "apply_suggestion")).toBe(true);
    expect(r.canAutoFinalize).toBe(false);
    expect(r.steps.some((s) => s.action === "finalize")).toBe(false);
  });

  it("auto-finalizes on the follow-up run once previously-applied suggestions are no longer pending", () => {
    // Same reconciliation, next run: the suggestion is now status "applied", the caller
    // recomputed the gate against current match state — finalize proceeds.
    const r = runReconciliationAgent(
      baseContext({
        suggestions: [
          {
            id: "s1",
            suggestionType: "auto_match",
            confidence: 99,
            description: "applied last run",
            status: "applied",
            statementLineId: "line-1",
            journalLineId: "jl-1",
          },
        ],
      }),
    );
    expect(r.canAutoFinalize).toBe(true);
    expect(r.steps.some((s) => s.action === "finalize")).toBe(true);
  });

  it("does NOT auto-finalize when a suggestion still needs human review", () => {
    const r = runReconciliationAgent(
      baseContext({
        suggestions: [
          {
            id: "s1",
            suggestionType: "create_txn",
            confidence: 50,
            description: "needs review",
            status: "pending",
          },
        ],
      }),
    );
    expect(r.canAutoFinalize).toBe(false);
  });
});
