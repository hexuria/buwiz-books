/**
 * Rule sets (Inbox v2 spec §6): the one evaluation the live path, pinned
 * snapshots, and the replay all share. The load-bearing property is that a
 * snapshot of the live configuration evaluates exactly like the live
 * configuration — even after the organization's settings change, because a
 * snapshot bakes its thresholds in.
 */
import { describe, expect, it } from "vitest";
import { REVIEW_RULE_CATALOG } from "@/lib/inbox/review-rule-catalog";
import {
  buildEffectiveRuleEntries,
  defaultImpactForGroup,
  DEFAULT_BOOK_RULE_FALLBACKS,
  evaluateCandidateRules,
  ruleConfigMapFromEntries,
  ruleSnapshotEntriesSchema,
  withRuleSetProvenance,
  type CandidateRuleInput,
  type RuleConfigInput,
  type RuleConfigView,
} from "@/lib/inbox/rule-set";
import type { BookRuleAccount } from "@/lib/inbox/rules";

const DEFINITIONS = REVIEW_RULE_CATALOG.map((rule) => ({
  key: rule.key,
  group: rule.group,
  defaultConfig: rule.defaultConfig,
  formulaVersion: rule.formulaVersion,
}));

const ACCOUNTS = new Map<string, BookRuleAccount>([
  ["expense", { id: "expense", accountType: "expense", subtype: "office_supplies", childCount: 0 }],
  ["parent", { id: "parent", accountType: "expense", subtype: "operating", childCount: 3 }],
  [
    "uncat",
    { id: "uncat", accountType: "expense", subtype: "uncategorized_expense", childCount: 0 },
  ],
  ["bank", { id: "bank", accountType: "asset", subtype: "bank_accounts", childCount: 0 }],
  ["ap", { id: "ap", accountType: "liability", subtype: "accounts_payable", childCount: 0 }],
  ["sales", { id: "sales", accountType: "revenue", subtype: "sales", childCount: 0 }],
]);

function input(
  lines: CandidateRuleInput["lines"],
  overrides: Partial<CandidateRuleInput> = {},
): CandidateRuleInput {
  return {
    candidate: {
      transactionDate: "2026-09-14",
      transactionType: "pay_out",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1",
      lines,
    },
    lines,
    accounts: ACCOUNTS,
    party: { id: "vendor", partyType: "vendor" },
    documents: [],
    functionalCurrency: "USD",
    ...overrides,
  };
}

/** A paper that trips every book rule at once. */
const EVERYTHING_WRONG = input(
  [
    { accountId: "uncat", debit: "40.00", categoryConfidence: "0.3000" },
    { accountId: "parent", debit: "60.00" },
    { accountId: "sales", credit: "10.00" },
    { accountId: "ap", credit: "90.00" },
  ],
  { party: null },
);

function ruleKeys(findings: { ruleKey: string }[]) {
  return findings.map((finding) => finding.ruleKey).sort();
}

