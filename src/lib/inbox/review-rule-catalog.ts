// NOTE: this module is one of the few `src/lib` files COPY'd into the runtime image so
// `scripts/seed-review-rules.ts` can run during deploy. That image carries tsconfig.json and
// `src/db` but not the rest of `src/`. The `@/` alias was verified to resolve in that trimmed
// layout — but keep the import surface here minimal, and re-check if the Dockerfile's COPY list
// or the tsconfig `paths` mapping changes.
import { reviewRuleDefinitions } from "@/db/schema/inbox";
import type { DbExecutor } from "@/db";

/**
 * The review-rule catalog: the single source of truth for `review_rule_definitions`.
 *
 * `review_rule_definitions` is a GLOBAL table — no `organization_id`, deliberately excluded
 * from every RLS policy list. Its rows were historically inserted only by the raw SQL in
 * drizzle/0019_inbox_review_foundation.sql, which `drizzle-kit` never runs (0019 is not in
 * drizzle/meta/_journal.json) and which only the since-removed `db:dedup:migrate` applied.
 * Every other path — `db:fresh`, `make migrate`, CI deploy — created the table empty, so
 * `/review-agents` rendered "No review agents are configured." on a healthy database.
 *
 * This module is what the seeder, the engine, and the server functions all read.
 *
 * TWO INVARIANTS, both load-bearing:
 *
 * 1. `possible_duplicate` is the POST-0020 row. drizzle/0020_transaction_deduplication.sql
 *    overwrote 0019's `{"matchWindowDays":3}` / v1 row with the shape below and bumped
 *    `formula_version` to 2. `loadDuplicateEngineConfig` reads `default_config` for mode and
 *    scores, so seeding 0019's older shape would silently retune duplicate blocking for every
 *    tenant.
 *
 * 2. The seeder is ON CONFLICT DO NOTHING and must stay that way. A DO UPDATE would let an
 *    edit to this file change every tenant's materiality thresholds and formula versions at
 *    deploy time, with no config version bump and no audit row. Changing an existing
 *    definition is a reviewed numbered migration — that is exactly what 0020 is.
 */

export type ReviewRuleGroup = "book" | "review" | "system";

export interface ReviewRuleSeed {
  /** `review_rule_definitions.key` — varchar(64), unique. */
  key: string;
  /** varchar(120). */
  name: string;
  /** varchar(16). */
  group: ReviewRuleGroup;
  /** varchar(64). Equals `key` for every row the engine dispatches on. */
  evaluatorKey: string;
  formulaVersion: number;
  defaultConfig: Record<string, string | number | boolean>;
  /**
   * One-sentence explanation of what the rule flags, served by `listReviewAgents`.
   *
   * Deliberately NOT a database column: the seeder is DO NOTHING, so a stored copy would be
   * written once and then drift permanently as this file changed — the exact problem this
   * module exists to remove.
   */
  description: string;
}

