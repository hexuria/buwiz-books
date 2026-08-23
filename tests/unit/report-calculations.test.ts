import { describe, expect, it } from "vitest";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitLoss,
  buildTrialBalance,
  OPERATING_SUBTYPES,
  INVESTING_SUBTYPES,
  FINANCING_SUBTYPES,
  type ReportRow,
} from "@/lib/report-calculations";
import { ACCOUNT_SUBTYPES, SUBTYPES_BY_TYPE } from "@/db/schema/account-constants";

function row(overrides: Partial<ReportRow>): ReportRow {
  return {
    accountId: overrides.accountId ?? crypto.randomUUID(),
    accountName: overrides.accountName ?? "Account",
    accountNumber: overrides.accountNumber ?? null,
    accountType: overrides.accountType ?? "asset",
    subtype: overrides.subtype ?? null,
    parentId: overrides.parentId ?? null,
    totalDebit: overrides.totalDebit ?? "0",
    totalCredit: overrides.totalCredit ?? "0",
  };
}

describe("report calculations", () => {
  it("builds a balance sheet and rolls P&L balances into net income", () => {
    const currentRows = [
      row({
        accountId: "cash",
        accountName: "Cash",
        accountNumber: "1000",
        accountType: "asset",
        totalDebit: "1000",
        totalCredit: "200",
      }),
      row({
        accountId: "ar",
        accountName: "Accounts Receivable",
        accountNumber: "1100",
        accountType: "asset",
        subtype: "accounts_receivable",
        totalDebit: "500",
      }),
      row({
        accountId: "ap",
        accountName: "Accounts Payable",
        accountNumber: "2000",
        accountType: "liability",
        subtype: "accounts_payable",
        totalDebit: "100",
        totalCredit: "600",
      }),
      row({
        accountId: "equity",
        accountName: "Common Stock",
        accountNumber: "3000",
        accountType: "equity",
        subtype: "common_stock",
        totalCredit: "300",
      }),
      row({
        accountId: "sales",
        accountName: "Sales",
        accountNumber: "4000",
        accountType: "revenue",
        totalCredit: "700",
      }),
      row({
        accountId: "rent",
        accountName: "Rent Expense",
        accountNumber: "5000",
        accountType: "expense",
        totalDebit: "200",
      }),
    ];

    const priorRows = [
      row({
        accountId: "cash",
        accountName: "Cash",
        accountType: "asset",
        totalDebit: "600",
        totalCredit: "100",
      }),
      row({
        accountId: "ap",
        accountName: "Accounts Payable",
        accountType: "liability",
        totalCredit: "300",
      }),
      row({
        accountId: "equity",
        accountName: "Common Stock",
        accountType: "equity",
        totalCredit: "200",
      }),
      row({
        accountId: "sales",
        accountName: "Sales",
        accountType: "revenue",
        totalCredit: "400",
      }),
      row({
        accountId: "rent",
        accountName: "Rent Expense",
        accountType: "expense",
        totalDebit: "100",
      }),
    ];

    const result = buildBalanceSheet(currentRows, "2026-03-31", priorRows);

    expect(result.totalAssets).toBe(1300);
    expect(result.totalLiabilities).toBe(500);
    expect(result.totalEquity).toBe(800);
    expect(result.totalLiabilitiesAndEquity).toBe(1300);
    expect(result.sections.equity.accounts).toContainEqual(
      expect.objectContaining({ id: "net-income", balance: 500 }),
    );
    expect(result.priorSections?.equity.accounts).toContainEqual(
      expect.objectContaining({ id: "net-income", balance: 300 }),
    );
  });

  it("builds profit and loss totals with comparison values", () => {
    const currentRows = [
      row({
        accountId: "sales",
        accountName: "Sales",
        accountType: "revenue",
        totalCredit: "1000",
      }),
      row({
        accountId: "cogs",
        accountName: "Cost of Revenue",
        accountType: "cost_of_revenue",
        totalDebit: "400",
      }),
      row({ accountId: "opex", accountName: "Rent", accountType: "expense", totalDebit: "200" }),
      row({
        accountId: "other-income",
        accountName: "Interest Income",
        accountType: "other_income",
        totalCredit: "50",
      }),
      row({
        accountId: "other-expense",
        accountName: "Bank Fees",
        accountType: "other_expense",
        totalDebit: "25",
      }),
    ];

    const priorRows = [
      row({ accountId: "sales", accountName: "Sales", accountType: "revenue", totalCredit: "800" }),
      row({
        accountId: "cogs",
        accountName: "Cost of Revenue",
        accountType: "cost_of_revenue",
        totalDebit: "300",
      }),
      row({ accountId: "opex", accountName: "Rent", accountType: "expense", totalDebit: "150" }),
      row({
        accountId: "other-expense",
        accountName: "Bank Fees",
        accountType: "other_expense",
        totalDebit: "10",
      }),
    ];

    const result = buildProfitLoss(
      currentRows,
      "2026-03-01",
      "2026-03-31",
      "prior_period",
      priorRows,
    );

    expect(result.grossProfit).toBe(600);
    expect(result.operatingIncome).toBe(400);
    expect(result.netIncome).toBe(425);
    expect(result.priorGrossProfit).toBe(500);
    expect(result.priorOperatingIncome).toBe(350);
    expect(result.priorNetIncome).toBe(340);
    expect(result.revenue.accounts[0]).toEqual(
      expect.objectContaining({
        current: 1000,
        prior: 800,
        changeAmount: 200,
        changePct: 25,
      }),
    );
  });

  it("classifies cash flow rows into operating, investing, and financing buckets", () => {
    const rows = [
      row({ accountName: "Sales", accountType: "revenue", totalCredit: "1000" }),
      row({ accountName: "Rent", accountType: "expense", totalDebit: "300" }),
      row({
        accountName: "Accounts Receivable",
        accountType: "asset",
        subtype: "account_receivable",
        totalDebit: "200",
      }),
      row({
        accountName: "Equipment",
        accountType: "asset",
        subtype: "fixed_assets",
        totalDebit: "500",
      }),
      row({
        accountName: "Long-term Debt",
        accountType: "liability",
        subtype: "long_term_debt",
        totalCredit: "400",
      }),
      // "bank_accounts" is the canonical subtype for a checking account. It is
      // excluded from the sections on purpose: it IS the cash whose net change
      // the statement computes, so counting it would double-count.
      row({
        accountName: "Checking",
        accountType: "asset",
        subtype: "bank_accounts",
        totalDebit: "100",
      }),
    ];

    const result = buildCashFlow(rows, "2026-03-01", "2026-03-31");

    expect(result.operating.total).toBe(500);
    expect(result.investing.total).toBe(-500);
    expect(result.financing.total).toBe(400);
    expect(result.netChange).toBe(400);
    expect(result.unclassified.items).toEqual([]);
    expect(result.operating.items.map((item) => item.name)).toEqual([
      "Sales",
      "Rent",
      "Accounts Receivable",
    ]);
  });

  // PR-15 deliberate change: the old isBalanced was |debits-credits| < 0.01 —
  // a float epsilon that certified this genuinely imbalanced fixture (raw
  // difference 0.001) as balanced. The verdict is now exact at the cent:
  // totals round to different cents here, so the trial balance says so.
  it("quantizes totals to cents and refuses to call a sub-cent imbalance balanced", () => {
    const rows = [
      row({
        accountId: "cash",
        accountName: "Cash",
        accountType: "asset",
        totalDebit: "100.005",
        totalCredit: "0",
      }),
      row({
        accountId: "revenue",
        accountName: "Revenue",
        accountType: "revenue",
        totalDebit: "0",
        totalCredit: "100.004",
      }),
    ];

    const result = buildTrialBalance(rows, "2026-03-31");

    expect(result.totalDebit).toBe(100.01);
    expect(result.totalCredit).toBe(100);
    expect(result.isBalanced).toBe(false);
    expect(result.difference).toBe(0.01);
  });

  it("calls an exactly-equal trial balance balanced", () => {
    const rows = [
      row({
        accountId: "cash",
        accountName: "Cash",
        accountType: "asset",
        totalDebit: "250.10",
        totalCredit: "0",
      }),
      row({
        accountId: "revenue",
        accountName: "Revenue",
        accountType: "revenue",
        totalDebit: "0",
        totalCredit: "250.10",
      }),
    ];
    const result = buildTrialBalance(rows, "2026-03-31");
    expect(result.isBalanced).toBe(true);
    expect(result.difference).toBe(0);
  });
});