describe("evaluateCandidateRules", () => {
  it("with no saved configs, falls back to the accounting-settings thresholds", () => {
    const findings = evaluateCandidateRules(
      { configByKey: new Map(), fallbacks: DEFAULT_BOOK_RULE_FALLBACKS },
      input([
        { accountId: "expense", debit: "80.00", categoryConfidence: "0.7999" },
        { accountId: "bank", credit: "80.00" },
      ]),
    );
    expect(
      findings.map(({ ruleKey, impact, evidence }) => ({ ruleKey, impact, evidence })),
    ).toEqual([
      {
        ruleKey: "low_confidence_category",
        impact: "blocking",
        evidence: { lineIndexes: [0], threshold: "0.8000" },
      },
      { ruleKey: "missing_department", impact: "blocking", evidence: {} },
      { ruleKey: "missing_location", impact: "blocking", evidence: {} },
      {
        ruleKey: "missing_receipt",
        impact: "blocking",
        evidence: { expenseTotal: "80", threshold: "75.00000000", thresholdCurrency: "USD" },
      },
    ]);
  });

  it("drops disabled rules, applies configured impacts, and prefers configured thresholds", () => {
    const configByKey = new Map<string, RuleConfigView>([
      ["missing_department", { enabled: false, impact: "blocking", config: {} }],
      ["missing_location", { enabled: true, impact: "warning", config: {} }],
      [
        "missing_receipt",
        { enabled: true, impact: "blocking", config: { threshold: 100, currency: "usd" } },
      ],
      [
        "low_confidence_category",
        { enabled: true, impact: "blocking", config: { threshold: 0.5 } },
      ],
    ]);
    const findings = evaluateCandidateRules(
      { configByKey, fallbacks: DEFAULT_BOOK_RULE_FALLBACKS },
      input([
        { accountId: "expense", debit: "80.00", categoryConfidence: "0.7000" },
        { accountId: "bank", credit: "80.00" },
      ]),
    );
    expect(findings.map(({ ruleKey, impact }) => ({ ruleKey, impact }))).toEqual([
      { ruleKey: "missing_location", impact: "warning" },
    ]);
  });

  it("gives every book rule the impact the snapshot builder defaults it to", () => {
    // If an evaluator's hardcoded impact ever drifts from its group default, a
    // snapshot of an organization with no saved rows would stop matching live.
    const groupOf = new Map(REVIEW_RULE_CATALOG.map((rule) => [rule.key, rule.group]));
    const findings = evaluateCandidateRules(
      { configByKey: new Map(), fallbacks: DEFAULT_BOOK_RULE_FALLBACKS },
      EVERYTHING_WRONG,
    );
    expect(ruleKeys(findings)).toEqual([
      "low_confidence_category",
      "missing_customer",
      "missing_department",
      "missing_invoice",
      "missing_location",
      "missing_receipt",
      "missing_vendor",
      "transaction_in_parent_category",
      "uncategorized",
    ]);
    for (const finding of findings) {
      expect(finding.impact, finding.ruleKey).toBe(
        defaultImpactForGroup(groupOf.get(finding.ruleKey)!),
      );
    }
  });
});

