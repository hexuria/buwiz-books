/**
 * The rule scorecard (Inbox v2 spec §9): replay a pile of papers under a rule
 * set and measure how the rules did against ground truth.
 *
 * Pure — parsing, replay, and scoring touch no database and no network. The
 * CLI (scripts/eval-scorecard.ts) adds the only I/O: reading pile and rules
 * files, or reading an organization's pile and rules inside its org context.
 *
 * GROUND TRUTH. Each case may carry `expected.problems`: the rule keys of the
 * problems a reviewer says the paper really has ([] = a clean paper), and
 * optionally `expected.blocked`, whether the paper must be held from approval.
 * Golden piles label every case; an organization's pile takes labels from its
 * `ai_eval_cases` rows (task `inbox_rules`). Unlabeled cases still count
 * toward `cases` and `approved_zero_edits` but not toward caught or false
 * alarms, because there is nothing to compare them with.
 *
 * LOCKED CASES must reproduce exactly — every expected problem flagged, nothing
 * else flagged, and the blocked state matching when stated. The CI gate fails
 * unless `locked_cases_passing === locked_cases_total`.
 */
import { z } from "zod";
import type { RuleSnapshotEntry } from "@/db/schema/rule-snapshots";
import { ECONOMIC_EVENT_CLASSES } from "./duplicate-matcher";
import { REVIEW_RULE_CATALOG } from "./review-rule-catalog";
import { replayRules, type ReplayCaseResult } from "./rule-replay";
import {
  buildEffectiveRuleEntries,
  DEFAULT_BOOK_RULE_FALLBACKS,
  ruleSnapshotEntriesSchema,
  type BookRuleFallbacks,
} from "./rule-set";

/** The `ai_eval_cases.task` an organization's scorecard labels live under. */
export const SCORECARD_EVAL_TASK = "inbox_rules";

export const SCORECARD_CHAINS = ["recorded", "default", "jev"] as const;
export type ScorecardChain = (typeof SCORECARD_CHAINS)[number];

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "Expected a decimal string.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD).");
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code.");

const lineSchema = z
  .object({
    accountId: z.string().min(1).nullable().optional(),
    debit: decimalString.nullable().optional(),
    credit: decimalString.nullable().optional(),
    departmentId: z.string().min(1).nullable().optional(),
    locationId: z.string().min(1).nullable().optional(),
    categoryConfidence: decimalString.nullable().optional(),
    lineDescription: z.string().nullable().optional(),
  })
  .strict();

const matcherInputSchema = z
  .object({
    sourceRecordId: z.string().min(1).nullable().optional(),
    economicEventClass: z.enum(ECONOMIC_EVENT_CLASSES).nullable().optional(),
    direction: z.enum(["inflow", "outflow", "neutral", "unknown"]).nullable().optional(),
    originalAmount: decimalString.nullable().optional(),
    originalCurrency: currencyCode.nullable().optional(),
    effectiveDate: isoDate.nullable().optional(),
    party: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    sourceAccountRef: z.string().nullable().optional(),
    documentHashes: z.array(z.string().min(1)).nullable().optional(),
    recordState: z.enum(["active", "rejected", "superseded"]).nullable().optional(),
  })
  .strict();

const ledgerRowSchema = z
  .object({
    journalId: z.string().min(1),
    transactionDate: isoDate,
    accountId: z.string().min(1),
    accountType: z.string().min(1),
    subtype: z.string().nullable(),
    debit: decimalString.nullable(),
    credit: decimalString.nullable(),
  })
  .strict();