export const REVIEW_RULE_CATALOG: readonly ReviewRuleSeed[] = [
  // ── Book: evaluated automatically at ingest and on correction (src/lib/inbox/rules.ts).
  {
    key: "uncategorized",
    name: "Uncategorized",
    group: "book",
    evaluatorKey: "uncategorized",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag transactions with uncategorized categories.",
  },
  {
    key: "low_confidence_category",
    name: "Low Confidence Category",
    group: "book",
    evaluatorKey: "low_confidence_category",
    formulaVersion: 1,
    defaultConfig: { threshold: 0.8 },
    description: "Flag transactions with low-confidence category classifications.",
  },
  {
    key: "missing_vendor",
    name: "Missing Vendor",
    group: "book",
    evaluatorKey: "missing_vendor",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag expense transactions with no assigned vendor.",
  },
  {
    key: "missing_customer",
    name: "Missing Customer",
    group: "book",
    evaluatorKey: "missing_customer",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag income transactions with no assigned customer.",
  },
  {
    key: "missing_receipt",
    name: "Missing Receipt",
    group: "book",
    evaluatorKey: "missing_receipt",
    formulaVersion: 1,
    defaultConfig: { threshold: 75, currency: "USD" },
    description: "Flag expense transactions over the configured threshold with no receipt.",
  },
  {
    key: "missing_invoice",
    name: "Missing Invoice",
    group: "book",
    evaluatorKey: "missing_invoice",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag Accounts Payable credits with no attached invoice.",
  },
  {
    key: "missing_department",
    name: "Missing Department",
    group: "book",
    evaluatorKey: "missing_department",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag transactions with no assigned department.",
  },
  {
    key: "missing_location",
    name: "Missing Location",
    group: "book",
    evaluatorKey: "missing_location",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag transactions with no assigned location.",
  },
  {
    // Post-0020 shape. See invariant 1 above — do not revert to 0019's row.
    key: "possible_duplicate",
    name: "Possible Duplicate",
    group: "book",
    evaluatorKey: "possible_duplicate",
    formulaVersion: 2,
    defaultConfig: {
      mode: "enforce",
      matchWindowDays: 3,
      blockingScore: 70,
      shadowScore: 50,
      algorithmVersion: 1,
    },
    description: "Flag similar cross-source transactions for duplicate review.",
  },

  // ── Review: evaluated on demand against the posted ledger (src/lib/inbox/review-engine.ts).
  {
    key: "unusual_spend",
    name: "Unusual Spend",
    group: "review",
    evaluatorKey: "unusual_spend",
    formulaVersion: 1,
    defaultConfig: { standardDeviations: 3 },
    description:
      "Flag expense categories more than the configured number of standard deviations above recent monthly spend.",
  },
  {
    key: "non_zero_clearing",
    name: "Non Zero Clearing",
    group: "review",
    evaluatorKey: "non_zero_clearing",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag each month a clearing account balance was non-zero.",
  },
  {
    key: "material_expense",
    name: "Material Expense",
    group: "review",
    evaluatorKey: "material_expense",
    formulaVersion: 1,
    defaultConfig: { annualizedExpensePercent: 1 },
    description:
      "Flag expense transactions above the configured share of annualized recent expenses, excluding payroll.",
  },
  {
    key: "material_asset",
    name: "Material Asset",
    group: "review",
    evaluatorKey: "material_asset",
    formulaVersion: 1,
    defaultConfig: { totalAssetPercent: 0.5 },
    description:
      "Flag investment asset transactions above the configured share of average recent total assets.",
  },
  {
    key: "transaction_in_parent_category",
    name: "Transaction In Parent Category",
    group: "review",
    evaluatorKey: "transaction_in_parent_category",
    formulaVersion: 1,
    defaultConfig: {},
    description: "Flag transactions posted to a parent rather than leaf category.",
  },

  // ── System: raised by background handlers with a hardcoded blocking impact. They read no
  // config and are not runnable, so they are surfaced read-only rather than configurable.
  // Registering them here is what makes them visible at all — they block approval and period
  // close today while appearing nowhere in the UI.
  {
    key: "source_processing_failed",
    name: "Source Processing Failed",
    group: "system",
    evaluatorKey: "source_processing_failed",
    formulaVersion: 1,
    defaultConfig: {},
    description:
      "Raised when inbound processing fails after every retry. Retry the source or document an exception.",
  },
  {
    key: "source_evidence_incomplete",
    name: "Source Evidence Incomplete",
    group: "system",
    evaluatorKey: "source_evidence_incomplete",
    formulaVersion: 1,
    defaultConfig: {},
    description:
      "Raised when an inbound email arrives without the attachments needed to book it. Supply the missing evidence or document an exception.",
  },
];

export const REVIEW_RULE_BY_KEY: ReadonlyMap<string, ReviewRuleSeed> = new Map(
  REVIEW_RULE_CATALOG.map((rule) => [rule.key, rule]),
);

/**
 * The rules the on-demand run evaluates.
 *
 * Book rules already run automatically at ingest and on correction, against the transaction
 * candidate — the only point at which they can still be acted on. Re-running them over posted
 * journals produced blocking findings against entries that can no longer be un-posted, with no
 * resolution path and a period close that then never advanced.
 */
export const REVIEW_AGENT_RUN_KEYS: ReadonlySet<string> = new Set(
  REVIEW_RULE_CATALOG.filter((rule) => rule.group === "review").map((rule) => rule.key),
);

/**
 * Insert any catalog rows the database does not already have.
 *
 * Idempotent and additive only. Existing rows are never modified — see invariant 2 above.
 */
export async function seedReviewRuleDefinitions(
  db: DbExecutor,
): Promise<{ inserted: number; skipped: number }> {
  const inserted = await db
    .insert(reviewRuleDefinitions)
    .values(
      REVIEW_RULE_CATALOG.map((rule) => ({
        key: rule.key,
        name: rule.name,
        group: rule.group,
        evaluatorKey: rule.evaluatorKey,
        defaultConfig: rule.defaultConfig,
        formulaVersion: rule.formulaVersion,
      })),
    )
    .onConflictDoNothing({ target: reviewRuleDefinitions.key })
    .returning({ key: reviewRuleDefinitions.key });

  return {
    inserted: inserted.length,
    skipped: REVIEW_RULE_CATALOG.length - inserted.length,
  };
}
