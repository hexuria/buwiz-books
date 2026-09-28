/**
 * Scorecard metric math, input parsing, and CLI arguments (Inbox v2 spec §9).
 */
import { describe, expect, it } from "vitest";
import { REVIEW_RULE_CATALOG } from "@/lib/inbox/review-rule-catalog";
import type { ReplayCaseResult } from "@/lib/inbox/rule-replay";
import {
  catalogDefaultRuleEntries,
  formatScorecardReport,
  GOLDEN_PILE_PATH,
  GOLDEN_RULES_PATH,
  parseRuleSetFile,
  parseScorecardArgs,
  parseScorecardPile,
  runScorecard,
  ScorecardInputError,
  scoreCase,
  scoreJevCase,
  summarizeJevLanes,
  summarizeScorecard,
  type ScorecardCase,
} from "@/lib/inbox/scorecard";

type Label = Pick<ScorecardCase, "id" | "category" | "locked" | "expected" | "outcome">;

function label(id: string, fields: Partial<Label> = {}): Label {
  return { id, category: null, locked: false, expected: null, outcome: null, ...fields };
}

function result(caseId: string, flags: Array<[string, "blocking" | "warning"]>): ReplayCaseResult {
  return {
    caseId,
    findings: flags.map(([ruleKey, impact]) => ({ ruleKey, impact, message: "", evidence: {} })),
    blocked: flags.some(([, impact]) => impact === "blocking"),
  };
}

const META = { pile: "pile.jsonl", rules: "rules.json", chain: "recorded" as const };

describe("scoreCase", () => {
  it("splits flags into caught, missed, and false alarms against the label", () => {
    const outcome = scoreCase(
      label("a", { expected: { problems: ["uncategorized", "missing_receipt"] } }),
      result("a", [
        ["uncategorized", "blocking"],
        ["uncategorized", "blocking"],
        ["missing_vendor", "blocking"],
      ]),
    );
    expect(outcome).toMatchObject({
      labeled: true,
      flagged: ["missing_vendor", "uncategorized"],
      caught: ["uncategorized"],
      missed: ["missing_receipt"],
      falseAlarms: ["missing_vendor"],
      exact: false,
    });
  });

  it("is exact only when the flags match and a stated blocked state matches too", () => {
    const expected = { problems: ["transaction_in_parent_category"], blocked: false };
    expect(
      scoreCase(
        label("warn", { expected }),
        result("warn", [["transaction_in_parent_category", "warning"]]),
      ).exact,
    ).toBe(true);
    expect(
      scoreCase(
        label("block", { expected }),
        result("block", [["transaction_in_parent_category", "blocking"]]),
      ).exact,
    ).toBe(false);
    expect(
      scoreCase(
        label("unstated", { expected: { problems: ["transaction_in_parent_category"] } }),
        result("unstated", [["transaction_in_parent_category", "blocking"]]),
      ).exact,
    ).toBe(true);
  });

  it("leaves an unlabeled case unscored", () => {
    expect(scoreCase(label("u"), result("u", [["uncategorized", "blocking"]]))).toMatchObject({
      labeled: false,
      exact: null,
      caught: [],
      falseAlarms: [],
      flagged: ["uncategorized"],
    });
  });
});

