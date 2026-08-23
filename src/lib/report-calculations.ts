import { normalizeBalance } from "./report-utils";
import { moneyToCents } from "@/lib/money";

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

/**
 * Exact net (debit − credit) of a report row in INTEGER CENTS (audit PR-15).
 * Every builder below accumulates cents and divides by 100 only on the
 * emitted objects, so section totals are sums of integers — parseFloat plus
 * round2-per-step let representation error accumulate across large charts.
 * normalizeBalance is a pure sign flip, so it works on cents unchanged.
 */
function rowNetCents(row: { totalDebit: string; totalCredit: string }): number {
  return moneyToCents(row.totalDebit, "totalDebit") - moneyToCents(row.totalCredit, "totalCredit");
}

function buildBalanceSheetSections(rows: ReportRow[]) {
  const sections: Record<string, BalanceSheetSection> = {
    asset: { label: "Assets", accounts: [], total: 0 },
    liability: { label: "Liabilities", accounts: [], total: 0 },
    equity: { label: "Equity", accounts: [], total: 0 },
  };

  let netIncomeCents = 0;
  const totalsCents: Record<string, number> = { asset: 0, liability: 0, equity: 0 };

  for (const row of rows) {
    const section = sections[row.accountType];
    const rawCents = rowNetCents(row);

    if (!section) {
      const normalizedCents = normalizeBalance(rawCents, row.accountType);
      if (REVENUE_TYPES.has(row.accountType)) {
        netIncomeCents += normalizedCents;
      } else if (EXPENSE_TYPES.has(row.accountType)) {
        netIncomeCents -= normalizedCents;
      }
      continue;
    }

    const balanceCents = normalizeBalance(rawCents, row.accountType);
    section.accounts.push({
      id: row.accountId,
      name: row.accountName,
      accountNumber: row.accountNumber,
      subtype: row.subtype,
      balance: balanceCents / 100,
    });
    totalsCents[row.accountType] += balanceCents;
  }

  if (netIncomeCents !== 0) {
    sections.equity.accounts.push({
      id: "net-income",
      name: "Net Income",
      accountNumber: null,
      subtype: null,
      balance: netIncomeCents / 100,
    });
    totalsCents.equity += netIncomeCents;
  }

  for (const key of Object.keys(sections)) {
    sections[key].total = totalsCents[key] / 100;
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
    totalLiabilitiesAndEquity:
      (Math.round(sections.liability.total * 100) + Math.round(sections.equity.total * 100)) / 100,
  };
}

