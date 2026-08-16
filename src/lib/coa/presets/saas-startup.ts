import type { CoaPreset, PresetAccount } from "../preset-types";
import { withChildren } from "../tree-ops";
import { BASE_ACCOUNTS } from "./base";
import { BASE_MAPPINGS } from "./base-mappings";

const REVENUE_ADDITIONS: PresetAccount[] = [
  {
    key: "saas_expansion_revenue",
    name: "Expansion Revenue",
    accountNumber: "44000",
    accountType: "revenue",
    subtype: "subscription_revenue",
    icon: "TrendingUp",
    description: "Upgrades, seat expansion, and add-ons on existing subscriptions",
  },
  {
    key: "saas_partner_revenue",
    name: "Partner & Reseller Revenue",
    accountNumber: "45000",
    accountType: "revenue",
    subtype: "partner_revenue",
    icon: "Users",
    description: "Revenue earned through channel partners, resellers, and marketplaces",
  },
];

const COST_OF_REVENUE_ADDITIONS: PresetAccount[] = [
  {
    key: "saas_third_party_apis",
    name: "Third-Party APIs & Data",
    accountNumber: "55000",
    accountType: "cost_of_revenue",
    subtype: "other_cost_of_revenue",
    icon: "Code",
    description: "Metered third-party services consumed to deliver the product",
  },
  {
    key: "saas_customer_success",
    name: "Customer Success & Support",
    accountNumber: "56000",
    accountType: "cost_of_revenue",
    subtype: "cost_of_labor",
    icon: "Users",
    description: "Support and onboarding staff costs attributable to delivering the service",
  },
];

const EXPENSE_ADDITIONS: PresetAccount[] = [
  {
    key: "saas_research_development",
    name: "Research & Development",
    accountNumber: "69000",
    accountType: "expense",
    subtype: "payroll_expenses",
    icon: "Code",
    description: "Engineering and product salaries not attributable to cost of revenue",
  },
];

const LIABILITY_ADDITIONS: PresetAccount[] = [
  {
    key: "saas_customer_deposits",
    name: "Customer Deposits",
    accountNumber: "27000",
    accountType: "liability",
    subtype: "other_current_liabilities",
    icon: "Bank",
    description: "Prepayments held before the related subscription period begins",
  },
  {
    key: "saas_convertible_notes",
    name: "Convertible Notes",
    accountNumber: "28000",
    accountType: "liability",
    subtype: "convertible_notes",
    icon: "FileText",
    description: "Convertible debt instruments pending conversion to equity",
  },
];

const EQUITY_ADDITIONS: PresetAccount[] = [
  {
    key: "saas_additional_paid_in_capital",
    name: "Additional Paid-In Capital",
    accountNumber: "34000",
    accountType: "equity",
    subtype: "additional_paid_in_capital",
    icon: "TrendingUp",
    description: "Capital raised above par value in priced rounds",
  },
];

/**
 * SaaS / startup.
 *
 * `convertible_notes` is a LIABILITY subtype in this schema, so notes sit under
 * Liabilities; `safes` (already in the baseline chart) is the equity-side
 * instrument. Both land in the financing section of the cash-flow statement.
 */
export const SAAS_STARTUP: CoaPreset = {
  id: "saas_startup",
  version: 1,
  label: "SaaS / startup",
  description:
    "Subscription and expansion revenue, hosting and payment-processing cost of revenue, deferred revenue, SAFEs and convertible notes, and a separate R&D line.",
  industries: ["technology"],
  accounts: withChildren(BASE_ACCOUNTS, {
    revenue: REVENUE_ADDITIONS,
    cost_of_revenue: COST_OF_REVENUE_ADDITIONS,
    operating_expenses: EXPENSE_ADDITIONS,
    liabilities: LIABILITY_ADDITIONS,
    equity: EQUITY_ADDITIONS,
  }),
  mappings: BASE_MAPPINGS,
  entities: [],
};
