// ============================================================================
// Rule scorecard gate (recorded mode — NO network, NO database).
//
// Replays the checked-in golden pile under the checked-in golden rules and
// FAILS unless every locked case reproduces exactly: each expected problem
// flagged, nothing else flagged, and the blocked state as labeled. A change to
// the book rules, the duplicate matcher, the material-expense evaluator, or
// the replay itself that alters a locked outcome stops here, before it can
// change what a customer's Inbox blocks.
//
// Unlocked cases are measured, not gated: they hold the known misses and
// false alarms the scorecard exists to track.
//
// Runs in CI through `bun run test:evals` (.github/workflows/deploy.yml).
// ============================================================================
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_PILE_PATH,
  GOLDEN_RULES_PATH,
  parseRuleSetFile,
  parseScorecardPile,
  runScorecard,
  type ScorecardReport,
} from "../../src/lib/inbox/scorecard";

const ROOT = resolve(__dirname, "../..");
const pile = parseScorecardPile(
  readFileSync(resolve(ROOT, GOLDEN_PILE_PATH), "utf8"),
  GOLDEN_PILE_PATH,
);
const rules = parseRuleSetFile(
  readFileSync(resolve(ROOT, GOLDEN_RULES_PATH), "utf8"),
  GOLDEN_RULES_PATH,
);
const { report, outcomes } = runScorecard({
  cases: pile,
  entries: rules.entries,
  pile: GOLDEN_PILE_PATH,
  rules: GOLDEN_RULES_PATH,
  chain: "recorded",
});

describe("rule scorecard gate (recorded mode — no network, no database)", () => {
  it("reproduces every locked case exactly", () => {
    expect(report.locked_cases_total).toBeGreaterThan(0);
    // The failing list first: on a regression it names the case and what changed.
    expect(report.failing_locked_cases).toEqual([]);
    expect(report.locked_cases_passing).toBe(report.locked_cases_total);
  });

  it("locks at least one case in every required category", () => {
    const lockedCategories = new Set(
      pile.filter((item) => item.locked).map((item) => item.category),
    );
    for (const category of [
      "uncategorized",
      "low_confidence",
      "missing_receipt",
      "duplicate",
      "material_expense",
      "payment_details",
    ]) {
      expect(lockedCategories, category).toContain(category);
    }
  });

  it("locks both a problem and a clean case, so a rule set that flags everything fails", () => {
    const locked = outcomes.filter((outcome) => outcome.locked);
    expect(locked.some((outcome) => outcome.flagged.length === 0)).toBe(true);
    expect(locked.some((outcome) => outcome.blocked)).toBe(true);
    expect(locked.some((outcome) => !outcome.blocked)).toBe(true);
  });

  it("prints the metrics from one command without touching a database", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/eval-scorecard.ts",
        "--pile",
        GOLDEN_PILE_PATH,
        "--rules",
        GOLDEN_RULES_PATH,
        "--chain",
        "recorded",
        "--json",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        // An unreachable database: any query on this path would fail the run.
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://scorecard-must-not-connect@127.0.0.1:9/none",
          DATABASE_URL_ADMIN: "",
        },
        timeout: 60_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const printed = JSON.parse(result.stdout) as ScorecardReport;
    expect(printed).toMatchObject({
      cases: report.cases,
      real_problems_caught: report.real_problems_caught,
      false_alarms: report.false_alarms,
      approved_zero_edits: report.approved_zero_edits,
      locked_cases_total: report.locked_cases_total,
      locked_cases_passing: report.locked_cases_total,
      memory_hit_rate: null,
      cost_per_100: null,
    });
  });
});
