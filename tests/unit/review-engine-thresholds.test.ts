import { describe, expect, it } from "vitest";
import {
  evaluateMaterialAsset,
  evaluateMaterialExpense,
  evaluateTransactionInParentCategory,
  evaluateUnusualSpend,
} from "../../src/lib/inbox/review-engine";

type LedgerRow = Parameters<typeof evaluateUnusualSpend>[0][number];

function expenseRow(
  overrides: Partial<LedgerRow> & { journalId: string; date: string },
): LedgerRow {
  return {
    journalId: overrides.journalId,
    transactionDate: overrides.date,
    accountId: overrides.accountId ?? "account-1",
    accountType: overrides.accountType ?? "expense",
    subtype: overrides.subtype ?? null,
    parentId: overrides.parentId ?? null,
    debit: overrides.debit ?? "100",
    credit: overrides.credit ?? null,
  };
}

/** Three flat baseline months plus a spike, so the boundary is easy to reason about. */
function spendSeries(spike: string): LedgerRow[] {
  return [
    expenseRow({ journalId: "j1", date: "2026-01-10", debit: "100" }),
    expenseRow({ journalId: "j2", date: "2026-02-10", debit: "100" }),
    expenseRow({ journalId: "j3", date: "2026-03-10", debit: "120" }),
    expenseRow({ journalId: "j4", date: "2026-04-10", debit: spike }),
  ];
}

describe("evaluateUnusualSpend", () => {
  it("reproduces the previous hardcoded 3σ behaviour at the seeded default", () => {
    // baseline = [100, 100, 120] → mean 106.67, σ ≈ 9.43 → 3σ threshold ≈ 134.96
    expect(evaluateUnusualSpend(spendSeries("130"), 3)).toHaveLength(0);
    expect(evaluateUnusualSpend(spendSeries("200"), 3)).toHaveLength(1);
  });

  it("flags more as the configured deviation count falls", () => {
    expect(evaluateUnusualSpend(spendSeries("130"), 3)).toHaveLength(0);
    expect(evaluateUnusualSpend(spendSeries("130"), 1)).toHaveLength(1);
  });

  it("needs three months of history before it will flag anything", () => {
    const twoMonths = [
      expenseRow({ journalId: "j1", date: "2026-03-10", debit: "10" }),
      expenseRow({ journalId: "j2", date: "2026-04-10", debit: "9999" }),
    ];
    expect(evaluateUnusualSpend(twoMonths, 3)).toHaveLength(0);
  });

  it("dates the finding by the month observed, not the run date", () => {
    const [target] = evaluateUnusualSpend(spendSeries("200"), 3);
    expect(target.period).toBe("2026-04");
    expect(target.subjectType).toBe("account_month");
  });
});

describe("evaluateMaterialExpense", () => {
  // One month of 1200 → averageMonthly 1200 → annualized 14400 → 1% = 144.
  const rows = [
    expenseRow({ journalId: "small", date: "2026-03-05", debit: "100" }),
    expenseRow({ journalId: "big", date: "2026-03-20", debit: "1100" }),
  ];

  it("reproduces the previous hardcoded 1% behaviour at the seeded default", () => {
    const targets = evaluateMaterialExpense(rows, 1);
    expect(targets.map((target) => target.subjectId)).toEqual(["big"]);
  });

  it("moves the boundary with the configured percentage", () => {
    // 10% of 14400 = 1440, above the 1100 transaction.
    expect(evaluateMaterialExpense(rows, 10)).toHaveLength(0);
    // 0.5% of 14400 = 72, below both.
    expect(evaluateMaterialExpense(rows, 0.5)).toHaveLength(2);
  });

  it("dates each finding by its own journal, not the run date", () => {
    const [target] = evaluateMaterialExpense(rows, 1);
    expect(target.period).toBe("2026-03");
  });

  it("excludes payroll from the baseline and the findings", () => {
    const withPayroll = [
      ...rows,
      expenseRow({ journalId: "payroll", date: "2026-03-25", debit: "9999", subtype: "payroll" }),
    ];
    const targets = evaluateMaterialExpense(withPayroll, 1);
    expect(targets.map((target) => target.subjectId)).toEqual(["big"]);
  });
});

describe("evaluateMaterialAsset", () => {
  const history = [
    expenseRow({
      journalId: "opening",
      date: "2026-01-05",
      accountType: "asset",
      debit: "100000",
    }),
  ];
  const window = [
    expenseRow({
      journalId: "invest",
      date: "2026-03-10",
      accountType: "asset",
      subtype: "investment_securities",
      debit: "800",
    }),
  ];

  it("reproduces the previous hardcoded 0.5% behaviour at the seeded default", () => {
    // Average assets 100000 → 0.5% = 500, so an 800 movement is material.
    const targets = evaluateMaterialAsset(window, history, "2026-01-01", "2026-04-30", 0.5);
    expect(targets.map((target) => target.subjectId)).toEqual(["invest"]);
  });

  it("moves the boundary with the configured percentage", () => {
    // 1% = 1000, above the 800 movement.
    expect(evaluateMaterialAsset(window, history, "2026-01-01", "2026-04-30", 1)).toHaveLength(0);
  });

  it("dates the finding by its own journal", () => {
    const [target] = evaluateMaterialAsset(window, history, "2026-01-01", "2026-04-30", 0.5);
    expect(target.period).toBe("2026-03");
  });
});

describe("evaluateTransactionInParentCategory", () => {
  it("flags a journal posting to a parent account and records which one", () => {
    const rows = [
      expenseRow({ journalId: "j1", date: "2026-05-02", accountId: "parent-a" }),
      expenseRow({ journalId: "j1", date: "2026-05-02", accountId: "leaf-b" }),
      expenseRow({ journalId: "j2", date: "2026-05-03", accountId: "leaf-c" }),
    ];
    const byJournal = new Map([
      ["j1", rows.slice(0, 2)],
      ["j2", rows.slice(2)],
    ]);
    const targets = evaluateTransactionInParentCategory(byJournal, new Set(["parent-a"]));
    expect(targets).toHaveLength(1);
    expect(targets[0].subjectId).toBe("j1");
    expect(targets[0].period).toBe("2026-05");
    // Better than the empty evidence the deleted implementation produced — the findings panel
    // needs something to render.
    expect(targets[0].evidence.accountIds).toEqual(["parent-a"]);
  });

  it("returns nothing when no line hits a parent account", () => {
    const byJournal = new Map([["j1", [expenseRow({ journalId: "j1", date: "2026-05-02" })]]]);
    expect(evaluateTransactionInParentCategory(byJournal, new Set(["other"]))).toHaveLength(0);
  });
});
