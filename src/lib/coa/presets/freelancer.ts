import type { CoaPreset, PresetAccount } from "../preset-types";
import { pruneToKeys, withChildren } from "../tree-ops";
import { BASE_ACCOUNTS } from "./base";
import { BASE_MAPPINGS } from "./base-mappings";

/**
 * Accounts a solo operator actually uses.
 *
 * This is the floor rather than a taste call: every account named by a mapping
 * row must survive the prune, or the preset cannot satisfy the completeness
 * guarantee. Everything else — payroll sub-accounts, travel breakdowns, fixed
 * asset detail — is dropped.
 */
const KEEP = new Set([
  // Assets
  "bank_accounts",
  "asset_clearing",
  "accounts_receivable",
  "investments",
  "uncategorized_assets",
  // Liabilities
  "accounts_payable",
  "credit_cards",
  "sales_tax_payable",
  "other_current_liabilities",
  "uncategorized_liabilities",
  // Equity
  "owners_equity",
  "retained_earnings",
  // Revenue
  "sales_revenue",
  "refunds_and_discounts",
  // Cost of revenue
  "cost_of_goods_sold",
  "payment_processing_fees",
  "hosting_fees",
  // Operating expenses
  "professional_fees",
  "business_applications_and_software",
  "facilities",
  "general_operations",
  "insurance",
  "supplies_and_materials",
  "uncategorized_expense",
  // Other
  "interest_expense",
  "taxes",
  "other_miscellaneous_expenses",
]);

const EQUITY_ADDITIONS: PresetAccount[] = [
  {
    key: "freelancer_owners_draw",
    name: "Owner's Draw",
    accountNumber: "32500",
    accountType: "equity",
    subtype: "owners_equity",
    icon: "Wallet",
    description: "Money the owner takes out of the business for personal use",
  },
];

const REVENUE_ADDITIONS: PresetAccount[] = [
  {
    key: "freelancer_contract_income",
    name: "Contract & Freelance Income",
    accountNumber: "41500",
    accountType: "revenue",
    subtype: "sales_revenue",
    icon: "FileText",
    description: "Fees billed for client project and retainer work",
  },
];

const EXPENSE_ADDITIONS: PresetAccount[] = [
  {
    key: "freelancer_home_office",
    name: "Home Office",
    accountNumber: "66500",
    accountType: "expense",
    subtype: "facilities",
    icon: "Home",
    description: "Business-use portion of home rent, utilities, and internet",
  },
];

const OTHER_EXPENSE_ADDITIONS: PresetAccount[] = [
  {
    key: "freelancer_self_employment_tax",
    name: "Self-Employment Tax",
    accountNumber: "94500",
    accountType: "other_expense",
    subtype: "taxes",
    icon: "Bank",
    description: "Self-employment and estimated income tax paid by the owner",
  },
];

export const FREELANCER: CoaPreset = {
  id: "freelancer",
  version: 1,
  label: "Freelancer / consultant",
  description:
    "A slim chart for a solo operator: owner's draw and equity, contract income, home office, self-employment tax, and minimal cost of revenue. No payroll or fixed-asset detail.",
  industries: ["professional_services"],
  accounts: withChildren(pruneToKeys(BASE_ACCOUNTS, KEEP), {
    equity: EQUITY_ADDITIONS,
    revenue: REVENUE_ADDITIONS,
    operating_expenses: EXPENSE_ADDITIONS,
    other_expenses: OTHER_EXPENSE_ADDITIONS,
  }),
  mappings: BASE_MAPPINGS,
  entities: [],
};
