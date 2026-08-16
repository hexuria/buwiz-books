import { describe, expect, it } from "vitest";
import {
  REVIEW_AGENT_RUN_KEYS,
  REVIEW_RULE_BY_KEY,
  REVIEW_RULE_CATALOG,
} from "../../src/lib/inbox/review-rule-catalog";
import { REVIEW_AGENT_SCHEMAS } from "../../src/lib/review-agents/agent-config-schema";

/**
 * Pinned expectations, deliberately written out rather than derived from the SQL. Any future edit
 * to the catalog then shows up as a reviewed diff here instead of passing silently.
 */
const EXPECTED_BOOK_KEYS = [
  "uncategorized",
  "low_confidence_category",
  "missing_vendor",
  "missing_customer",
  "missing_receipt",
  "missing_invoice",
  "missing_department",
  "missing_location",
  "possible_duplicate",
];

const EXPECTED_REVIEW_KEYS = [
  "unusual_spend",
  "non_zero_clearing",
  "material_expense",
  "material_asset",
  "transaction_in_parent_category",
];

const EXPECTED_SYSTEM_KEYS = ["source_processing_failed", "source_evidence_incomplete"];

/** Book rule keys emitted by evaluateBookRules (src/lib/inbox/rules.ts). */
const BOOK_RULE_KEYS_IN_ENGINE = [
  "uncategorized",
  "low_confidence_category",
  "missing_vendor",
  "missing_customer",
  "missing_receipt",
  "missing_invoice",
  "missing_department",
  "missing_location",
  "transaction_in_parent_category",
];

/** Keys inserted directly by background handlers, with no evaluator behind them. */
const SYSTEM_RULE_KEYS_IN_HANDLERS = ["source_processing_failed", "source_evidence_incomplete"];

describe("review rule catalog", () => {
  it("has unique keys", () => {
    const keys = REVIEW_RULE_CATALOG.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fits the column widths in review_rule_definitions", () => {
    for (const rule of REVIEW_RULE_CATALOG) {
      expect(rule.key.length, `key: ${rule.key}`).toBeLessThanOrEqual(64);
      expect(rule.name.length, `name: ${rule.name}`).toBeLessThanOrEqual(120);
      expect(rule.group.length, `group: ${rule.group}`).toBeLessThanOrEqual(16);
      expect(rule.evaluatorKey.length, `evaluatorKey: ${rule.key}`).toBeLessThanOrEqual(64);
    }
  });

  it("gives every rule a description and an evaluatorKey matching its key", () => {
    for (const rule of REVIEW_RULE_CATALOG) {
      expect(rule.description.length, `description: ${rule.key}`).toBeGreaterThan(10);
      expect(rule.evaluatorKey).toBe(rule.key);
    }
  });

  it("contains exactly the expected keys per group", () => {
    const byGroup = (group: string) =>
      REVIEW_RULE_CATALOG.filter((rule) => rule.group === group).map((rule) => rule.key);
    expect(byGroup("book").sort()).toEqual([...EXPECTED_BOOK_KEYS].sort());
    expect(byGroup("review").sort()).toEqual([...EXPECTED_REVIEW_KEYS].sort());
    expect(byGroup("system").sort()).toEqual([...EXPECTED_SYSTEM_KEYS].sort());
  });

  /**
   * drizzle/0020_transaction_deduplication.sql already replaced 0019's row. Seeding 0019's older
   * shape would silently retune duplicate blocking for every tenant, because
   * loadDuplicateEngineConfig reads mode/blockingScore/shadowScore straight off default_config.
   */
  it("pins possible_duplicate to the post-0020 shape", () => {
    const rule = REVIEW_RULE_BY_KEY.get("possible_duplicate");
    expect(rule).toBeDefined();
    expect(rule!.formulaVersion).toBeGreaterThanOrEqual(2);
    expect(rule!.defaultConfig).toMatchObject({
      mode: "enforce",
      matchWindowDays: 3,
      blockingScore: 70,
      shadowScore: 50,
    });
  });

  it("pins the seeded thresholds the engine now reads", () => {
    expect(REVIEW_RULE_BY_KEY.get("unusual_spend")!.defaultConfig.standardDeviations).toBe(3);
    expect(REVIEW_RULE_BY_KEY.get("material_expense")!.defaultConfig.annualizedExpensePercent).toBe(
      1,
    );
    expect(REVIEW_RULE_BY_KEY.get("material_asset")!.defaultConfig.totalAssetPercent).toBe(0.5);
    expect(REVIEW_RULE_BY_KEY.get("missing_receipt")!.defaultConfig.threshold).toBe(75);
    expect(REVIEW_RULE_BY_KEY.get("low_confidence_category")!.defaultConfig.threshold).toBe(0.8);
  });

  it("restricts the on-demand run to the five review agents", () => {
    expect(REVIEW_AGENT_RUN_KEYS.size).toBe(5);
    for (const key of REVIEW_AGENT_RUN_KEYS) {
      expect(REVIEW_RULE_BY_KEY.get(key)?.group, `${key} must be a review agent`).toBe("review");
    }
    // The book rules must never be reachable from the batch run — that is what created
    // unresolvable blocking findings against already-posted journals.
    for (const key of EXPECTED_BOOK_KEYS) {
      expect(REVIEW_AGENT_RUN_KEYS.has(key), `${key} must not run on demand`).toBe(false);
    }
  });

  /** The regression test for rule keys that block work while appearing nowhere in the UI. */
  it("registers every rule key any code path can emit", () => {
    for (const key of [...BOOK_RULE_KEYS_IN_ENGINE, ...SYSTEM_RULE_KEYS_IN_HANDLERS]) {
      expect(REVIEW_RULE_BY_KEY.has(key), `${key} is emitted but not in the catalog`).toBe(true);
    }
  });
});