export const scorecardCaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    /** Free-form grouping for humans, e.g. "missing_receipt". */
    category: z.string().min(1).max(64).nullable().default(null),
    note: z.string().optional(),
    locked: z.boolean().default(false),
    candidate: z
      .object({
        transactionDate: isoDate,
        transactionType: z.enum(["pay_in", "pay_out", "journal", "transfer"]),
        originalCurrency: currencyCode,
        functionalCurrency: currencyCode,
        exchangeRate: decimalString.default("1"),
        memo: z.string().nullable().optional(),
        referenceNumber: z.string().nullable().optional(),
      })
      .strict(),
    lines: z.array(lineSchema).min(2, "A candidate needs at least two posting lines."),
    accounts: z
      .record(
        z.string(),
        z
          .object({
            accountType: z.string().min(1),
            subtype: z.string().nullable(),
            childCount: z.number().int().min(0).default(0),
          })
          .strict(),
      )
      .default({}),
    party: z
      .object({ id: z.string().min(1), partyType: z.string().min(1) })
      .strict()
      .nullable()
      .default(null),
    documents: z
      .array(z.object({ id: z.string().min(1), documentType: z.string().min(1) }).strict())
      .default([]),
    duplicate: z
      .object({ source: matcherInputSchema, priorRecords: z.array(matcherInputSchema) })
      .strict()
      .nullable()
      .default(null),
    ledgerHistory: z.array(ledgerRowSchema).nullable().default(null),
    paymentDetails: z
      .object({
        stored: z
          .object({
            bankAccountNumber: z.string().nullable(),
            bankRoutingNumber: z.string().nullable(),
          })
          .strict(),
        printed: z
          .object({ accountNumber: z.string().nullable(), routingNumber: z.string().nullable() })
          .strict(),
      })
      .strict()
      .nullable()
      .default(null),
    expected: z
      .object({ problems: z.array(z.string().min(1)), blocked: z.boolean().optional() })
      .strict()
      .nullable()
      .default(null),
    /** The recorded human outcome for this paper. */
    outcome: z
      .object({
        decision: z.enum(["approved", "rejected", "pending"]),
        edits: z.number().int().min(0),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.locked && !value.expected) {
      ctx.addIssue({
        code: "custom",
        message: "A locked case needs an expected label to lock.",
        path: ["expected"],
      });
    }
  });

export type ScorecardCase = z.output<typeof scorecardCaseSchema>;

