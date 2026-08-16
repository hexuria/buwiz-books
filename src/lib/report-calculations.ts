import { normalizeBalance } from "./report-utils";

export interface ReportRow {
  accountId: string;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
  parentId: string | null;
  totalDebit: string;
  totalCredit: string;
}

interface BalanceSheetSection {
  label: string;
  accounts: Array<{
    id: string;
    name: string;
    accountNumber: string | null;
    subtype: string | null;
    balance: number;
  }>;
  total: number;
}

interface ProfitLossSection {
  label: string;
  accounts: Array<{
    id: string;
    name: string;
    accountNumber: string | null;
    subtype: string | null;
    current: number;
    prior: number | null;
    changeAmount: number | null;
    changePct: number | null;
  }>;
  total: number;
  priorTotal: number | null;
}

const REVENUE_TYPES = new Set(["revenue", "other_income"]);
const EXPENSE_TYPES = new Set(["expense", "cost_of_revenue", "other_expense"]);

// Cash-flow classification of balance-sheet subtypes (indirect method).
// These strings MUST match the canonical ACCOUNT_SUBTYPES in db/schema/account-constants.ts —
// any subtype not listed here is silently dropped from the statement, so the three sets
// together must cover every asset/liability/equity subtype exactly once. The one deliberate
// omission is `bank_accounts`: that IS the cash whose net change the statement computes, so
// including it would double-count.
export const OPERATING_SUBTYPES = new Set([
  // Current assets
  "account_receivable",
  "accrued_revenue",
  "prepaid_expenses",
  "inventory",
  "other_current_assets",
  "asset_clearing",
  "uncategorized_assets",
  // Current liabilities
  "accounts_payable",
  "accrued_expenses",
  "deferred_revenue",
  "credit_cards",
  "payroll_liabilities",
  "other_current_liabilities",
  "liability_clearing",
]);

export const INVESTING_SUBTYPES = new Set([
  "fixed_assets",
  "intangible_assets",
  "goodwill",
  "investments",
  "other_long_term_assets",
]);

export const FINANCING_SUBTYPES = new Set([
  // Debt
  "long_term_debt",
  "short_term_debt",
  "convertible_notes",
  "other_long_term_liabilities",
  "shareholder_loans",
  // Equity
  "owners_equity",
  "additional_paid_in_capital",
  "common_stock",
  "preferred_stock",
  "treasury_stock",
  "retained_earnings",
  "other_comprehensive_income",
  "safes",
  "uncategorized_equity",
]);

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildBalanceSheetSections(rows: ReportRow[]) {
  const sections: Record<string, BalanceSheetSection> = {
    asset: { label: "Assets", accounts: [], total: 0 },
    liability: { label: "Liabilities", accounts: [], total: 0 },
    equity: { label: "Equity", accounts: [], total: 0 },
  };

  let netIncome = 0;

  for (const row of rows) {
    const section = sections[row.accountType];
    const rawBalance = Number.parseFloat(row.totalDebit) - Number.parseFloat(row.totalCredit);

    if (!section) {
      const normalized = normalizeBalance(rawBalance, row.accountType);
      if (REVENUE_TYPES.has(row.accountType)) {
        netIncome += normalized;
      } else if (EXPENSE_TYPES.has(row.accountType)) {
        netIncome -= normalized;
      }
      continue;
    }

    const balance = normalizeBalance(rawBalance, row.accountType);
    section.accounts.push({
      id: row.accountId,
      name: row.accountName,
      accountNumber: row.accountNumber,
      subtype: row.subtype,
      balance,
    });
    section.total = round2(section.total + balance);
  }

  netIncome = round2(netIncome);

  if (netIncome !== 0) {
    sections.equity.accounts.push({
      id: "net-income",
      name: "Net Income",
      accountNumber: null,
      subtype: null,
      balance: netIncome,
    });
    sections.equity.total = round2(sections.equity.total + netIncome);
  }

  return sections;
}

