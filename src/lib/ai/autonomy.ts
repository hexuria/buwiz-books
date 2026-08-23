// ============================================================================
// Earned autonomy (AI_NATIVE_ARCHITECTURE §2).
//
// Every org starts at "suggest" for every task. Auto-apply is EARNED from
// that org's own accuracy history — never granted by default, never inferred
// from another org's data — and every widening is an explicit admin action.
//
// Two walls stand outside this system entirely:
//   • STRUCTURAL_MANUAL_KINDS can never be auto-applied, at any accuracy.
//   • LLM match suggestions are capped at confidence 84 in code
//     (src/lib/match-assist/persist.ts), below the 85 auto-link threshold.
// Together they mean no configuration change can ever let a model link
// ledger entries by itself.
// ============================================================================

import { and, count, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { aiActionProposals, aiRunFeedback, type AiProposalKind } from "../../db/schema/ai";

/**
 * Kinds that stay human-applied regardless of settings or accuracy.
 *
 * `coa_accounts` is here because the chart is the coordinate system every
 * later number is expressed in: an account created by itself silently becomes
 * a posting destination, a report line, and a mapping candidate, and no
 * accuracy history over OTHER charts says anything about this one.
 * `category_mapping` is deliberately NOT here — it only re-points a default
 * among accounts that already exist, is type-checked on both write and read,
 * and is trivially reversible.
 */
export const STRUCTURAL_MANUAL_KINDS: ReadonlySet<AiProposalKind> = new Set<AiProposalKind>([
  "match",
  "split",
  "coa_accounts",
  // Audit PR-19 — added while autonomy has NO production callers, which is
  // exactly when widening the wall is free:
  // `create_party` mints counterparties (the identity ledger rows hang off);
  // `date_fix` moves a transaction across period and aging boundaries;
  // `categorize` re-points P&L lines. All three stay human-applied at any
  // accuracy; the two-key appliers still gate WHO may apply them.
  "create_party",
  "date_fix",
  "categorize",
]);

/** Graduation criteria — deliberately strict; this widens write authority. */
export const AUTONOMY_CRITERIA = {
  minProposals: 200,
  minAcceptanceRate: 0.98,
  /** Auto-demote below this over the trailing window. */
  demotionRate: 0.95,
  demotionWindow: 50,
};

export interface AutonomyEligibility {
  eligible: boolean;
  total: number;
  accepted: number;
  acceptanceRate: number;
  /** How many more accepted proposals are needed, when short on volume. */
  remaining: number;
  reason: string;
}

/**
 * Compute whether an org has earned auto-apply for a task, from ITS OWN
 * feedback history. Computed on demand (settings load, and re-verified at
 * the moment of the flip) — never by a background job that could widen
 * authority without a human in the loop.
 */
export async function computeAutonomyEligibility(
  db: DbExecutor,
  orgId: string,
  kind: AiProposalKind,
): Promise<AutonomyEligibility> {
  if (STRUCTURAL_MANUAL_KINDS.has(kind)) {
    return {
      eligible: false,
      total: 0,
      accepted: 0,
      acceptanceRate: 0,
      remaining: 0,
      reason: `"${kind}" is always applied by a human — it can never be automated.`,
    };
  }

  const [row] = await db
    .select({
      total: count(),
      accepted: sql<number>`count(*) filter (where ${aiRunFeedback.verdict} = 'accepted')`,
    })
    .from(aiRunFeedback)
    .innerJoin(aiActionProposals, eq(aiRunFeedback.proposalId, aiActionProposals.id))
    .where(and(eq(aiRunFeedback.organizationId, orgId), eq(aiActionProposals.kind, kind)));

  const total = Number(row?.total ?? 0);
  const accepted = Number(row?.accepted ?? 0);
  const acceptanceRate = total > 0 ? accepted / total : 0;

  if (total < AUTONOMY_CRITERIA.minProposals) {
    return {
      eligible: false,
      total,
      accepted,
      acceptanceRate,
      remaining: AUTONOMY_CRITERIA.minProposals - total,
      reason: `Needs ${AUTONOMY_CRITERIA.minProposals - total} more reviewed proposals (${total}/${AUTONOMY_CRITERIA.minProposals}).`,
    };
  }

  if (acceptanceRate < AUTONOMY_CRITERIA.minAcceptanceRate) {
    return {
      eligible: false,
      total,
      accepted,
      acceptanceRate,
      remaining: 0,
      reason: `Acceptance rate ${(acceptanceRate * 100).toFixed(1)}% is below the required ${(AUTONOMY_CRITERIA.minAcceptanceRate * 100).toFixed(0)}%.`,
    };
  }

  return {
    eligible: true,
    total,
    accepted,
    acceptanceRate,
    remaining: 0,
    reason: `Eligible: ${(acceptanceRate * 100).toFixed(1)}% accepted across ${total} proposals.`,
  };
}

/**
 * Trailing-window check used to AUTO-DEMOTE a task back to "suggest" when
 * quality slips. Demotion is automatic because it narrows authority;
 * promotion never is.
 */
export async function shouldDemote(
  db: DbExecutor,
  orgId: string,
  kind: AiProposalKind,
): Promise<boolean> {
  const recent = await db
    .select({ verdict: aiRunFeedback.verdict })
    .from(aiRunFeedback)
    .innerJoin(aiActionProposals, eq(aiRunFeedback.proposalId, aiActionProposals.id))
    .where(and(eq(aiRunFeedback.organizationId, orgId), eq(aiActionProposals.kind, kind)))
    .orderBy(sql`${aiRunFeedback.createdAt} DESC`)
    .limit(AUTONOMY_CRITERIA.demotionWindow);

  if (recent.length < AUTONOMY_CRITERIA.demotionWindow) return false;
  const accepted = recent.filter((r) => r.verdict === "accepted").length;
  return accepted / recent.length < AUTONOMY_CRITERIA.demotionRate;
}

/**
 * Decide whether a freshly-created proposal may auto-apply.
 * Requires: the kind is not structurally manual, the org has flipped it on,
 * and the proposal clears the org's confidence threshold.
 */
export function canAutoApply(input: {
  kind: AiProposalKind;
  autonomy: Record<string, string>;
  confidence: number | null;
  threshold: number | null;
}): boolean {
  if (STRUCTURAL_MANUAL_KINDS.has(input.kind)) return false;
  if (input.autonomy[input.kind] !== "auto_apply_high_confidence") return false;
  if (input.confidence == null) return false;
  const threshold = input.threshold ?? 0.9;
  return input.confidence >= threshold;
}