export class ScorecardInputError extends Error {}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Parse a JSONL pile: one case per line, blank lines ignored, ids unique. */
export function parseScorecardPile(text: string, source = "pile"): ScorecardCase[] {
  const cases: ScorecardCase[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const where = `${source}:${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new ScorecardInputError(`${where}: not valid JSON.`);
    }
    const parsed = scorecardCaseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ScorecardInputError(`${where}: ${describeIssues(parsed.error)}`);
    }
    if (ids.has(parsed.data.id)) {
      throw new ScorecardInputError(`${where}: duplicate case id ${parsed.data.id}.`);
    }
    ids.add(parsed.data.id);
    cases.push(parsed.data);
  }
  if (cases.length === 0) throw new ScorecardInputError(`${source}: the pile has no cases.`);
  return cases;
}

const ruleSetFileSchema = z.union([
  ruleSnapshotEntriesSchema,
  // A snapshot as `getRuleSnapshot` returns it, or a hand-written pack.
  z.looseObject({ label: z.string().nullable().optional(), snapshot: ruleSnapshotEntriesSchema }),
]);

/** Parse a rules file: a bare entry array, or `{ label?, snapshot: [...] }`. */
export function parseRuleSetFile(
  text: string,
  source = "rules",
): { label: string | null; entries: RuleSnapshotEntry[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ScorecardInputError(`${source}: not valid JSON.`);
  }
  const parsed = ruleSetFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ScorecardInputError(`${source}: ${describeIssues(parsed.error)}`);
  }
  return Array.isArray(parsed.data)
    ? { label: null, entries: parsed.data }
    : { label: parsed.data.label ?? null, entries: parsed.data.snapshot };
}

export interface ScorecardCaseOutcome {
  id: string;
  category: string | null;
  locked: boolean;
  labeled: boolean;
  /** Unique rule keys the rule set flagged, sorted. */
  flagged: string[];
  blocked: boolean;
  caught: string[];
  missed: string[];
  falseAlarms: string[];
  /** Whether the case reproduced its label exactly; null when unlabeled. */
  exact: boolean | null;
}

export interface ScorecardReport {
  pile: string;
  rules: string;
  chain: ScorecardChain;
  cases: number;
  labeled_cases: number;
  real_problems_total: number;
  real_problems_caught: number;
  false_alarms: number;
  approved_zero_edits: number;
  locked_cases_total: number;
  locked_cases_passing: number;
  /** Null until classification memory lands (build step 10). */
  memory_hit_rate: number | null;
  /** Null until Jev approval lanes land (build step 11). */
  jev_approvals_undone: number | null;
  /** Null in recorded mode: nothing is spent replaying stored responses. */
  cost_per_100: number | null;
  failing_locked_cases: Array<{
    id: string;
    missed: string[];
    false_alarms: string[];
    expected_blocked: boolean | null;
    blocked: boolean;
  }>;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Compare one case's replay with its label. */
export function scoreCase(
  scorecardCase: Pick<ScorecardCase, "id" | "category" | "locked" | "expected">,
  result: ReplayCaseResult,
): ScorecardCaseOutcome {
  const flagged = sortedUnique(result.findings.map((finding) => finding.ruleKey));
  const base = {
    id: scorecardCase.id,
    category: scorecardCase.category,
    locked: scorecardCase.locked,
    flagged,
    blocked: result.blocked,
  };
  if (!scorecardCase.expected) {
    return { ...base, labeled: false, caught: [], missed: [], falseAlarms: [], exact: null };
  }
  const problems = new Set(scorecardCase.expected.problems);
  const caught = flagged.filter((key) => problems.has(key));
  const missed = sortedUnique([...problems].filter((key) => !flagged.includes(key)));
  const falseAlarms = flagged.filter((key) => !problems.has(key));
  const blockedMatches =
    scorecardCase.expected.blocked === undefined ||
    scorecardCase.expected.blocked === result.blocked;
  return {
    ...base,
    labeled: true,
    caught,
    missed,
    falseAlarms,
    exact: missed.length === 0 && falseAlarms.length === 0 && blockedMatches,
  };
}

/** Aggregate per-case outcomes into the report's metrics. */
export function summarizeScorecard(
  cases: readonly Pick<ScorecardCase, "id" | "category" | "locked" | "expected" | "outcome">[],
  outcomes: readonly ScorecardCaseOutcome[],
  meta: { pile: string; rules: string; chain: ScorecardChain },
): ScorecardReport {
  if (cases.length !== outcomes.length) {
    throw new Error("Every case needs exactly one outcome.");
  }
  const labeled = outcomes.filter((outcome) => outcome.labeled);
  const locked = outcomes.filter((outcome) => outcome.locked);
  return {
    pile: meta.pile,
    rules: meta.rules,
    chain: meta.chain,
    cases: cases.length,
    labeled_cases: labeled.length,
    real_problems_total: cases.reduce(
      (total, item) => total + new Set(item.expected?.problems ?? []).size,
      0,
    ),
    real_problems_caught: labeled.reduce((total, outcome) => total + outcome.caught.length, 0),
    false_alarms: labeled.reduce((total, outcome) => total + outcome.falseAlarms.length, 0),
    approved_zero_edits: cases.filter(
      (item) => item.outcome?.decision === "approved" && item.outcome.edits === 0,
    ).length,
    locked_cases_total: locked.length,
    locked_cases_passing: locked.filter((outcome) => outcome.exact === true).length,
    memory_hit_rate: null,
    jev_approvals_undone: null,
    cost_per_100: null,
    failing_locked_cases: locked
      .filter((outcome) => outcome.exact !== true)
      .map((outcome) => {
        const item = cases.find((candidate) => candidate.id === outcome.id);
        return {
          id: outcome.id,
          missed: outcome.missed,
          false_alarms: outcome.falseAlarms,
          expected_blocked: item?.expected?.blocked ?? null,
          blocked: outcome.blocked,
        };
      }),
  };
}

/** Replay a pile under a rule set and score it. Pure. */
export function runScorecard(input: {
  cases: readonly ScorecardCase[];
  entries: readonly RuleSnapshotEntry[];
  fallbacks?: BookRuleFallbacks;
  pile: string;
  rules: string;
  chain: ScorecardChain;
}): { report: ScorecardReport; outcomes: ScorecardCaseOutcome[] } {
  if (input.chain !== "recorded") {
    throw new ScorecardInputError(
      `Chain "${input.chain}" needs live model calls. The scorecard runs recorded mode only; live chains belong to the nightly harness, with its budget cap.`,
    );
  }
  const results = replayRules({
    cases: input.cases,
    rules: { entries: input.entries, fallbacks: input.fallbacks },
  });
  const outcomes = input.cases.map((item, index) => scoreCase(item, results[index]));
  return {
    report: summarizeScorecard(input.cases, outcomes, {
      pile: input.pile,
      rules: input.rules,
      chain: input.chain,
    }),
    outcomes,
  };
}

/** Human-readable rendering of a report. */
export function formatScorecardReport(report: ScorecardReport): string {
  const rows: Array<[string, string]> = [
    ["cases", `${report.cases} (${report.labeled_cases} labeled)`],
    ["real problems caught", `${report.real_problems_caught} / ${report.real_problems_total}`],
    ["false alarms", String(report.false_alarms)],
    ["approved with zero edits", String(report.approved_zero_edits)],
    ["locked cases passing", `${report.locked_cases_passing} / ${report.locked_cases_total}`],
    [
      "memory hit rate",
      report.memory_hit_rate === null ? "n/a (build step 10)" : String(report.memory_hit_rate),
    ],
    [
      "cost per 100 papers",
      report.cost_per_100 === null ? "n/a (recorded mode)" : String(report.cost_per_100),
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = [
    `Rule scorecard — pile: ${report.pile} · rules: ${report.rules} · chain: ${report.chain}`,
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ];
  for (const failure of report.failing_locked_cases) {
    const parts = [
      failure.missed.length > 0 ? `missed ${failure.missed.join(", ")}` : null,
      failure.false_alarms.length > 0 ? `false alarm ${failure.false_alarms.join(", ")}` : null,
      failure.expected_blocked !== null && failure.expected_blocked !== failure.blocked
        ? `blocked=${failure.blocked}, expected ${failure.expected_blocked}`
        : null,
    ].filter(Boolean);
    lines.push(`  ✗ locked case ${failure.id}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * The catalog's rules as an organization with no saved configs and default
 * accounting settings has them — the `--rules default` rule set.
 */
export function catalogDefaultRuleEntries(): RuleSnapshotEntry[] {
  return buildEffectiveRuleEntries({
    definitions: REVIEW_RULE_CATALOG.map((rule) => ({
      key: rule.key,
      group: rule.group,
      defaultConfig: rule.defaultConfig,
      formulaVersion: rule.formulaVersion,
    })),
    configs: [],
    fallbacks: DEFAULT_BOOK_RULE_FALLBACKS,
  });
}

// ── Command line ────────────────────────────────────────────────────────────

/** The checked-in golden pile and the rule set its locked cases are locked to. */
export const GOLDEN_PILE_PATH = "tests/evals/scorecard/golden.jsonl";
export const GOLDEN_RULES_PATH = "tests/evals/scorecard/golden-rules.json";

export type ScorecardPileArg = { kind: "file"; path: string } | { kind: "org"; orgId: string };
export type ScorecardRulesArg =
  | { kind: "default" }
  | { kind: "live" }
  | { kind: "snapshot"; snapshotId: string }
  | { kind: "file"; path: string };

export interface ScorecardArgs {
  pile: ScorecardPileArg;
  rules: ScorecardRulesArg;
  chain: ScorecardChain;
  json: boolean;
  /** The organization whose rules (live or a snapshot) evaluate a file pile. */
  orgId: string | null;
  limit: number | null;
  help: boolean;
}

export const SCORECARD_USAGE = `Usage: bun eval:scorecard --pile <path.jsonl | golden | org:<orgId>> [options]

  --pile   <path.jsonl>   JSONL cases (format: docs/inbox-workflow.md, "Rule scorecard")
           golden         the checked-in golden pile (${GOLDEN_PILE_PATH})
           org:<orgId>    the organization's decided Inbox items (reads the database)
  --rules  default        catalog defaults (no database)
           live           the organization's live rule configs (reads the database)
           <snapshot-id>  one of the organization's rule snapshots (reads the database)
           <path.json>    a rules file: [{ruleKey, enabled, impact, config, formulaVersion}]
                          or { label, snapshot: [...] }
           Default: the golden rules for --pile golden, live for org piles, default otherwise.
  --org    <orgId>        the organization whose live rules or snapshot evaluate a file pile
  --chain  recorded       replay recorded outcomes (the only chain without live model calls)
  --limit  <n>            org piles: how many decided items to read (default 200, max 5000)
  --json                  print the report as JSON`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the CLI arguments. Throws ScorecardInputError on anything ambiguous. */
export function parseScorecardArgs(argv: readonly string[]): ScorecardArgs {
  const values = new Map<string, string>();
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const match = /^--(pile|rules|chain|org|limit)(?:=(.*))?$/.exec(arg);
    if (!match) throw new ScorecardInputError(`Unknown argument: ${arg}`);
    const [, name, inline] = match;
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (!value || value.startsWith("--")) {
      throw new ScorecardInputError(`--${name} needs a value.`);
    }
    if (values.has(name)) throw new ScorecardInputError(`--${name} was given twice.`);
    values.set(name, value);
  }
  if (help) {
    return {
      pile: { kind: "file", path: GOLDEN_PILE_PATH },
      rules: { kind: "default" },
      chain: "recorded",
      json,
      orgId: null,
      limit: null,
      help,
    };
  }

  const pileValue = values.get("pile");
  if (!pileValue) throw new ScorecardInputError("--pile is required.");
  const golden = pileValue === "golden";
  let pile: ScorecardPileArg;
  if (pileValue.startsWith("org:")) {
    const orgId = pileValue.slice("org:".length).trim();
    if (!orgId) throw new ScorecardInputError("--pile org:<orgId> needs an organization id.");
    pile = { kind: "org", orgId };
  } else {
    pile = { kind: "file", path: golden ? GOLDEN_PILE_PATH : pileValue };
  }

  const explicitOrg = values.get("org")?.trim() || null;
  if (pile.kind === "org" && explicitOrg && explicitOrg !== pile.orgId) {
    throw new ScorecardInputError("--org names a different organization than --pile org:<id>.");
  }
  const orgId = pile.kind === "org" ? pile.orgId : explicitOrg;

  const rulesValue = values.get("rules");
  let rules: ScorecardRulesArg;
  if (!rulesValue) {
    rules = golden
      ? { kind: "file", path: GOLDEN_RULES_PATH }
      : pile.kind === "org"
        ? { kind: "live" }
        : { kind: "default" };
  } else if (rulesValue === "default") {
    rules = { kind: "default" };
  } else if (rulesValue === "live") {
    rules = { kind: "live" };
  } else if (UUID_PATTERN.test(rulesValue)) {
    rules = { kind: "snapshot", snapshotId: rulesValue.toLowerCase() };
  } else {
    rules = { kind: "file", path: rulesValue };
  }
  if ((rules.kind === "live" || rules.kind === "snapshot") && !orgId) {
    throw new ScorecardInputError(
      `--rules ${rulesValue} reads an organization's rules: pass --org <orgId> or use --pile org:<orgId>.`,
    );
  }

  const chainValue = values.get("chain") ?? "recorded";
  if (!(SCORECARD_CHAINS as readonly string[]).includes(chainValue)) {
    throw new ScorecardInputError(
      `--chain must be one of ${SCORECARD_CHAINS.join(", ")} (got ${chainValue}).`,
    );
  }

  const limitValue = values.get("limit");
  let limit: number | null = null;
  if (limitValue !== undefined) {
    if (pile.kind !== "org") throw new ScorecardInputError("--limit applies to org piles only.");
    limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new ScorecardInputError("--limit must be an integer from 1 to 5000.");
    }
  }

  return { pile, rules, chain: chainValue as ScorecardChain, json, orgId, limit, help };
}