export function buildBalanceSheet(
  rows: ReportRow[],
  asOf: string,
  priorRows: ReportRow[] | null = null,
) {
  const sections = buildBalanceSheetSections(rows);
  const priorSections = priorRows ? buildBalanceSheetSections(priorRows) : null;

  return {
    asOf,
    sections,
    priorSections,
    totalAssets: sections.asset.total,
    totalLiabilities: sections.liability.total,
    totalEquity: sections.equity.total,
    totalLiabilitiesAndEquity: round2(sections.liability.total + sections.equity.total),
  };
}

export function buildProfitLoss(
  rows: ReportRow[],
  dateFrom: string,
  dateTo: string,
  compare: string = "none",
  priorRows: ReportRow[] = [],
) {
  const priorByAccount = new Map<string, number>();
  for (const row of priorRows) {
    const rawBalance = Number.parseFloat(row.totalDebit) - Number.parseFloat(row.totalCredit);
    priorByAccount.set(row.accountId, normalizeBalance(rawBalance, row.accountType));
  }

  const buildSection = (label: string, types: string[]): ProfitLossSection => {
    const sectionAccounts: ProfitLossSection["accounts"] = [];
    let total = 0;
    let priorTotal = 0;
    const emitted = new Set<string>();

    for (const row of rows) {
      if (!types.includes(row.accountType)) continue;
      const rawBalance = Number.parseFloat(row.totalDebit) - Number.parseFloat(row.totalCredit);
      const current = normalizeBalance(rawBalance, row.accountType);
      const prior = priorByAccount.get(row.accountId) ?? null;
      const changeAmount = prior !== null ? current - prior : null;
      const changePct =
        prior !== null && prior !== 0 ? ((current - prior) / Math.abs(prior)) * 100 : null;

      sectionAccounts.push({
        id: row.accountId,
        name: row.accountName,
        accountNumber: row.accountNumber,
        subtype: row.subtype,
        current,
        prior,
        changeAmount,
        changePct,
      });
      emitted.add(row.accountId);
      total += current;
      if (prior !== null) priorTotal += prior;
    }

    // Prior-only accounts: had activity in the prior period but none this period. Without
    // this they'd be silently dropped, understating priorTotal (e.g. rent paid last month,
    // none this month, would vanish from the comparison entirely).
    if (compare !== "none") {
      for (const prow of priorRows) {
        if (!types.includes(prow.accountType)) continue;
        if (emitted.has(prow.accountId)) continue;
        const prior = priorByAccount.get(prow.accountId) ?? 0;
        if (prior === 0) continue;
        sectionAccounts.push({
          id: prow.accountId,
          name: prow.accountName,
          accountNumber: prow.accountNumber,
          subtype: prow.subtype,
          current: 0,
          prior,
          changeAmount: -prior,
          changePct: null,
        });
        emitted.add(prow.accountId);
        priorTotal += prior;
      }
    }

    return {
      label,
      accounts: sectionAccounts,
      total: round2(total),
      priorTotal: compare !== "none" ? round2(priorTotal) : null,
    };
  };

  const revenue = buildSection("Revenue", ["revenue"]);
  const costOfRevenue = buildSection("Cost of Revenue", ["cost_of_revenue"]);
  const expenses = buildSection("Operating Expenses", ["expense"]);
  const otherIncome = buildSection("Other Income", ["other_income"]);
  const otherExpenses = buildSection("Other Expenses", ["other_expense"]);

  const grossProfit = round2(revenue.total - costOfRevenue.total);
  const operatingIncome = round2(grossProfit - expenses.total);
  const netIncome = round2(operatingIncome + otherIncome.total - otherExpenses.total);
  const priorGrossProfit =
    revenue.priorTotal !== null && costOfRevenue.priorTotal !== null
      ? round2(revenue.priorTotal - costOfRevenue.priorTotal)
      : null;
  const priorOperatingIncome =
    priorGrossProfit !== null && expenses.priorTotal !== null
      ? round2(priorGrossProfit - expenses.priorTotal)
      : null;
  const priorNetIncome =
    priorOperatingIncome !== null
      ? round2(
          priorOperatingIncome + (otherIncome.priorTotal ?? 0) - (otherExpenses.priorTotal ?? 0),
        )
      : null;

  return {
    dateFrom,
    dateTo,
    revenue,
    costOfRevenue,
    grossProfit,
    priorGrossProfit,
    expenses,
    operatingIncome,
    priorOperatingIncome,
    otherIncome,
    otherExpenses,
    netIncome,
    priorNetIncome,
  };
}

