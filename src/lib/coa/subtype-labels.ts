/**
 * Display labels for account subtypes.
 *
 * The canonical type -> subtype grouping lives in
 * `src/db/schema/account-constants.ts`. This module supplies only the human
 * labels, and derives its option lists from that map — so a subtype added to
 * the schema constants shows up in every picker automatically, and a label for
 * a subtype that does not exist is a type error rather than dead data.
 *
 * Labels follow the reference layout in COA/subtypes/Subtypes.md.
 */
import {
  SUBTYPES_BY_TYPE,
  type AccountSubtype,
  type AccountType,
} from "../../db/schema/account-constants";

export const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  // Asset
  account_receivable: "Account Receivable",
  accrued_revenue: "Accrued Revenue",
  asset_clearing: "Asset Clearing",
  bank_accounts: "Bank Accounts",
  fixed_assets: "Fixed Assets",
  goodwill: "Goodwill",
  intangible_assets: "Intangible Assets",
  inventory: "Inventory",
  investments: "Investments",
  other_current_assets: "Other Current Assets",
  other_long_term_assets: "Other Long-Term Assets",
  prepaid_expenses: "Prepaid Expenses",
  shareholder_loans: "Shareholder Loans",
  uncategorized_assets: "Uncategorized Assets",
  // Liability
  accounts_payable: "Accounts Payable",
  accrued_expenses: "Accrued Expenses",
  convertible_notes: "Convertible Notes",
  credit_cards: "Credit Cards",
  deferred_revenue: "Deferred Revenue",
  liability_clearing: "Liability Clearing",
  long_term_debt: "Long-Term Debt",
  other_current_liabilities: "Other Current Liabilities",
  other_long_term_liabilities: "Other Long-Term Liabilities",
  payroll_liabilities: "Payroll Liabilities",
  short_term_debt: "Short-Term Debt",
  // Equity
  additional_paid_in_capital: "Additional Paid-In Capital",
  common_stock: "Common Stock",
  other_comprehensive_income: "Other Comprehensive Income",
  owners_equity: "Owner's Equity",
  preferred_stock: "Preferred Stock",
  retained_earnings: "Retained Earnings",
  safes: "SAFEs",
  treasury_stock: "Treasury Stock",
  uncategorized_equity: "Uncategorized Equity",
  // Revenue
  partner_revenue: "Partner Revenue",
  refunds_discounts: "Refunds & Discounts",
  sales_revenue: "Sales Revenue",
  subscription_revenue: "Subscription Revenue",
  transaction_revenue: "Transaction Revenue",
  uncategorized_income: "Uncategorized Income",
  // Operating expenses
  bad_debt_expense: "Bad Debt Expense",
  bank_fees: "Bank Fees",
  business_application_software: "Business Application & Software",
  facilities: "Facilities",
  general_operations: "General Operations",
  insurance: "Insurance",
  payroll_expenses: "Payroll Expenses",
  professional_fees: "Professional Fees",
  sales_marketing: "Sales & Marketing",
  supplies_and_materials: "Supplies & Materials",
  travel_entertainment: "Travel & Entertainment",
  uncategorized_expenses: "Uncategorized Expenses",
  // Cost of revenue
  cost_of_goods: "Cost of Goods",
  cost_of_labor: "Cost of Labor",
  hosting_fees: "Hosting Fees",
  other_cost_of_revenue: "Other Cost of Revenue",
  payment_processing_fees: "Payment Processing Fees",
  // Other income
  credit_card_rewards: "Credit Card Rewards",
  interests_dividends: "Interests & Dividends",
  other_miscellaneous_income: "Other Miscellaneous Income",
  // Other expenses
  depreciation_amortization: "Depreciation & Amortization",
  interest_expense: "Interest Expense",
  other_miscellaneous_expenses: "Other Miscellaneous Expenses",
  taxes: "Taxes",
};

export interface SubtypeOption {
  value: AccountSubtype;
  label: string;
}

/** The legal subtype options for a given account type, ready for a picker. */
export function subtypeOptionsForType(type: AccountType): SubtypeOption[] {
  return SUBTYPES_BY_TYPE[type].map((value) => ({ value, label: SUBTYPE_LABELS[value] }));
}

/** Label for a subtype, falling back to the raw value for unknown/legacy data. */
export function subtypeLabel(subtype: string | null | undefined): string {
  if (!subtype) return "";
  return SUBTYPE_LABELS[subtype as AccountSubtype] ?? subtype;
}

export const SUBTYPE_OPTIONS_BY_TYPE: Record<AccountType, SubtypeOption[]> = Object.fromEntries(
  (Object.keys(SUBTYPES_BY_TYPE) as AccountType[]).map((type) => [
    type,
    subtypeOptionsForType(type),
  ]),
) as Record<AccountType, SubtypeOption[]>;
