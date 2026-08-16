/**
 * Account Constants — Single source of truth for valid values
 *
 * These replace pgEnum declarations. Validation happens at the app level (Zod)
 * rather than the database level (enum types), making schema evolution safer.
 */

// 8 root account types based on standard accounting types
export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense", // API label: "Expenses (Operating)"
  "cost_of_revenue",
  "other_income",
  "other_expense",
] as const;

export const ACCOUNT_STATUSES = ["active", "inactive", "deactivated", "archived"] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Which subtypes are legal for which account type.
 *
 * This is the canonical grouping. `ACCOUNT_SUBTYPES` is DERIVED from it below,
 * so the flat list and the grouping can never drift apart. Anything that needs
 * "the subtypes for this type" (forms, filters, validators, presets) must read
 * this map rather than hand-maintaining its own copy — divergent copies are how
 * invalid subtypes like `accounts_receivable` (canonical: `account_receivable`)
 * end up offered in a picker.
 *
 * Subtypes are classification labels, NOT categories.
 */
export const SUBTYPES_BY_TYPE = {
  asset: [
    "account_receivable",
    "accrued_revenue",
    "asset_clearing",
    "bank_accounts",
    "fixed_assets",
    "goodwill",
    "intangible_assets",
    "inventory",
    "investments",
    "other_current_assets",
    "other_long_term_assets",
    "prepaid_expenses",
    "shareholder_loans",
    "uncategorized_assets",
  ],
  liability: [
    "accounts_payable",
    "accrued_expenses",
    "convertible_notes",
    "credit_cards",
    "deferred_revenue",
    "liability_clearing",
    "long_term_debt",
    "other_current_liabilities",
    "other_long_term_liabilities",
    "payroll_liabilities",
    "short_term_debt",
  ],
  equity: [
    "additional_paid_in_capital",
    "common_stock",
    "other_comprehensive_income",
    "owners_equity",
    "preferred_stock",
    "retained_earnings",
    "safes",
    "treasury_stock",
    "uncategorized_equity",
  ],
  revenue: [
    "partner_revenue",
    "refunds_discounts",
    "sales_revenue",
    "subscription_revenue",
    "transaction_revenue",
    "uncategorized_income",
  ],
  expense: [
    "bad_debt_expense",
    "bank_fees",
    "business_application_software",
    "facilities",
    "general_operations",
    "insurance",
    "payroll_expenses",
    "professional_fees",
    "sales_marketing",
    "supplies_and_materials",
    "travel_entertainment",
    "uncategorized_expenses",
  ],
  cost_of_revenue: [
    "cost_of_goods",
    "cost_of_labor",
    "hosting_fees",
    "other_cost_of_revenue",
    "payment_processing_fees",
  ],
  other_income: ["credit_card_rewards", "interests_dividends", "other_miscellaneous_income"],
  other_expense: [
    "depreciation_amortization",
    "interest_expense",
    "other_miscellaneous_expenses",
    "taxes",
  ],
} as const satisfies Record<AccountType, readonly string[]>;

export type AccountSubtype = (typeof SUBTYPES_BY_TYPE)[AccountType][number];

/** Flat list of every valid subtype. Derived — never edit directly. */
export const ACCOUNT_SUBTYPES: readonly AccountSubtype[] = Object.values(SUBTYPES_BY_TYPE).flat();

/** Reverse lookup: subtype -> the account type it belongs to. */
export const SUBTYPE_TO_TYPE: Record<AccountSubtype, AccountType> = Object.fromEntries(
  ACCOUNT_TYPES.flatMap((type) => SUBTYPES_BY_TYPE[type].map((subtype) => [subtype, type])),
) as Record<AccountSubtype, AccountType>;

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** True when `subtype` is a legal classification for `type`. */
export function isSubtypeLegalForType(type: string, subtype: string): subtype is AccountSubtype {
  if (!isAccountType(type)) return false;
  return (SUBTYPES_BY_TYPE[type] as readonly string[]).includes(subtype);
}

/**
 * The "uncategorized" bucket subtype for a type, used as a deterministic repair
 * target when a supplied subtype is illegal. Types without a dedicated bucket
 * fall back to their most general member.
 */
const FALLBACK_SUBTYPES: Record<AccountType, AccountSubtype> = {
  asset: "uncategorized_assets",
  liability: "other_current_liabilities",
  equity: "uncategorized_equity",
  revenue: "uncategorized_income",
  expense: "uncategorized_expenses",
  cost_of_revenue: "other_cost_of_revenue",
  other_income: "other_miscellaneous_income",
  other_expense: "other_miscellaneous_expenses",
};

export function fallbackSubtypeFor(type: AccountType): AccountSubtype {
  return FALLBACK_SUBTYPES[type];
}

/**
 * Root account-number ranges (standard 5-digit COA convention).
 *
 * These MUST match the numbering the seeded/preset chart actually uses:
 * Other Income is 80000 and Other Expenses is 90000. An earlier copy in
 * `-accounts.ts` used 70000/80000, which made an auto-generated root-level
 * `other_expense` collide with the seeded "Other Income" root and surface as an
 * opaque database error.
 */
export const ACCOUNT_TYPE_RANGES: Record<AccountType, number> = {
  asset: 10000,
  liability: 20000,
  equity: 30000,
  revenue: 40000,
  cost_of_revenue: 50000,
  expense: 60000,
  other_income: 80000,
  other_expense: 90000,
};