export function buildCashFlow(rows: ReportRow[], dateFrom: string, dateTo: string) {
  const operating: Array<{
    name: string;
    amount: number;
    accountNumber: string | null;
    accountType: string;
    subtype: string | null;
  }> = [];
  const investing: typeof operating = [];
  const financing: typeof operating = [];
  /** Balance-sheet accounts no section claims — shown as a reconciling line. */
  const unclassified: typeof operating = [];
  let netOperating = 0;
  let netInvesting = 0;
  let netFinancing = 0;
  let netUnclassified = 0;

  for (const row of rows) {
    const rawBalance = Number.parseFloat(row.totalDebit) - Number.parseFloat(row.totalCredit);

    if (REVENUE_TYPES.has(row.accountType) || EXPENSE_TYPES.has(row.accountType)) {
      const amount = normalizeBalance(rawBalance, row.accountType);
      const cashImpact = REVENUE_TYPES.has(row.accountType) ? amount : -amount;
      operating.push({
        name: row.accountName,
        amount: cashImpact,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netOperating += cashImpact;
      continue;
    }

    const subtype = row.subtype ?? "";
    const amount = rawBalance;

    if (OPERATING_SUBTYPES.has(subtype)) {
      operating.push({
        name: row.accountName,
        amount: -amount,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netOperating -= amount;
    } else if (INVESTING_SUBTYPES.has(subtype)) {
      investing.push({
        name: row.accountName,
        amount: -amount,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netInvesting -= amount;
    } else if (FINANCING_SUBTYPES.has(subtype)) {
      financing.push({
        name: row.accountName,
        amount: -amount,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netFinancing -= amount;
    } else if (subtype !== "bank_accounts") {
      // Anything not claimed by a section used to fall off the statement
      // entirely, so the cash-flow statement silently stopped tying. Surface it
      // instead: a statement that visibly does not tie is a bug report, one
      // that invisibly does not tie is a restatement. `bank_accounts` is the
      // deliberate exception — it IS the cash whose net change we compute.
      unclassified.push({
        name: row.accountName,
        amount: -amount,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netUnclassified -= amount;
    }
  }

  return {
    dateFrom,
    dateTo,
    operating: { items: operating, total: round2(netOperating) },
    investing: { items: investing, total: round2(netInvesting) },
    financing: { items: financing, total: round2(netFinancing) },
    unclassified: { items: unclassified, total: round2(netUnclassified) },
    netChange: round2(netOperating + netInvesting + netFinancing + netUnclassified),
  };
}

export function buildTrialBalance(rows: ReportRow[], dateTo: string) {
  let totalDebit = 0;
  let totalCredit = 0;

  const accounts = rows.map((row) => {
    const debit = Number.parseFloat(row.totalDebit);
    const credit = Number.parseFloat(row.totalCredit);
    totalDebit += debit;
    totalCredit += credit;

    return {
      id: row.accountId,
      name: row.accountName,
      accountNumber: row.accountNumber,
      accountType: row.accountType,
      subtype: row.subtype,
      debit,
      credit,
    };
  });

  return {
    dateTo,
    accounts,
    totalDebit: round2(totalDebit),
    totalCredit: round2(totalCredit),
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
    difference: round2(totalDebit - totalCredit),
  };
}
