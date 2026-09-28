/**
 * Rule replay (Inbox v2 spec §6/§9): pure re-evaluation of papers under a rule
 * set. Deterministic, order-independent, and it never mutates what it reads.
 */
import { describe, expect, it } from "vitest";
import { PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY } from "@/lib/inbox/payment-details-check";
import {
  PAYMENT_DETAILS_RULE_KEY,
  replayJournalId,
  replayRules,
  type ReplayCase,
} from "@/lib/inbox/rule-replay";
import type { RuleSnapshotEntry } from "@/lib/inbox/rule-set";
import { catalogDefaultRuleEntries } from "@/lib/inbox/scorecard";

/** Catalog defaults with the dimension rules off, so each case isolates one behavior. */
function rules(overrides: Record<string, Partial<RuleSnapshotEntry>> = {}): RuleSnapshotEntry[] {
  return catalogDefaultRuleEntries().map((entry) => {
    const base =
      entry.ruleKey === "missing_department" || entry.ruleKey === "missing_location"
        ? { ...entry, enabled: false }
        : entry;
    const override = overrides[entry.ruleKey];
    return override
      ? { ...base, ...override, config: { ...base.config, ...override.config } }
      : base;
  });
}

const ACCOUNTS: ReplayCase["accounts"] = {
  office: { accountType: "expense", subtype: "office_supplies", childCount: 0 },
  payroll: { accountType: "expense", subtype: "payroll_wages", childCount: 0 },
  uncat: { accountType: "expense", subtype: "uncategorized_expense", childCount: 0 },
  bank: { accountType: "asset", subtype: "bank_accounts", childCount: 0 },
};

function paper(id: string, amount: string, extra: Partial<ReplayCase> = {}): ReplayCase {
  return {
    id,
    candidate: {
      transactionDate: "2026-09-14",
      transactionType: "pay_out",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1",
    },
    lines: [
      { accountId: "office", debit: amount, categoryConfidence: "0.9500" },
      { accountId: "bank", credit: amount },
    ],
    accounts: ACCOUNTS,
    party: { id: "vendor", partyType: "vendor" },
    documents: [{ id: "receipt", documentType: "receipt" }],
    ...extra,
  };
}

const purchase = (overrides: Record<string, unknown> = {}) => ({
  economicEventClass: "purchase" as const,
  direction: "outflow" as const,
  originalAmount: "64.20",
  originalCurrency: "USD",
  effectiveDate: "2026-09-14",
  party: "Acme Supplies",
  description: "Printer paper and toner",
  ...overrides,
});

const HISTORY = ["2026-06", "2026-07", "2026-08"].map((month) => ({
  journalId: `hist-${month}`,
  transactionDate: `${month}-10`,
  accountId: "office",
  accountType: "expense",
  subtype: "office_supplies",
  debit: "10000.00",
  credit: null,
}));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const PILE: ReplayCase[] = [
  paper("clean", "20.00"),
  paper("uncategorized", "20.00", {
    lines: [
      { accountId: "uncat", debit: "20.00", categoryConfidence: "0.5000" },
      { accountId: "bank", credit: "20.00" },
    ],
  }),
  paper("receipt", "180.00", { documents: [] }),
  paper("duplicate", "64.20", {
    duplicate: { source: purchase(), priorRecords: [purchase({ sourceRecordId: "prior-1" })] },
  }),
  paper("material", "5000.00", { ledgerHistory: HISTORY }),
];