export function buildProfitLoss(
  rows: ReportRow[],
  dateFrom: string,
  dateTo: string,
  compare: string = "none",
  priorRows: ReportRow[] = [],
) {
  // Prior balances in integer cents, keyed by account.
  const priorCentsByAccount = new Map<string, number>();
  for (const row of priorRows) {
    priorCentsByAccount.set(row.accountId, normalizeBalance(rowNetCents(row), row.accountType));
  }

  const buildSection = (label: string, types: string[]): ProfitLossSection => {
    const sectionAccounts: ProfitLossSection["accounts"] = [];
    let totalCents = 0;
    let priorTotalCents = 0;
    const emitted = new Set<string>();

    for (const row of rows) {
      if (!types.includes(row.accountType)) continue;
      const currentCents = normalizeBalance(rowNetCents(row), row.accountType);
      const current = currentCents / 100;
      const priorCents = priorCentsByAccount.has(row.accountId)
        ? priorCentsByAccount.get(row.accountId)!
        : null;
      const prior = priorCents !== null ? priorCents / 100 : null;
      const changeAmount = priorCents !== null ? (currentCents - priorCents) / 100 : null;
      const changePct =
        priorCents !== null && priorCents !== 0
          ? ((currentCents - priorCents) / Math.abs(priorCents)) * 100
          : null;

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
      totalCents += currentCents;
      if (priorCents !== null) priorTotalCents += priorCents;
    }

    // Prior-only accounts: had activity in the prior period but none this period. Without
    // this they'd be silently dropped, understating priorTotal (e.g. rent paid last month,
    // none this month, would vanish from the comparison entirely).
    if (compare !== "none") {
      for (const prow of priorRows) {
        if (!types.includes(prow.accountType)) continue;
        if (emitted.has(prow.accountId)) continue;
        const priorCents = priorCentsByAccount.get(prow.accountId) ?? 0;
        if (priorCents === 0) continue;
        sectionAccounts.push({
          id: prow.accountId,
          name: prow.accountName,
          accountNumber: prow.accountNumber,
          subtype: prow.subtype,
          current: 0,
          prior: priorCents / 100,
          changeAmount: -priorCents / 100,
          changePct: null,
        });
        emitted.add(prow.accountId);
        priorTotalCents += priorCents;
      }
    }

    return {
      label,
      accounts: sectionAccounts,
      total: totalCents / 100,
      priorTotal: compare !== "none" ? priorTotalCents / 100 : null,
    };
  };

  const revenue = buildSection("Revenue", ["revenue"]);
  const costOfRevenue = buildSection("Cost of Revenue", ["cost_of_revenue"]);
  const expenses = buildSection("Operating Expenses", ["expense"]);
  const otherIncome = buildSection("Other Income", ["other_income"]);
  const otherExpenses = buildSection("Other Expenses", ["other_expense"]);

  // Section totals are exact multiples of 0.01; derive the roll-ups in cents.
  const cents = (value: number) => Math.round(value * 100);
  const grossProfitCents = cents(revenue.total) - cents(costOfRevenue.total);
  const grossProfit = grossProfitCents / 100;
  const operatingIncomeCents = grossProfitCents - cents(expenses.total);
  const operatingIncome = operatingIncomeCents / 100;
  const netIncome =
    (operatingIncomeCents + cents(otherIncome.total) - cents(otherExpenses.total)) / 100;
  const priorGrossProfitCents =
    revenue.priorTotal !== null && costOfRevenue.priorTotal !== null
      ? cents(revenue.priorTotal) - cents(costOfRevenue.priorTotal)
      : null;
  const priorGrossProfit = priorGrossProfitCents !== null ? priorGrossProfitCents / 100 : null;
  const priorOperatingIncomeCents =
    priorGrossProfitCents !== null && expenses.priorTotal !== null
      ? priorGrossProfitCents - cents(expenses.priorTotal)
      : null;
  const priorOperatingIncome =
    priorOperatingIncomeCents !== null ? priorOperatingIncomeCents / 100 : null;
  const priorNetIncome =
    priorOperatingIncomeCents !== null
      ? (priorOperatingIncomeCents +
          cents(otherIncome.priorTotal ?? 0) -
          cents(otherExpenses.priorTotal ?? 0)) /
        100
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
  let netOperatingCents = 0;
  let netInvestingCents = 0;
  let netFinancingCents = 0;
  let netUnclassifiedCents = 0;

  for (const row of rows) {
    const rawCents = rowNetCents(row);

    if (REVENUE_TYPES.has(row.accountType) || EXPENSE_TYPES.has(row.accountType)) {
      const amountCents = normalizeBalance(rawCents, row.accountType);
      const cashImpactCents = REVENUE_TYPES.has(row.accountType) ? amountCents : -amountCents;
      operating.push({
        name: row.accountName,
        amount: cashImpactCents / 100,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netOperatingCents += cashImpactCents;
      continue;
    }

    const subtype = row.subtype ?? "";
    const amountCents = rawCents;

    if (OPERATING_SUBTYPES.has(subtype)) {
      operating.push({
        name: row.accountName,
        amount: -amountCents / 100,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netOperatingCents -= amountCents;
    } else if (INVESTING_SUBTYPES.has(subtype)) {
      investing.push({
        name: row.accountName,
        amount: -amountCents / 100,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netInvestingCents -= amountCents;
    } else if (FINANCING_SUBTYPES.has(subtype)) {
      financing.push({
        name: row.accountName,
        amount: -amountCents / 100,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netFinancingCents -= amountCents;
    } else if (subtype !== "bank_accounts") {
      // Anything not claimed by a section used to fall off the statement
      // entirely, so the cash-flow statement silently stopped tying. Surface it
      // instead: a statement that visibly does not tie is a bug report, one
      // that invisibly does not tie is a restatement. `bank_accounts` is the
      // deliberate exception — it IS the cash whose net change we compute.
      unclassified.push({
        name: row.accountName,
        amount: -amountCents / 100,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        subtype: row.subtype,
      });
      netUnclassifiedCents -= amountCents;
    }
  }

  return {
    dateFrom,
    dateTo,
    operating: { items: operating, total: netOperatingCents / 100 },
    investing: { items: investing, total: netInvestingCents / 100 },
    financing: { items: financing, total: netFinancingCents / 100 },
    unclassified: { items: unclassified, total: netUnclassifiedCents / 100 },
    netChange:
      (netOperatingCents + netInvestingCents + netFinancingCents + netUnclassifiedCents) / 100,
  };
}

export function buildTrialBalance(rows: ReportRow[], dateTo: string) {
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  const accounts = rows.map((row) => {
    const debitCents = moneyToCents(row.totalDebit, "totalDebit");
    const creditCents = moneyToCents(row.totalCredit, "totalCredit");
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;

    return {
      id: row.accountId,
      name: row.accountName,
      accountNumber: row.accountNumber,
      accountType: row.accountType,
      subtype: row.subtype,
      debit: debitCents / 100,
      credit: creditCents / 100,
    };
  });

  return {
    dateTo,
    accounts,
    totalDebit: totalDebitCents / 100,
    totalCredit: totalCreditCents / 100,
    // Exact: balanced means the CENTS agree, not "within a float epsilon".
    isBalanced: totalDebitCents === totalCreditCents,
    difference: (totalDebitCents - totalCreditCents) / 100,
  };
}
