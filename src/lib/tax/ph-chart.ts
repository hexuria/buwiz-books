/**
 * The frozen Philippine BIR control-account chart.
 *
 * Frozen in docs/tax/IMPLEMENTATION-PLAN.md §3.1 after three design tracks
 * assigned conflicting numbers to the same accounts (12600 meant two different
 * accounts; 25110/25140 swapped meanings between tracks). Code references
 * these accounts by KEY only — never by number — and the philippines_smb
 * preset introduces each account at the stage recorded here, not all at once.
 *
 * tests/unit/lib/coa/ph-chart-lock.test.ts holds an independent copy of these
 * tuples: changing this file without changing the lock test is a red build by
 * design. tests/unit/lib/coa/ph-number-reservation.test.ts keeps every other
 * preset out of the reserved bands.
 */
import type { AccountSubtype, AccountType } from "../../db/schema/account-constants";

/** Stage of docs/tax/IMPLEMENTATION-PLAN.md §5 that first creates the account. */
export type PhChartStage = "3a" | "3b" | "5b" | "6" | "7";

/** Stage ordinals, for "a child is never introduced before its parent" checks. */
export const PH_STAGE_ORDER: Record<PhChartStage, number> = {
  "3a": 1,
  "3b": 2,
  "5b": 3,
  "6": 4,
  "7": 5,
};

export interface PhChartEntry {
  /** Stable preset-local key. The only way code may reference the account. */
  key: string;
  /** 5-digit account number inside a reserved PH band. Frozen — see the lock test. */
  accountNumber: string;
  name: string;
  accountType: AccountType;
  subtype: AccountSubtype;
  /**
   * Parent account key: either a BASE_ACCOUNTS key (`assets`,
   * `payroll_liabilities`, …) or a `ph_*` key from this chart.
   */
  parentKey: string;
  stage: PhChartStage;
}

/**
 * Number bands reserved for PH control accounts. No other preset may place an
 * account inside them — enforced by ph-number-reservation.test.ts, so a future
 * pack colliding here is a red build instead of a silent renumber by
 * plan-preset's nextFreeNumber.
 */
export const PH_RESERVED_BANDS: ReadonlyArray<readonly [number, number]> = [
  [12600, 12699],
  [12700, 12899],
  [13800, 13899],
  [21600, 21999],
  [25110, 25199],
  [61900, 61999],
  [68400, 68499],
  [94100, 94199],
];

export function isInPhReservedBand(accountNumber: string): boolean {
  const n = Number.parseInt(accountNumber, 10);
  if (Number.isNaN(n)) return false;
  return PH_RESERVED_BANDS.some(([from, to]) => n >= from && n <= to);
}

