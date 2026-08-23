// ============================================================================
// LLM match-suggestion persistence — THE choke point.
//
// Wall 4 of the finance-only restriction (AI_NATIVE_ARCHITECTURE §2, §7):
// model output must never auto-link ledger entries. Every LLM-sourced
// reconciliation suggestion is written through this module, and its
// confidence is structurally capped at LLM_SUGGESTION_MAX_CONFIDENCE (84) —
// strictly below auto-matcher's AUTO_MATCH_THRESHOLD (85). The cap is a code
// invariant, not a configuration value: no org setting, routing change, or
// autonomy level can raise it.
//
// Also enforced here:
//  • grounding — only journalLineIds from the caller-supplied candidate set
//    survive (hallucinated IDs degrade the decision to "none")
//  • money math in TypeScript — split allocations must sum to the statement
//    line amount exactly, recomputed here, never trusted from the model
//  • dismissal memory — a fingerprint matching a dismissed suggestion is
//    never re-created
// ============================================================================

import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { reconciliationSuggestions } from "../../db/schema/reconciliations";
import { toMatcherConfidence } from "../ai/confidence";
import type { MatchDecision } from "../ai/schemas/match-assist";

/**
 * Hard ceiling for any model-sourced match suggestion, on the matcher's
 * 0–100 scale. MUST stay below auto-matcher's AUTO_MATCH_THRESHOLD (85).
 */
export const LLM_SUGGESTION_MAX_CONFIDENCE = 84;