describe("replayRules", () => {
  it("is deterministic, order-independent, and never mutates its inputs", () => {
    const pile = deepFreeze(structuredClone(PILE));
    const entries = deepFreeze(rules());
    const before = JSON.stringify({ pile, entries });

    const first = replayRules({ cases: pile, rules: { entries } });
    const second = replayRules({ cases: pile, rules: { entries } });
    expect(second).toEqual(first);
    const reversed = replayRules({ cases: [...pile].reverse(), rules: { entries } });
    expect([...reversed].reverse()).toEqual(first);
    expect(JSON.stringify({ pile, entries })).toBe(before);

    expect(
      first.map(({ caseId, blocked, findings }) => ({
        caseId,
        blocked,
        ruleKeys: findings.map((finding) => finding.ruleKey),
      })),
    ).toEqual([
      { caseId: "clean", blocked: false, ruleKeys: [] },
      {
        caseId: "uncategorized",
        blocked: true,
        ruleKeys: ["low_confidence_category", "uncategorized"],
      },
      { caseId: "receipt", blocked: true, ruleKeys: ["missing_receipt"] },
      { caseId: "duplicate", blocked: true, ruleKeys: ["possible_duplicate"] },
      { caseId: "material", blocked: false, ruleKeys: ["material_expense"] },
    ]);
  });

  it("replays book rules under the rule set it is given", () => {
    const [strict] = replayRules({
      cases: [paper("receipt", "50.00", { documents: [] })],
      rules: { entries: rules({ missing_receipt: { config: { threshold: 10 } } }) },
    });
    expect(strict.findings).toMatchObject([
      { ruleKey: "missing_receipt", message: "Attach a receipt for expenses over USD 10.00." },
    ]);
    const [lenient] = replayRules({
      cases: [paper("receipt", "50.00", { documents: [] })],
      rules: { entries: rules({ missing_receipt: { enabled: false } }) },
    });
    expect(lenient.findings).toEqual([]);
  });

  describe("possible duplicates", () => {
    const duplicateCase = paper("dup", "64.20", {
      duplicate: { source: purchase(), priorRecords: [purchase({ sourceRecordId: "prior-1" })] },
    });
    const exactDocument = paper("doc", "64.20", {
      duplicate: {
        source: purchase({ documentHashes: ["sha256:aa"], effectiveDate: "2026-09-01" }),
        priorRecords: [purchase({ sourceRecordId: "prior-doc", documentHashes: ["SHA256:AA"] })],
      },
    });

    function keysUnder(entry: Partial<RuleSnapshotEntry>, cases = [duplicateCase, exactDocument]) {
      return replayRules({ cases, rules: { entries: rules({ possible_duplicate: entry }) } }).map(
        (result) => result.findings.map((finding) => finding.ruleKey),
      );
    }

    it("blocks the way the engine does in enforce mode", () => {
      const [result] = replayRules({ cases: [duplicateCase], rules: { entries: rules() } });
      expect(result.findings).toMatchObject([
        {
          ruleKey: "possible_duplicate",
          impact: "blocking",
          evidence: { priorRecord: "prior-1", reason: "candidate_duplicate" },
        },
      ]);
      expect(keysUnder({})).toEqual([["possible_duplicate"], ["possible_duplicate"]]);
    });

    it("stays silent in shadow mode, when off, and when disabled", () => {
      expect(keysUnder({ config: { mode: "shadow" } })).toEqual([[], []]);
      expect(keysUnder({ config: { mode: "off" } })).toEqual([[], []]);
      expect(keysUnder({ enabled: false })).toEqual([[], []]);
    });

    it("demotes scored matches at warning impact but still blocks an identical document", () => {
      expect(keysUnder({ impact: "warning" })).toEqual([[], ["possible_duplicate"]]);
    });

    it("honors the configured match window", () => {
      // Same invoice number, four days apart: outside the default 3-day window.
      const lateCase = paper("late", "64.20", {
        duplicate: {
          source: purchase({ effectiveDate: "2026-09-18", reference: "INV-9" }),
          priorRecords: [purchase({ sourceRecordId: "prior-1", reference: "INV-9" })],
        },
      });
      expect(keysUnder({}, [lateCase])).toEqual([[]]);
      expect(keysUnder({ config: { matchWindowDays: 7 } }, [lateCase])).toEqual([
        ["possible_duplicate"],
      ]);
    });
  });

  describe("material expense", () => {
    it("flags the paper against the annualized share of recent spend", () => {
      const [material] = replayRules({
        cases: [paper("material", "5000.00", { ledgerHistory: HISTORY })],
        rules: { entries: rules() },
      });
      // (3 × 10,000 + 5,000) / 4 months × 12 × 1% = 1,050.
      expect(material.findings).toEqual([
        {
          ruleKey: "material_expense",
          impact: "warning",
          message: "Expense transaction exceeds 1% of annualized recent expenses.",
          evidence: {
            total: 5000,
            threshold: 1050,
            averageMonthly: 8750,
            annualizedExpensePercent: 1,
          },
        },
      ]);
      const [routine] = replayRules({
        cases: [paper("routine", "500.00", { ledgerHistory: HISTORY })],
        rules: { entries: rules() },
      });
      expect(routine.findings).toEqual([]);
    });

    it("skips payroll, obeys the rule's switch and impact, and needs ledger context", () => {
      const payroll = paper("payroll", "5000.00", {
        ledgerHistory: HISTORY,
        lines: [
          { accountId: "payroll", debit: "5000.00" },
          { accountId: "bank", credit: "5000.00" },
        ],
      });
      const material = paper("material", "5000.00", { ledgerHistory: HISTORY });
      const noContext = paper("no-context", "5000.00");
      const keys = (entries: RuleSnapshotEntry[]) =>
        replayRules({ cases: [payroll, material, noContext], rules: { entries } }).map((result) =>
          result.findings.map(({ ruleKey, impact }) => `${ruleKey}:${impact}`),
        );
      expect(keys(rules())).toEqual([[], ["material_expense:warning"], []]);
      expect(keys(rules({ material_expense: { enabled: false } }))).toEqual([[], [], []]);
      expect(keys(rules({ material_expense: { impact: "blocking" } }))).toEqual([
        [],
        ["material_expense:blocking"],
        [],
      ]);
    });

    it("measures a foreign-currency paper in the functional currency", () => {
      const [eur] = replayRules({
        cases: [
          paper("eur", "1000.00", {
            ledgerHistory: HISTORY,
            candidate: {
              transactionDate: "2026-09-14",
              transactionType: "pay_out",
              originalCurrency: "EUR",
              functionalCurrency: "USD",
              exchangeRate: "1.1000000000",
            },
          }),
        ],
        rules: { entries: rules() },
      });
      // EUR 1,000 = USD 1,100: (30,000 + 1,100) / 4 × 12 × 1% = 933, and 1,100 > 933.
      expect(eur.findings).toMatchObject([
        { ruleKey: "material_expense", evidence: { total: 1100, threshold: 933 } },
      ]);
      expect(replayJournalId("eur")).toBe("replay:eur");
    });
  });

  describe("payee bank details", () => {
    const stored = { bankAccountNumber: "000123456789", bankRoutingNumber: "021000021" };
    const changed = paper("changed", "40.00", {
      paymentDetails: {
        stored,
        printed: { accountNumber: "000987654321", routingNumber: "021000021" },
      },
    });

    it("blocks a paper that asks to be paid somewhere new, whatever the rule set", () => {
      expect(PAYMENT_DETAILS_RULE_KEY).toBe(PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY);
      const everythingOff = rules(
        Object.fromEntries(
          catalogDefaultRuleEntries().map((entry) => [entry.ruleKey, { enabled: false }]),
        ),
      );
      for (const entries of [rules(), everythingOff]) {
        const [result] = replayRules({ cases: [changed], rules: { entries } });
        expect(result).toMatchObject({
          blocked: true,
          findings: [
            {
              ruleKey: "party_payment_details_changed",
              impact: "blocking",
              evidence: {
                fields: ["bank_account_number"],
                stored: { accountLast4: "6789" },
                document: { accountLast4: "4321" },
              },
            },
          ],
        });
      }
    });

    it("stays quiet for the same account, a matching masked tail, a non-payee, or no context", () => {
      const quiet = [
        paper("same", "40.00", {
          paymentDetails: {
            stored,
            printed: { accountNumber: "0001 2345 6789", routingNumber: "021-000-021" },
          },
        }),
        paper("masked", "40.00", {
          paymentDetails: {
            stored,
            printed: { accountNumber: "****6789", routingNumber: null },
          },
        }),
        { ...changed, id: "customer", party: { id: "customer", partyType: "customer" } },
        paper("no-context", "40.00"),
      ];
      // The customer paper still trips the book rule for a missing vendor; it
      // just is not a payee whose bank details could change.
      expect(
        replayRules({ cases: quiet, rules: { entries: rules() } }).map((result) =>
          result.findings.map((finding) => finding.ruleKey),
        ),
      ).toEqual([[], [], ["missing_vendor"], []]);
    });
  });
});
