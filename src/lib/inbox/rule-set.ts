/**
 * Rule sets — what a candidate's book rules are evaluated against (Inbox v2 §6).
 *
 * Pure: no database, no clock. The candidate path, the snapshot builder, the
 * replay, and the scorecard all go through these functions, so a snapshot of
 * the live configuration evaluates exactly like the live configuration does.
 *
 * A rule set is either the organization's LIVE `review_rule_configs` or an
 * immutable SNAPSHOT pinned by the routine a paper came through. Either way it
 * is reduced to the same two inputs:
 *
 *   - `configByKey`: per rule key, the `enabled` flag, `impact`, and `config`
 *     the evaluator reads. A rule with no entry is enabled with the
 *     evaluator's own impact — exactly how the live path treats an
 *     organization that never saved a config row.
 *   - `fallbacks`: the organization's accounting-settings thresholds, used only
 *     when a config carries no threshold. Snapshots bake these in at creation,
 *     so a snapshot never drifts when the settings change later.
 */
import { z } from "zod";
import type { RuleSnapshotEntry, RuleSnapshotImpact } from "@/db/schema/rule-snapshots";
import { normalizeCurrency } from "./money";
import {
  evaluateBookRules,
  type BookRuleAccount,
  type BookRuleDocument,
  type BookRuleParty,
} from "./rules";
import type { CandidateLineInput, CreateCandidateInput, ReviewFindingDraft } from "./types";

export type { RuleSnapshotEntry, RuleSnapshotImpact };