describe("P&L prior-period comparison", () => {
  it("includes accounts that had prior activity but none this period", () => {
    // Current period: only "Sales". Prior period: "Sales" AND "Rent" (rent stopped this period).
    const current = [
      row({
        accountId: "sales",
        accountName: "Sales",
        accountType: "revenue",
        totalCredit: "1000",
      }),
    ];
    const prior = [
      row({ accountId: "sales", accountName: "Sales", accountType: "revenue", totalCredit: "800" }),
      row({ accountId: "rent", accountName: "Rent", accountType: "expense", totalDebit: "300" }),
    ];

    const pl = buildProfitLoss(current, "2026-02-01", "2026-02-28", "prior_period", prior);

    // Rent must appear in Operating Expenses with current=0, prior=300 (not silently dropped).
    const rentRow = pl.expenses.accounts.find((a) => a.id === "rent");
    expect(rentRow, "prior-only Rent should appear").toBeTruthy();
    expect(rentRow?.current).toBe(0);
    expect(rentRow?.prior).toBe(300);
    // Prior expense total must include the dropped rent.
    expect(pl.expenses.priorTotal).toBe(300);
    // Prior net income reflects the rent: 800 revenue - 300 rent = 500.
    expect(pl.priorNetIncome).toBe(500);
  });
});