describe("summarizeScorecard", () => {
  it("adds up caught problems, false alarms, zero-edit approvals, and locked cases", () => {
    const cases: Label[] = [
      label("clean-approved", {
        locked: true,
        expected: { problems: [] },
        outcome: { decision: "approved", edits: 0 },
      }),
      label("caught", {
        locked: true,
        expected: { problems: ["uncategorized"], blocked: true },
        outcome: { decision: "approved", edits: 1 },
      }),
      label("missed-and-false-alarm", {
        expected: { problems: ["missing_receipt", "missing_receipt"] },
        outcome: { decision: "approved", edits: 0 },
      }),
      label("locked-regression", {
        locked: true,
        expected: { problems: ["possible_duplicate"], blocked: true },
        outcome: { decision: "rejected", edits: 0 },
      }),
      label("unlabeled", { outcome: { decision: "approved", edits: 0 } }),
    ];
    const results = [
      result("clean-approved", []),
      result("caught", [["uncategorized", "blocking"]]),
      result("missed-and-false-alarm", [["low_confidence_category", "blocking"]]),
      result("locked-regression", [["possible_duplicate", "warning"]]),
      result("unlabeled", [["missing_vendor", "blocking"]]),
    ];
    const report = summarizeScorecard(
      cases,
      cases.map((item, index) => scoreCase(item, results[index])),
      META,
    );
    expect(report).toEqual({
      pile: "pile.jsonl",
      rules: "rules.json",
      chain: "recorded",
      cases: 5,
      labeled_cases: 4,
      // A problem listed twice is one problem.
      real_problems_total: 3,
      real_problems_caught: 2,
      // The unlabeled case's flag is not a false alarm: there is nothing to compare it with.
      false_alarms: 1,
      approved_zero_edits: 3,
      locked_cases_total: 3,
      locked_cases_passing: 2,
      memory_hit_rate: null,
      jev_approvals_undone: null,
      jev_lanes: [],
      cost_per_100: null,
      failing_locked_cases: [
        {
          id: "locked-regression",
          missed: [],
          false_alarms: [],
          expected_blocked: true,
          blocked: false,
        },
      ],
    });
    expect(formatScorecardReport(report)).toContain(
      "✗ locked case locked-regression: blocked=false, expected true",
    );
  });

  it("refuses mismatched cases and outcomes", () => {
    expect(() => summarizeScorecard([label("a")], [], META)).toThrow(/exactly one outcome/);
  });
});

describe("Jev lanes on the scorecard", () => {
  const paper = (
    id: string,
    fields: Partial<ScorecardCase> & { confidence?: string; amount?: string } = {},
  ) =>
    parseScorecardPile(
      JSON.stringify({
        id,
        candidate: {
          transactionDate: "2026-09-14",
          transactionType: "pay_out",
          originalCurrency: "USD",
          functionalCurrency: "USD",
        },
        lines: [
          {
            accountId: "office",
            debit: fields.amount ?? "40.00",
            categoryConfidence: fields.confidence ?? "0.9500",
          },
          { accountId: "bank", credit: fields.amount ?? "40.00" },
        ],
        party: { id: "party-acme", partyType: "vendor" },
        outcome: fields.outcome ?? { decision: "approved", edits: 0 },
        jev: fields.jev ?? { kind: "expense" },
      }),
    )[0];

  it("replays a proposal through the predicate's paper checks, as its lane would", () => {
    expect(scoreJevCase(paper("clean"), result("clean", []))).toEqual({
      id: "clean",
      lane: "party-acme · expense",
      party: "party-acme",
      kind: "expense",
      wouldApprove: true,
      holds: [],
      agreed: true,
    });
    // Below the provisional threshold, flagged, over the lane's cap, a new party.
    expect(
      scoreJevCase(paper("unsure", { confidence: "0.8500" }), result("unsure", [])),
    ).toMatchObject({
      wouldApprove: false,
      holds: ["below_threshold"],
    });
    expect(
      scoreJevCase(paper("flagged"), result("flagged", [["uncategorized", "blocking"]])),
    ).toMatchObject({ wouldApprove: false, holds: ["blocking_finding"] });
    expect(
      scoreJevCase(
        paper("capped", { jev: { kind: "expense", amountCap: "39.99", newParty: false } }),
        result("capped", []),
      ),
    ).toMatchObject({ wouldApprove: false, holds: ["over_cap"] });
    expect(
      scoreJevCase(
        paper("new-party", { jev: { kind: "expense", newParty: true } }),
        result("new-party", []),
      ),
    ).toMatchObject({ wouldApprove: false, holds: ["new_party"] });
    expect(scoreJevCase({ ...paper("plain"), jev: null }, result("plain", []))).toBeNull();
  });

  it("counts would-approve papers a person changed or rejected, per lane", () => {
    const outcomes = [
      scoreJevCase(paper("agreed"), result("agreed", [])),
      scoreJevCase(
        paper("edited", { outcome: { decision: "approved", edits: 1 } }),
        result("edited", []),
      ),
      scoreJevCase(
        paper("rejected", { outcome: { decision: "rejected", edits: 0 } }),
        result("rejected", []),
      ),
      scoreJevCase(
        paper("pending", { outcome: { decision: "pending", edits: 0 } }),
        result("pending", []),
      ),
      scoreJevCase(
        paper("held", { confidence: "0.5000", outcome: { decision: "approved", edits: 1 } }),
        result("held", []),
      ),
    ].flatMap((outcome) => (outcome ? [outcome] : []));
    expect(summarizeJevLanes(outcomes)).toEqual([
      {
        lane: "party-acme · expense",
        party: "party-acme",
        kind: "expense",
        proposals: 5,
        labeled: 4,
        agreed: 1,
        agreement: 0.25,
        would_approve: 4,
        would_approve_undone: 2,
      },
    ]);
    const report = summarizeScorecard(
      outcomes.map((outcome) => label(outcome.id)),
      outcomes.map((outcome) => scoreCase(label(outcome.id), result(outcome.id, []))),
      META,
      outcomes,
    );
    expect(report.jev_approvals_undone).toBe(2);
    expect(formatScorecardReport(report)).toContain(
      "lane party-acme · expense: agreement 25% (1/4); Jev would approve 4, a human would undo 2",
    );
  });
});