/** The stored shape of one snapshot entry; validated on every read. */
export const ruleSnapshotEntrySchema = z.object({
  ruleKey: z.string().min(1).max(64),
  enabled: z.boolean(),
  impact: z.enum(["blocking", "warning"]),
  config: z.record(z.string(), z.unknown()),
  formulaVersion: z.number().int().positive(),
});
export const ruleSnapshotEntriesSchema = z
  .array(ruleSnapshotEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.ruleKey)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate rule ${entry.ruleKey}.`,
          path: [index, "ruleKey"],
        });
      }
      seen.add(entry.ruleKey);
    }
  });

/** Which rules evaluated a candidate. Recorded on every finding they produce. */
export interface RuleSetProvenance {
  source: "live" | "snapshot";
  /** The pinned (or shadowed) snapshot; null for live. */
  snapshotId: string | null;
  /** The routine the paper came through; null for papers no routine brought in. */
  routineId: string | null;
}

export interface RuleConfigView {
  enabled: boolean;
  impact: string;
  config: Record<string, unknown>;
}

/** Accounting-settings thresholds the live path falls back to. */
export interface BookRuleFallbacks {
  lowConfidenceThreshold: string;
  missingReceiptThreshold: string;
  missingReceiptCurrency: string;
}

/**
 * `organization_accounting_settings` column defaults, rendered the way
 * Postgres returns them (decimal(5,4) and decimal(20,8)). Used where there is
 * no organization to read — the hermetic scorecard.
 */
export const DEFAULT_BOOK_RULE_FALLBACKS: BookRuleFallbacks = {
  lowConfidenceThreshold: "0.8000",
  missingReceiptThreshold: "75.00000000",
  missingReceiptCurrency: "USD",
};

export interface AppliedRuleSet {
  provenance: RuleSetProvenance;
  configByKey: ReadonlyMap<string, RuleConfigView>;
  fallbacks: BookRuleFallbacks;
}

export interface CandidateRuleInput {
  candidate: CreateCandidateInput;
  lines: CandidateLineInput[];
  accounts: Map<string, BookRuleAccount>;
  party: BookRuleParty | null;
  documents: BookRuleDocument[];
  functionalCurrency: string;
}

/**
 * The candidate path's book-rule evaluation under one rule set.
 *
 * This is the body the live path always ran (service.ts and
 * candidate-correction.ts each carried a copy): thresholds from the config,
 * falling back to accounting settings; findings of a disabled rule dropped;
 * a configured impact replacing the evaluator's default.
 */
export function evaluateCandidateRules(
  ruleSet: Pick<AppliedRuleSet, "configByKey" | "fallbacks">,
  input: CandidateRuleInput,
): ReviewFindingDraft[] {
  const { configByKey, fallbacks } = ruleSet;
  const lowConfidenceConfig = configByKey.get("low_confidence_category")?.config as
    | { threshold?: number | string | null }
    | undefined;
  const receiptConfig = configByKey.get("missing_receipt")?.config as
    | { threshold?: number | string | null; currency?: string | null }
    | undefined;
  return evaluateBookRules({
    candidate: input.candidate,
    lines: input.lines,
    accounts: input.accounts,
    party: input.party,
    documents: input.documents,
    settings: {
      lowConfidenceThreshold: String(
        lowConfidenceConfig?.threshold ?? fallbacks.lowConfidenceThreshold,
      ),
      missingReceiptThreshold: String(
        receiptConfig?.threshold ?? fallbacks.missingReceiptThreshold,
      ),
      missingReceiptCurrency: normalizeCurrency(
        receiptConfig?.currency ?? fallbacks.missingReceiptCurrency,
      ),
      functionalCurrency: input.functionalCurrency,
    },
  })
    .filter((finding) => configByKey.get(finding.ruleKey)?.enabled !== false)
    .map((finding) => ({
      ...finding,
      impact:
        (configByKey.get(finding.ruleKey)?.impact as "blocking" | "warning" | undefined) ??
        finding.impact,
    }));
}

/** Stamp the rule set onto each finding's evidence, so every finding says what raised it. */
export function withRuleSetProvenance(
  findings: ReviewFindingDraft[],
  provenance: RuleSetProvenance,
): ReviewFindingDraft[] {
  return findings.map((finding) => ({
    ...finding,
    evidence: { ...finding.evidence, ruleSet: { ...provenance } },
  }));
}

export function ruleConfigMapFromEntries(
  entries: readonly RuleSnapshotEntry[],
): Map<string, RuleConfigView> {
  return new Map(
    entries.map((entry) => [
      entry.ruleKey,
      { enabled: entry.enabled, impact: entry.impact, config: entry.config },
    ]),
  );
}

export interface RuleDefinitionInput {
  key: string;
  group: string;
  defaultConfig: Record<string, unknown>;
  formulaVersion: number;
}

export interface RuleConfigInput {
  key: string;
  enabled: boolean;
  impact: string;
  config: Record<string, unknown>;
}

/** The impact the system writes when it materializes a missing config row. */
export function defaultImpactForGroup(group: string): RuleSnapshotImpact {
  return group === "review" ? "warning" : "blocking";
}

function bakeBookThresholds(
  key: string,
  config: Record<string, unknown>,
  fallbacks: BookRuleFallbacks,
): Record<string, unknown> {
  if (key === "low_confidence_category") {
    return { ...config, threshold: config.threshold ?? fallbacks.lowConfidenceThreshold };
  }
  if (key === "missing_receipt") {
    return {
      ...config,
      threshold: config.threshold ?? fallbacks.missingReceiptThreshold,
      currency: config.currency ?? fallbacks.missingReceiptCurrency,
    };
  }
  return { ...config };
}

/**
 * Freeze a rule configuration into snapshot entries.
 *
 * One entry per configurable (non-system) definition, sorted by key. Each
 * entry carries what that rule's evaluator effectively reads:
 *
 *   - book rules: the saved config with the accounting-settings thresholds
 *     baked in — the candidate path never merged `default_config` for these,
 *     and neither does this, so a snapshot's messages match live exactly;
 *   - `possible_duplicate` and the review rules: `default_config` overlaid by
 *     the saved config, the merge their engines perform.
 *
 * A rule without a saved row is enabled with its group's default impact, the
 * same default the review engine writes when it materializes the row.
 */
export function buildEffectiveRuleEntries(input: {
  definitions: readonly RuleDefinitionInput[];
  configs: readonly RuleConfigInput[];
  fallbacks: BookRuleFallbacks;
}): RuleSnapshotEntry[] {
  const configByKey = new Map(input.configs.map((config) => [config.key, config]));
  return (
    input.definitions
      .filter((definition) => definition.group !== "system")
      .map((definition) => {
        const saved = configByKey.get(definition.key);
        const savedConfig = saved?.config ?? {};
        const config =
          definition.group === "book" && definition.key !== "possible_duplicate"
            ? bakeBookThresholds(definition.key, savedConfig, input.fallbacks)
            : { ...definition.defaultConfig, ...savedConfig };
        const impact: RuleSnapshotImpact =
          saved?.impact === "blocking" || saved?.impact === "warning"
            ? saved.impact
            : defaultImpactForGroup(definition.group);
        return {
          ruleKey: definition.key,
          enabled: saved?.enabled ?? true,
          impact,
          config,
          formulaVersion: definition.formulaVersion,
        };
      })
      // Code-point order, not localeCompare: a snapshot must serialize the same
      // on every machine that builds it.
      .sort((left, right) =>
        left.ruleKey < right.ruleKey ? -1 : left.ruleKey > right.ruleKey ? 1 : 0,
      )
  );
}
