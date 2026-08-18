import { describe, it, expect } from "vitest";
import { isSubtypeLegalForType } from "@/db/schema/account-constants";
import { BASE_ACCOUNTS } from "@/lib/coa/presets";
import { flattenPresetAccounts } from "@/lib/coa/preset-types";
import {
  PH_CHART,
  PH_STAGE_ORDER,
  isInPhReservedBand,
  type PhChartStage,
} from "@/lib/tax/ph-chart";

/**
 * Independent copy of the frozen chart from docs/tax/IMPLEMENTATION-PLAN.md
 * §3.1. Deliberately NOT imported from ph-chart.ts: editing the chart without
 * editing this table is a red build, which is the point — three design tracks
 * assigned conflicting numbers to these accounts, and a silent renumber on
 * live orgs is unrecoverable once the control-account protection lands.
 *
 * Changing a tuple here requires a matching change to the plan document and a
 * migration story for any org that already applied the preset.
 */
const FROZEN: ReadonlyArray<
  readonly [
    key: string,
    accountNumber: string,
    name: string,
    accountType: string,
    subtype: string,
    parentKey: string,
    stage: PhChartStage,
  ]
> = [
  [
    "ph_cwt_receivable",
    "12600",
    "Creditable Withholding Tax Receivable",
    "asset",
    "other_current_assets",
    "assets",
    "3a",
  ],
  [
    "ph_creditable_vat_withheld",
    "12610",
    "Creditable VAT Withheld",
    "asset",
    "other_current_assets",
    "assets",
    "6",
  ],
  [
    "ph_employee_advances",
    "12700",
    "Employee Advances & Receivables",
    "asset",
    "other_current_assets",
    "assets",
    "5b",
  ],
  [
    "ph_employee_tax_advanced",
    "12800",
    "Employee Receivable - Tax Advanced",
    "asset",
    "other_current_assets",
    "assets",
    "5b",
  ],
  ["ph_input_vat", "13800", "Input VAT", "asset", "other_current_assets", "assets", "3b"],
  [
    "ph_input_vat_unpaid",
    "13810",
    "Input VAT - Unpaid Payables",
    "asset",
    "other_current_assets",
    "ph_input_vat",
    "3b",
  ],
  [
    "ph_ewt_payable",
    "21600",
    "Expanded Withholding Tax Payable",
    "liability",
    "other_current_liabilities",
    "liabilities",
    "3b",
  ],
  [
    "ph_output_vat",
    "21700",
    "Output VAT",
    "liability",
    "other_current_liabilities",
    "liabilities",
    "6",
  ],
  [
    "ph_output_vat_uncollected",
    "21710",
    "Output VAT - Uncollected Receivables",
    "liability",
    "other_current_liabilities",
    "ph_output_vat",
    "6",
  ],
  [
    "ph_vat_payable_net",
    "21750",
    "VAT Payable - Net",
    "liability",
    "other_current_liabilities",
    "liabilities",
    "6",
  ],
  [
    "ph_percentage_tax_payable",
    "21800",
    "Percentage Tax Payable",
    "liability",
    "other_current_liabilities",
    "liabilities",
    "7",
  ],
  [
    "ph_wtc_payable",
    "25110",
    "Withholding Tax on Compensation Payable",
    "liability",
    "payroll_liabilities",
    "payroll_liabilities",
    "5b",
  ],
  [
    "ph_sss_payable",
    "25120",
    "SSS Contributions Payable",
    "liability",
    "payroll_liabilities",
    "payroll_liabilities",
    "5b",
  ],
  [
    "ph_philhealth_payable",
    "25130",
    "PhilHealth Contributions Payable",
    "liability",
    "payroll_liabilities",
    "payroll_liabilities",
    "5b",
  ],
  [
    "ph_pagibig_payable",
    "25140",
    "Pag-IBIG (HDMF) Contributions Payable",
    "liability",
    "payroll_liabilities",
    "payroll_liabilities",
    "5b",
  ],
  [
    "ph_net_pay_payable",
    "25170",
    "Net Pay Payable",
    "liability",
    "payroll_liabilities",
    "payroll_liabilities",
    "5b",
  ],
  [
    "ph_employee_tax_refund_payable",
    "25175",
    "Employee Tax Refund Payable",
    "liability",
    "payroll_liabilities",
    "payroll_liabilities",
    "5b",
  ],
  [
    "ph_unrecovered_employee_tax",
    "61950",
    "Unrecovered Employee Tax",
    "expense",
    "payroll_expenses",
    "payroll_expenses",
    "5b",
  ],
  [
    "ph_input_vat_exempt_expense",
    "68400",
    "Input VAT Attributable to Exempt Sales",
    "expense",
    "general_operations",
    "general_operations",
    "6",
  ],
  [
    "ph_percentage_tax_expense",
    "94100",
    "Percentage Tax Expense",
    "other_expense",
    "taxes",
    "taxes",
    "7",
  ],
];

describe("frozen PH chart (IMPLEMENTATION-PLAN.md §3.1)", () => {
  it("matches the frozen tuple set exactly", () => {
    const actual = PH_CHART.map(
      (e) =>
        [e.key, e.accountNumber, e.name, e.accountType, e.subtype, e.parentKey, e.stage] as const,
    );
    expect(actual).toEqual(FROZEN);
  });

  it("has unique keys and unique account numbers", () => {
    const keys = PH_CHART.map((e) => e.key);
    const numbers = PH_CHART.map((e) => e.accountNumber);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("keeps every account inside a reserved band", () => {
    const outside = PH_CHART.filter((e) => !isInPhReservedBand(e.accountNumber));
    expect(outside.map((e) => `${e.key} (${e.accountNumber})`)).toEqual([]);
  });

  it("pairs every subtype legally with its account type", () => {
    const illegal = PH_CHART.filter((e) => !isSubtypeLegalForType(e.accountType, e.subtype));
    expect(illegal.map((e) => `${e.key}: ${e.accountType}/${e.subtype}`)).toEqual([]);
  });

  it("resolves every parent key to BASE_ACCOUNTS or an earlier-or-same-stage ph_* entry", () => {
    const baseKeys = new Set(flattenPresetAccounts(BASE_ACCOUNTS).map((n) => n.account.key));
    const phByKey = new Map(PH_CHART.map((e) => [e.key, e]));

    for (const entry of PH_CHART) {
      const phParent = phByKey.get(entry.parentKey);
      if (phParent) {
        // A child control account must not be introduced before its parent
        // exists — the preset applier would have nowhere to hang it.
        expect(
          PH_STAGE_ORDER[phParent.stage],
          `${entry.key} (stage ${entry.stage}) parents ${phParent.key} (stage ${phParent.stage})`,
        ).toBeLessThanOrEqual(PH_STAGE_ORDER[entry.stage]);
      } else {
        expect(
          baseKeys.has(entry.parentKey),
          `${entry.key} parents unknown key ${entry.parentKey}`,
        ).toBe(true);
      }
    }
  });
});