export const PH_CHART: readonly PhChartEntry[] = [
  {
    key: "ph_cwt_receivable",
    accountNumber: "12600",
    name: "Creditable Withholding Tax Receivable",
    accountType: "asset",
    subtype: "other_current_assets",
    parentKey: "assets",
    stage: "3a",
  },
  {
    key: "ph_creditable_vat_withheld",
    accountNumber: "12610",
    name: "Creditable VAT Withheld",
    accountType: "asset",
    subtype: "other_current_assets",
    parentKey: "assets",
    stage: "6",
  },
  {
    key: "ph_employee_advances",
    accountNumber: "12700",
    name: "Employee Advances & Receivables",
    accountType: "asset",
    subtype: "other_current_assets",
    parentKey: "assets",
    stage: "5b",
  },
  {
    key: "ph_employee_tax_advanced",
    accountNumber: "12800",
    name: "Employee Receivable - Tax Advanced",
    accountType: "asset",
    subtype: "other_current_assets",
    parentKey: "assets",
    stage: "5b",
  },
  {
    key: "ph_input_vat",
    accountNumber: "13800",
    name: "Input VAT",
    accountType: "asset",
    subtype: "other_current_assets",
    parentKey: "assets",
    stage: "3b",
  },
  {
    key: "ph_input_vat_unpaid",
    accountNumber: "13810",
    name: "Input VAT - Unpaid Payables",
    accountType: "asset",
    subtype: "other_current_assets",
    parentKey: "ph_input_vat",
    stage: "3b",
  },
  {
    key: "ph_ewt_payable",
    accountNumber: "21600",
    name: "Expanded Withholding Tax Payable",
    accountType: "liability",
    subtype: "other_current_liabilities",
    parentKey: "liabilities",
    stage: "3b",
  },
  {
    key: "ph_output_vat",
    accountNumber: "21700",
    name: "Output VAT",
    accountType: "liability",
    subtype: "other_current_liabilities",
    parentKey: "liabilities",
    stage: "6",
  },
  {
    key: "ph_output_vat_uncollected",
    accountNumber: "21710",
    name: "Output VAT - Uncollected Receivables",
    accountType: "liability",
    subtype: "other_current_liabilities",
    parentKey: "ph_output_vat",
    stage: "6",
  },
  {
    key: "ph_vat_payable_net",
    accountNumber: "21750",
    name: "VAT Payable - Net",
    accountType: "liability",
    subtype: "other_current_liabilities",
    parentKey: "liabilities",
    stage: "6",
  },
  {
    key: "ph_percentage_tax_payable",
    accountNumber: "21800",
    name: "Percentage Tax Payable",
    accountType: "liability",
    subtype: "other_current_liabilities",
    parentKey: "liabilities",
    stage: "7",
  },
  {
    key: "ph_wtc_payable",
    accountNumber: "25110",
    name: "Withholding Tax on Compensation Payable",
    accountType: "liability",
    subtype: "payroll_liabilities",
    parentKey: "payroll_liabilities",
    stage: "5b",
  },
  {
    key: "ph_sss_payable",
    accountNumber: "25120",
    name: "SSS Contributions Payable",
    accountType: "liability",
    subtype: "payroll_liabilities",
    parentKey: "payroll_liabilities",
    stage: "5b",
  },
  {
    key: "ph_philhealth_payable",
    accountNumber: "25130",
    name: "PhilHealth Contributions Payable",
    accountType: "liability",
    subtype: "payroll_liabilities",
    parentKey: "payroll_liabilities",
    stage: "5b",
  },
  {
    key: "ph_pagibig_payable",
    accountNumber: "25140",
    name: "Pag-IBIG (HDMF) Contributions Payable",
    accountType: "liability",
    subtype: "payroll_liabilities",
    parentKey: "payroll_liabilities",
    stage: "5b",
  },
  {
    key: "ph_net_pay_payable",
    accountNumber: "25170",
    name: "Net Pay Payable",
    accountType: "liability",
    subtype: "payroll_liabilities",
    parentKey: "payroll_liabilities",
    stage: "5b",
  },
  {
    key: "ph_employee_tax_refund_payable",
    accountNumber: "25175",
    name: "Employee Tax Refund Payable",
    accountType: "liability",
    subtype: "payroll_liabilities",
    parentKey: "payroll_liabilities",
    stage: "5b",
  },
  {
    key: "ph_unrecovered_employee_tax",
    accountNumber: "61950",
    name: "Unrecovered Employee Tax",
    accountType: "expense",
    subtype: "payroll_expenses",
    parentKey: "payroll_expenses",
    stage: "5b",
  },
  {
    key: "ph_input_vat_exempt_expense",
    accountNumber: "68400",
    name: "Input VAT Attributable to Exempt Sales",
    accountType: "expense",
    subtype: "general_operations",
    parentKey: "general_operations",
    stage: "6",
  },
  {
    key: "ph_percentage_tax_expense",
    accountNumber: "94100",
    name: "Percentage Tax Expense",
    accountType: "other_expense",
    subtype: "taxes",
    parentKey: "taxes",
    stage: "7",
  },
];
