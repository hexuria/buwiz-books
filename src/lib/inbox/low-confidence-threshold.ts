// ============================================================================
// The org's low-confidence threshold, as the book rules read it: the
// `low_confidence_category` rule config first, then the accounting settings
// column, then the catalog default. Stage 2 and entity matching apply a model
// pick only at or above it — below, the pick is kept as a hint and a human
// decides.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import {
  organizationAccountingSettings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
} from "@/db/schema/inbox";
import type { AppliedRuleSet } from "./rule-set";

export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.8;

/**
 * The same threshold read from a resolved rule set — the live configs, or the
 * snapshot a routine pins — so a routine's papers are classified with the
 * threshold their own rules will then enforce. Same precedence as below: the
 * rule's config, then the accounting settings, then the catalog default.
 */
export function lowConfidenceThresholdOf(
  ruleSet: Pick<AppliedRuleSet, "configByKey" | "fallbacks">,
): number {
  const configured = ruleSet.configByKey.get("low_confidence_category")?.config as
    | { threshold?: unknown }
    | undefined;
  const fromRule = Number(configured?.threshold);
  if (Number.isFinite(fromRule) && fromRule > 0) return fromRule;
  const fromSettings = Number(ruleSet.fallbacks.lowConfidenceThreshold);
  return Number.isFinite(fromSettings) && fromSettings > 0
    ? fromSettings
    : DEFAULT_LOW_CONFIDENCE_THRESHOLD;
}

export async function loadLowConfidenceThreshold(db: DbExecutor, orgId: string): Promise<number> {
  const [configured] = await db
    .select({ config: reviewRuleConfigs.config })
    .from(reviewRuleConfigs)
    .innerJoin(reviewRuleDefinitions, eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id))
    .where(
      and(
        eq(reviewRuleConfigs.organizationId, orgId),
        eq(reviewRuleDefinitions.key, "low_confidence_category"),
      ),
    )
    .limit(1);
  const fromRule = Number((configured?.config as { threshold?: unknown } | undefined)?.threshold);
  if (Number.isFinite(fromRule) && fromRule > 0) return fromRule;
  const [settings] = await db
    .select({ threshold: organizationAccountingSettings.lowConfidenceThreshold })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  const fromSettings = Number(settings?.threshold);
  return Number.isFinite(fromSettings) && fromSettings > 0
    ? fromSettings
    : DEFAULT_LOW_CONFIDENCE_THRESHOLD;
}