describe("buildEffectiveRuleEntries", () => {
  it("covers every configurable rule, sorted by key, and no system rule", () => {
    const entries = buildEffectiveRuleEntries({
      definitions: DEFINITIONS,
      configs: [],
      fallbacks: DEFAULT_BOOK_RULE_FALLBACKS,
    });
    const configurable = REVIEW_RULE_CATALOG.filter((rule) => rule.group !== "system")
      .map((rule) => rule.key)
      .sort();
    expect(entries.map((entry) => entry.ruleKey)).toEqual(configurable);
    expect(ruleSnapshotEntriesSchema.safeParse(entries).success).toBe(true);
  });

  it("bakes thresholds into book rules and merges defaults for the other engines", () => {
    const configs: RuleConfigInput[] = [
      { key: "missing_receipt", enabled: true, impact: "warning", config: { threshold: 20 } },
      { key: "possible_duplicate", enabled: true, impact: "blocking", config: { mode: "shadow" } },
      { key: "material_expense", enabled: false, impact: "nonsense", config: {} },
    ];
    const entries = buildEffectiveRuleEntries({
      definitions: DEFINITIONS,
      configs,
      fallbacks: {
        lowConfidenceThreshold: "0.6500",
        missingReceiptThreshold: "50.00000000",
        missingReceiptCurrency: "EUR",
      },
    });
    const byKey = new Map(entries.map((entry) => [entry.ruleKey, entry]));
    expect(byKey.get("low_confidence_category")).toEqual({
      ruleKey: "low_confidence_category",
      enabled: true,
      impact: "blocking",
      config: { threshold: "0.6500" },
      formulaVersion: 1,
    });
    // Saved threshold wins; the missing currency comes from the settings.
    expect(byKey.get("missing_receipt")).toMatchObject({
      impact: "warning",
      config: { threshold: 20, currency: "EUR" },
    });
    expect(byKey.get("possible_duplicate")).toMatchObject({
      impact: "blocking",
      formulaVersion: 2,
      config: {
        mode: "shadow",
        matchWindowDays: 3,
        blockingScore: 70,
        shadowScore: 50,
        algorithmVersion: 1,
      },
    });
    // An unreadable saved impact falls back to the group default.
    expect(byKey.get("material_expense")).toMatchObject({
      enabled: false,
      impact: "warning",
      config: { annualizedExpensePercent: 1 },
    });
    expect(byKey.get("uncategorized")).toMatchObject({ enabled: true, impact: "blocking" });
  });

  it("evaluates exactly like the live configuration it froze, even after settings change", () => {
    const liveConfigs: RuleConfigInput[] = [
      { key: "missing_location", enabled: false, impact: "blocking", config: {} },
      { key: "missing_department", enabled: true, impact: "warning", config: {} },
      { key: "transaction_in_parent_category", enabled: true, impact: "blocking", config: {} },
      { key: "missing_invoice", enabled: false, impact: "blocking", config: {} },
    ];
    const settingsAtSnapshot = {
      lowConfidenceThreshold: "0.9000",
      missingReceiptThreshold: "35.00000000",
      missingReceiptCurrency: "USD",
    };
    const liveMap = new Map<string, RuleConfigView>(
      liveConfigs.map(({ key, ...config }) => [key, config]),
    );
    const snapshotMap = ruleConfigMapFromEntries(
      buildEffectiveRuleEntries({
        definitions: DEFINITIONS,
        configs: liveConfigs,
        fallbacks: settingsAtSnapshot,
      }),
    );
    const papers = [
      EVERYTHING_WRONG,
      input([
        { accountId: "expense", debit: "36.00", categoryConfidence: "0.8900" },
        { accountId: "bank", credit: "36.00" },
      ]),
      input([
        { accountId: "bank", debit: "500.00" },
        { accountId: "sales", credit: "500.00" },
      ]),
      input(
        [
          { accountId: "expense", debit: "34.99" },
          { accountId: "bank", credit: "34.99" },
        ],
        { documents: [{ id: "r", documentType: "receipt" }] },
      ),
    ];
    for (const paper of papers) {
      const live = evaluateCandidateRules(
        { configByKey: liveMap, fallbacks: settingsAtSnapshot },
        paper,
      );
      // The organization later loosens its settings; the snapshot must not move.
      const pinned = evaluateCandidateRules(
        { configByKey: snapshotMap, fallbacks: DEFAULT_BOOK_RULE_FALLBACKS },
        paper,
      );
      expect(pinned).toEqual(live);
    }
  });
});

describe("snapshot entry validation", () => {
  it("rejects duplicate rules and impacts other than blocking or warning", () => {
    const entry = {
      ruleKey: "uncategorized",
      enabled: true,
      impact: "blocking",
      config: {},
      formulaVersion: 1,
    };
    expect(ruleSnapshotEntriesSchema.safeParse([entry, entry]).success).toBe(false);
    expect(ruleSnapshotEntriesSchema.safeParse([{ ...entry, impact: "info" }]).success).toBe(false);
    expect(ruleSnapshotEntriesSchema.safeParse([{ ...entry, formulaVersion: 0 }]).success).toBe(
      false,
    );
    expect(ruleSnapshotEntriesSchema.safeParse([entry]).success).toBe(true);
  });
});

describe("withRuleSetProvenance", () => {
  it("stamps the rule set on every finding without touching the originals", () => {
    const findings = [
      { ruleKey: "uncategorized", impact: "blocking" as const, message: "m", evidence: { a: 1 } },
    ];
    const provenance = { source: "snapshot" as const, snapshotId: "s-1", routineId: "r-1" };
    const stamped = withRuleSetProvenance(findings, provenance);
    expect(stamped[0].evidence).toEqual({ a: 1, ruleSet: provenance });
    expect(stamped[0].evidence.ruleSet).not.toBe(provenance);
    expect(findings[0].evidence).toEqual({ a: 1 });
  });
});