/** Cents-based equality so float noise can't pass a split allocation. */
function centsEqual(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

export interface StatementLineRef {
  id: string;
  amount: string | number;
  description: string;
}

export interface PersistMatchSuggestionsInput {
  orgId: string;
  reconciliationId: string;
  /** Decisions returned by the match_assist task. */
  decisions: MatchDecision[];
  /** Statement lines the decisions may reference, by id. */
  statementLines: Map<string, StatementLineRef>;
  /** Allowed candidate journal line IDs per statement line (grounding set). */
  candidatesByLine: Map<string, Set<string>>;
}

export interface PersistMatchSuggestionsResult {
  inserted: number;
  /** Decisions dropped, with why — surfaced in the run's step outputRef. */
  rejected: Array<{ statementLineId: string; reason: string }>;
}

/** Stable fingerprint for dismissal memory. */
export function suggestionFingerprint(
  statementLineId: string,
  journalLineIds: string[],
  suggestionType: string,
): string {
  return `${statementLineId}|${[...journalLineIds].sort().join(",")}|${suggestionType}`;
}

/**
 * Validate, ground, cap, and insert LLM match decisions as pending
 * reconciliation suggestions. Nothing model-sourced reaches
 * reconciliation_suggestions except through this function.
 */
export async function persistLlmMatchSuggestions(
  db: DbExecutor,
  input: PersistMatchSuggestionsInput,
): Promise<PersistMatchSuggestionsResult> {
  const rejected: PersistMatchSuggestionsResult["rejected"] = [];

  // Dismissal memory: never re-suggest something a human already dismissed.
  const dismissed = await db
    .select({
      statementLineId: reconciliationSuggestions.statementLineId,
      journalLineId: reconciliationSuggestions.journalLineId,
      suggestionType: reconciliationSuggestions.suggestionType,
      proposedChanges: reconciliationSuggestions.proposedChanges,
    })
    .from(reconciliationSuggestions)
    .where(
      and(
        eq(reconciliationSuggestions.organizationId, input.orgId),
        eq(reconciliationSuggestions.reconciliationId, input.reconciliationId),
        inArray(reconciliationSuggestions.status, ["dismissed"]),
      ),
    );

  const dismissedFingerprints = new Set(
    dismissed.map((row) => {
      // Splits record their full ID set in proposedChanges; 1:1 rows use the column.
      const splitParts = (
        row.proposedChanges as
          | { split?: { to?: { parts?: Array<{ journalLineId: string }> } } }
          | null
          | undefined
      )?.split?.to?.parts;
      const ids = splitParts
        ? splitParts.map((p) => p.journalLineId)
        : row.journalLineId
          ? [row.journalLineId]
          : [];
      return suggestionFingerprint(row.statementLineId ?? "", ids, row.suggestionType);
    }),
  );

  const rows: Array<typeof reconciliationSuggestions.$inferInsert> = [];

  for (const decision of input.decisions) {
    const line = input.statementLines.get(decision.statementLineId);
    if (!line) {
      rejected.push({
        statementLineId: decision.statementLineId,
        reason: "unknown statement line (not in the supplied block)",
      });
      continue;
    }
    if (decision.decision === "none") continue;

    // Grounding: drop hallucinated candidate IDs.
    const allowed = input.candidatesByLine.get(decision.statementLineId) ?? new Set<string>();
    const groundedIds = decision.journalLineIds.filter((id) => allowed.has(id));
    if (groundedIds.length !== decision.journalLineIds.length) {
      rejected.push({
        statementLineId: decision.statementLineId,
        reason: "referenced ledger line(s) outside the candidate set",
      });
      continue;
    }
    if (groundedIds.length === 0) {
      rejected.push({
        statementLineId: decision.statementLineId,
        reason: "no grounded candidates",
      });
      continue;
    }

    // Confidence: normalize to the matcher domain, then apply the hard cap.
    // AI_NATIVE_ARCHITECTURE §2 wall 4 — never configurable.
    const confidence = Math.min(
      // The match-assist schema pins confidence to 0-1, so 1 means 100%.
      toMatcherConfidence(decision.confidence, { scaleHint: "unit" }),
      LLM_SUGGESTION_MAX_CONFIDENCE,
    );

    if (decision.decision === "match") {
      if (groundedIds.length !== 1) {
        rejected.push({
          statementLineId: decision.statementLineId,
          reason: "match decision must reference exactly one ledger line",
        });
        continue;
      }
      const fingerprint = suggestionFingerprint(line.id, groundedIds, "auto_match");
      if (dismissedFingerprints.has(fingerprint)) continue;

      rows.push({
        organizationId: input.orgId,
        reconciliationId: input.reconciliationId,
        statementLineId: line.id,
        journalLineId: groundedIds[0],
        suggestionType: "auto_match",
        confidence: String(confidence),
        description: decision.reason || `AI match for "${line.description}"`,
        status: "pending",
      });
      continue;
    }

    // decision.decision === "split"
    const allocations = decision.allocations ?? [];
    if (allocations.length < 2) {
      rejected.push({
        statementLineId: decision.statementLineId,
        reason: "split decision needs at least two allocations",
      });
      continue;
    }
    if (allocations.some((a) => !allowed.has(a.journalLineId))) {
      rejected.push({
        statementLineId: decision.statementLineId,
        reason: "split allocation references a ledger line outside the candidate set",
      });
      continue;
    }
    // Money math recomputed in TypeScript — the model's arithmetic is never trusted.
    const allocationTotal = allocations.reduce((sum, a) => sum + a.amount, 0);
    const lineAmount = typeof line.amount === "string" ? Number(line.amount) : line.amount;
    if (!Number.isFinite(lineAmount) || !centsEqual(allocationTotal, lineAmount)) {
      rejected.push({
        statementLineId: decision.statementLineId,
        reason: `split allocations sum to ${allocationTotal} but the line is ${lineAmount}`,
      });
      continue;
    }

    const splitIds = allocations.map((a) => a.journalLineId);
    const fingerprint = suggestionFingerprint(line.id, splitIds, "split");
    if (dismissedFingerprints.has(fingerprint)) continue;

    rows.push({
      organizationId: input.orgId,
      reconciliationId: input.reconciliationId,
      statementLineId: line.id,
      // 1:1 column stays null for splits — the parts live in proposedChanges.
      journalLineId: null,
      suggestionType: "split",
      confidence: String(confidence),
      description: decision.reason || `AI split match across ${allocations.length} transactions`,
      proposedChanges: {
        split: {
          from: null,
          to: {
            statementLineId: line.id,
            parts: allocations.map((a) => ({
              journalLineId: a.journalLineId,
              allocatedAmount: a.amount.toFixed(2),
            })),
          },
        },
      },
      status: "pending",
    });
  }

  if (rows.length > 0) {
    await db.insert(reconciliationSuggestions).values(rows);
  }

  return { inserted: rows.length, rejected };
}