const CASE = {
  id: "case-1",
  candidate: {
    transactionDate: "2026-09-14",
    transactionType: "pay_out",
    originalCurrency: "USD",
    functionalCurrency: "USD",
  },
  lines: [
    { accountId: "office", debit: "10.00" },
    { accountId: "bank", credit: "10.00" },
  ],
  accounts: {
    office: { accountType: "expense", subtype: "office_supplies" },
    bank: { accountType: "asset", subtype: "bank_accounts" },
  },
  expected: { problems: [] },
};

describe("parseScorecardPile", () => {
  it("parses JSONL with defaults and skips blank lines", () => {
    const pile = parseScorecardPile(`\n${JSON.stringify(CASE)}\n\n`);
    expect(pile).toHaveLength(1);
    expect(pile[0]).toMatchObject({
      locked: false,
      category: null,
      party: null,
      documents: [],
      duplicate: null,
      ledgerHistory: null,
      outcome: null,
      candidate: { exchangeRate: "1" },
      accounts: { office: { childCount: 0 } },
    });
  });

  it("names the line of every problem", () => {
    const text = [JSON.stringify(CASE), "{not json"].join("\n");
    expect(() => parseScorecardPile(text, "pile.jsonl")).toThrow("pile.jsonl:2: not valid JSON.");
    expect(() =>
      parseScorecardPile(`${JSON.stringify(CASE)}\n${JSON.stringify(CASE)}`, "pile.jsonl"),
    ).toThrow("pile.jsonl:2: duplicate case id case-1.");
    expect(() =>
      parseScorecardPile(JSON.stringify({ ...CASE, locked: true, expected: null }), "p"),
    ).toThrow(/p:1: expected: A locked case needs an expected label/);
    expect(() => parseScorecardPile(JSON.stringify({ ...CASE, problems: [] }), "p")).toThrow(
      /p:1:/,
    );
    expect(() =>
      parseScorecardPile(JSON.stringify({ ...CASE, lines: [{ accountId: "office", debit: 10 }] })),
    ).toThrow(ScorecardInputError);
    expect(() => parseScorecardPile("\n  \n")).toThrow(/no cases/);
  });
});

