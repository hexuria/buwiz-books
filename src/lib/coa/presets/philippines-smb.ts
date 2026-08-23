/**
 * Philippine SMB pack — the base chart plus the 20 frozen BIR control
 * accounts from `PH_CHART`.
 *
 * The account list is DERIVED from PH_CHART at module load rather than
 * hand-copied, so the preset cannot drift from the frozen chart:
 * `requirePhAccount` resolves these accounts by their exact frozen numbers,
 * and a divergence here would strand every PH posting path behind
 * MissingPhAccountError — which is precisely the state this preset exists to
 * end (until it shipped, the error message named a preset that did not
 * exist).
 *
 * PH accounts deliberately do NOT go through `category_mappings`: adding a
 * mapping type would make every shipped preset fail the global completeness
 * check (see ph-account-resolver.ts, "WHY NOT category_mappings"). BASE_MAPPINGS
 * satisfies both completeness gates; the PH accounts ride alongside.
 *
 * The per-stage rollout note in ph-chart.ts predates 0037–0047 all landing;
 * with every stage's tables merged, the preset ships all 20 at once.
 */
import type { CoaPreset, PresetAccount } from "../preset-types";
import { withChildren } from "../tree-ops";
import { BASE_ACCOUNTS } from "./base";
import { BASE_MAPPINGS } from "./base-mappings";
import { PH_CHART, type PhChartEntry } from "@/lib/tax/ph-chart";

/** Icons by chart key; anything unlisted gets the neutral document icon. */
const PH_ICONS: Record<string, string> = {
  ph_cwt_receivable: "Receipt",
  ph_creditable_vat_withheld: "Receipt",
  ph_employee_advances: "HandCoins",
  ph_employee_tax_advanced: "HandCoins",
  ph_input_vat: "Percent",
  ph_input_vat_unpaid: "Percent",
  ph_ewt_payable: "FileMinus",
  ph_output_vat: "Percent",
  ph_output_vat_uncollected: "Percent",
  ph_vat_payable_net: "Percent",
  ph_percentage_tax_payable: "Percent",
  ph_wtc_payable: "Users",
  ph_sss_payable: "Users",
  ph_philhealth_payable: "Users",
  ph_pagibig_payable: "Users",
  ph_net_pay_payable: "Wallet",
  ph_employee_tax_refund_payable: "Undo2",
  ph_unrecovered_employee_tax: "FileMinus",
  ph_input_vat_exempt_expense: "Percent",
  ph_percentage_tax_expense: "Percent",
};

function toPresetAccount(entry: PhChartEntry): PresetAccount {
  return {
    key: entry.key,
    name: entry.name,
    accountNumber: entry.accountNumber,
    accountType: entry.accountType,
    subtype: entry.subtype,
    icon: PH_ICONS[entry.key] ?? "FileText",
    description: `BIR control account (frozen number ${entry.accountNumber}); resolved by requirePhAccount, do not renumber.`,
  };
}

/**
 * Group PH_CHART by parentKey, nesting entries whose parent is itself a PH
 * account (Input VAT → unpaid sub-account, Output VAT → uncollected).
 */
function buildAdditions(): Record<string, PresetAccount[]> {
  const phKeys = new Set(PH_CHART.map((entry) => entry.key));
  const byKey = new Map<string, PresetAccount>();
  for (const entry of PH_CHART) byKey.set(entry.key, toPresetAccount(entry));

  const additions: Record<string, PresetAccount[]> = {};
  for (const entry of PH_CHART) {
    const node = byKey.get(entry.key)!;
    if (phKeys.has(entry.parentKey)) {
      const parent = byKey.get(entry.parentKey)!;
      // PresetAccount.children is readonly — build via a mutable copy.
      byKey.set(entry.parentKey, {
        ...parent,
        children: [...(parent.children ?? []), node],
      });
      // Re-point references so later nesting under the SAME parent sees the child.
      continue;
    }
    (additions[entry.parentKey] ??= []).push(node);
  }

  // The loop above pushed nodes into `additions` BEFORE their own children
  // were attached (byKey holds the updated copies). Re-read from byKey so the
  // emitted tree carries the nested children.
  for (const parentKey of Object.keys(additions)) {
    additions[parentKey] = additions[parentKey].map((node) => byKey.get(node.key)!);
  }
  return additions;
}

export const PHILIPPINES_SMB: CoaPreset = {
  id: "philippines_smb",
  version: 1,
  label: "Philippines SMB (BIR)",
  description:
    "The general small-business chart plus the frozen Philippine BIR control accounts for withholding, VAT, percentage tax and payroll compliance.",
  industries: ["philippines_smb"],
  accounts: withChildren(BASE_ACCOUNTS, buildAdditions()),
  mappings: BASE_MAPPINGS,
  entities: [],
};