describe("cash-flow subtype classification", () => {
  const canonical = new Set<string>(ACCOUNT_SUBTYPES);
  const allSets = [
    ["OPERATING", OPERATING_SUBTYPES],
    ["INVESTING", INVESTING_SUBTYPES],
    ["FINANCING", FINANCING_SUBTYPES],
  ] as const;

  it("classifies only canonical subtypes (guards the singular/plural mismatch bug)", () => {
    // The historical bug used strings like "accounts_receivable" and "notes_payable" that are
    // NOT in ACCOUNT_SUBTYPES, so those accounts were silently dropped from the statement.
    for (const [name, set] of allSets) {
      for (const subtype of set) {
        expect(canonical.has(subtype), `${name} contains non-canonical subtype "${subtype}"`).toBe(
          true,
        );
      }
    }
  });

  it("assigns each classified subtype to exactly one section", () => {
    const seen = new Map<string, string>();
    for (const [name, set] of allSets) {
      for (const subtype of set) {
        expect(seen.has(subtype), `"${subtype}" is in both ${seen.get(subtype)} and ${name}`).toBe(
          false,
        );
        seen.set(subtype, name);
      }
    }
  });

  it("surfaces an unrecognized balance-sheet subtype instead of dropping it", () => {
    // Regression: a non-canonical subtype (here the historical "checking"
    // instead of "bank_accounts") used to fall out of every section, so the
    // statement silently stopped tying.
    const cashFlow = buildCashFlow(
      [
        row({
          accountName: "Mystery Asset",
          accountType: "asset",
          subtype: "checking",
          totalDebit: "250",
        }),
      ],
      "2026-01-01",
      "2026-01-31",
    );
    expect(cashFlow.unclassified.items.map((i) => i.name)).toEqual(["Mystery Asset"]);
    expect(cashFlow.unclassified.total).toBe(-250);
    expect(cashFlow.netChange).toBe(-250);
  });

  it("covers every balance-sheet subtype (reverse direction)", () => {
    // The other assertions check that classified subtypes are canonical. This
    // checks the direction that actually loses money on the statement: a
    // balance-sheet subtype that no section claims is SILENTLY DROPPED from
    // cash flow, so the statement stops tying with no error anywhere.
    //
    // `bank_accounts` is the one deliberate omission — it IS the cash whose net
    // change the statement computes, so including it would double-count.
    const classified = new Set<string>([
      ...OPERATING_SUBTYPES,
      ...INVESTING_SUBTYPES,
      ...FINANCING_SUBTYPES,
      "bank_accounts",
    ]);
    const balanceSheetSubtypes = (["asset", "liability", "equity"] as const).flatMap(
      (type) => SUBTYPES_BY_TYPE[type],
    );
    const uncovered = balanceSheetSubtypes.filter((subtype) => !classified.has(subtype));
    expect(uncovered, `unclassified balance-sheet subtypes: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("keeps A/R in the operating section (regression: was dropped)", () => {
    expect(OPERATING_SUBTYPES.has("account_receivable")).toBe(true);
    const cashFlow = buildCashFlow(
      [
        row({
          accountId: "ar",
          accountType: "asset",
          subtype: "account_receivable",
          totalDebit: "1000",
        }),
      ],
      "2026-01-01",
      "2026-01-31",
    );
    // An A/R increase is a use of cash → negative operating adjustment, and it must appear.
    expect(cashFlow.operating.items.length).toBe(1);
    expect(cashFlow.operating.total).toBe(-1000);
  });
});