describe("parseRuleSetFile", () => {
  const entries = catalogDefaultRuleEntries();

  it("reads a bare entry array, a labeled pack, and a snapshot as the server returns it", () => {
    expect(parseRuleSetFile(JSON.stringify(entries))).toEqual({ label: null, entries });
    expect(parseRuleSetFile(JSON.stringify({ label: "Pack", snapshot: entries }))).toEqual({
      label: "Pack",
      entries,
    });
    const served = {
      id: "7c1c0c0e-3a4e-4a55-9f3c-2c4a5c1f2b3d",
      label: null,
      createdAt: "2026-09-27T00:00:00.000Z",
      pinnedBy: [],
      snapshot: entries,
    };
    expect(parseRuleSetFile(JSON.stringify(served)).entries).toEqual(entries);
  });

  it("rejects malformed rules", () => {
    expect(() => parseRuleSetFile("nope", "r.json")).toThrow("r.json: not valid JSON.");
    expect(() =>
      parseRuleSetFile(JSON.stringify([{ ...entries[0], impact: "loud" }]), "r.json"),
    ).toThrow(/r\.json:/);
  });
});

describe("catalogDefaultRuleEntries", () => {
  it("is every configurable catalog rule with its default switch and impact", () => {
    const entries = catalogDefaultRuleEntries();
    expect(entries.map((entry) => entry.ruleKey)).toEqual(
      REVIEW_RULE_CATALOG.filter((rule) => rule.group !== "system")
        .map((rule) => rule.key)
        .sort(),
    );
    expect(entries.every((entry) => entry.enabled)).toBe(true);
  });
});

describe("runScorecard", () => {
  it("refuses chains that would need live model calls", () => {
    const pile = parseScorecardPile(JSON.stringify(CASE));
    for (const chain of ["default", "jev"] as const) {
      expect(() =>
        runScorecard({ cases: pile, entries: [], pile: "p", rules: "r", chain }),
      ).toThrow(/needs live model calls/);
    }
  });
});

describe("parseScorecardArgs", () => {
  const SNAPSHOT = "7C1C0C0E-3A4E-4A55-9F3C-2C4A5C1F2B3D";

  it("resolves the golden alias to the checked-in pile and its rules", () => {
    expect(parseScorecardArgs(["--pile", "golden", "--json"])).toMatchObject({
      pile: { kind: "file", path: GOLDEN_PILE_PATH },
      rules: { kind: "file", path: GOLDEN_RULES_PATH },
      chain: "recorded",
      json: true,
      orgId: null,
    });
  });

  it("defaults rules to live for org piles and to catalog defaults for other files", () => {
    expect(parseScorecardArgs(["--pile=org:org-1"])).toMatchObject({
      pile: { kind: "org", orgId: "org-1" },
      rules: { kind: "live" },
      orgId: "org-1",
    });
    expect(parseScorecardArgs(["--pile", "cases.jsonl"])).toMatchObject({
      pile: { kind: "file", path: "cases.jsonl" },
      rules: { kind: "default" },
    });
  });

  it("recognizes snapshot ids and rules files", () => {
    expect(
      parseScorecardArgs(["--pile", "golden", "--rules", SNAPSHOT, "--org", "org-9"]),
    ).toMatchObject({
      rules: { kind: "snapshot", snapshotId: SNAPSHOT.toLowerCase() },
      orgId: "org-9",
    });
    expect(parseScorecardArgs(["--pile", "golden", "--rules", "pack.json"]).rules).toEqual({
      kind: "file",
      path: "pack.json",
    });
  });

  it("refuses anything ambiguous", () => {
    const refuse = (argv: string[], message: RegExp) =>
      expect(() => parseScorecardArgs(argv)).toThrow(message);
    refuse([], /--pile is required/);
    refuse(["--pile"], /--pile needs a value/);
    refuse(["--pile", "golden", "--rules", "live"], /pass --org/);
    refuse(["--pile", "golden", "--rules", SNAPSHOT], /pass --org/);
    refuse(["--pile", "org:a", "--org", "b"], /different organization/);
    refuse(["--pile", "golden", "--chain", "gemini"], /--chain must be one of/);
    refuse(["--pile", "golden", "--limit", "5"], /org piles only/);
    refuse(["--pile", "org:a", "--limit", "0"], /from 1 to 5000/);
    refuse(["--pile", "golden", "--pile", "x"], /given twice/);
    refuse(["--pile", "golden", "--verbose"], /Unknown argument/);
  });
});