describe("review agent UI schemas", () => {
  it("covers every catalog rule", () => {
    for (const rule of REVIEW_RULE_CATALOG) {
      expect(REVIEW_AGENT_SCHEMAS[rule.key], `no UI schema for ${rule.key}`).toBeDefined();
    }
  });

  it("defaults every field to the value the catalog seeds", () => {
    for (const rule of REVIEW_RULE_CATALOG) {
      const schema = REVIEW_AGENT_SCHEMAS[rule.key];
      for (const field of schema.fields) {
        if (!(field.key in rule.defaultConfig)) continue;
        expect(field.defaultValue, `${rule.key}.${field.key}`).toBe(rule.defaultConfig[field.key]);
      }
    }
  });

  /** Cadence is authoritative and must not be derivable from `group` — these two prove why. */
  it("states cadence per agent, not per group", () => {
    expect(REVIEW_AGENT_SCHEMAS.low_confidence_category.cadence).toBe("ingest");
    expect(REVIEW_RULE_BY_KEY.get("low_confidence_category")!.group).toBe("book");
    expect(REVIEW_AGENT_SCHEMAS.transaction_in_parent_category.cadence).toBe(
      "ingest_and_on_demand",
    );
    expect(REVIEW_RULE_BY_KEY.get("transaction_in_parent_category")!.group).toBe("review");
  });

  it("only offers a lookback window to agents that read one", () => {
    for (const [key, schema] of Object.entries(REVIEW_AGENT_SCHEMAS)) {
      if (schema.usesLookback) {
        expect(["on_demand", "ingest_and_on_demand"], `${key}`).toContain(schema.cadence);
      }
    }
  });

  it("keeps algorithmVersion out of the visible fields but inside passthrough", () => {
    const schema = REVIEW_AGENT_SCHEMAS.possible_duplicate;
    expect(schema.fields.some((field) => field.key === "algorithmVersion")).toBe(false);
    expect(schema.passthroughKeys).toContain("algorithmVersion");
  });

  it("confirms before duplicate detection can be switched off, on both paths", () => {
    const schema = REVIEW_AGENT_SCHEMAS.possible_duplicate;
    // duplicate-engine.ts treats `enabled: false` exactly like `mode: "off"`.
    expect(schema.disableConfirm).toBeDefined();
    const mode = schema.fields.find((field) => field.key === "mode");
    expect(mode?.kind).toBe("enum");
    const off =
      mode?.kind === "enum" ? mode.options.find((option) => option.value === "off") : undefined;
    expect(off?.confirm).toBeDefined();
  });
});
