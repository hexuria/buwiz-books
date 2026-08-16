/**
 * Party Scoping — Category-aware party type suggestions
 *
 * Maps account subtypes to preferred party entity types so the transaction
 * form can show contextually-relevant parties in the combobox.
 *
 * RETRIEVE types: which party types to show when listing parties
 * CREATE types: which party types can be created from the combobox
 *
 * Reference: docs/party_category_mapping.md
 */

export type PartyType =
  | "vendor"
  | "customer"
  | "both"
  | "employee"
  | "shareholder"
  | "lender"
  | "bank"
  | "government"
  | "other";

export type TransactionType = "pay_in" | "pay_out" | "journal" | "transfer";

/**
 * Dual-purpose override structure from party_type_mappings table.
 * Each subtype can have separate read and mutate type arrays.
 */
export interface PartyMappingOverride {
  readTypes: PartyType[];
  mutateTypes: PartyType[];
}

/**
 * System defaults for RETRIEVING parties (which types to show in dropdown).
 * These represent the entities you'd typically transact WITH for this subtype.
 */
export const SUBTYPE_READ_MAP: Record<string, PartyType[]> = {
  // ── Asset subtypes ──────────────────────────────────────
  account_receivable: ["customer"],
  accrued_revenue: ["customer"],
  asset_clearing: [],
  bank_accounts: ["vendor", "customer", "government", "lender"],
  fixed_assets: ["vendor"],
  goodwill: [],
  intangible_assets: [],
  inventory: ["vendor"],
  investments: ["lender"],
  other_current_assets: [],
  other_long_term_assets: [],
  prepaid_expenses: ["vendor"],
  shareholder_loans: ["shareholder"],
  uncategorized_assets: [],

  // ── Liability subtypes ──────────────────────────────────
  accounts_payable: ["vendor"],
  accrued_expenses: ["vendor"],
  convertible_notes: ["lender"],
  credit_cards: ["vendor", "customer"],
  deferred_revenue: ["customer"],
  liability_clearing: [],
  long_term_debt: ["lender"],
  other_current_liabilities: [],
  other_long_term_liabilities: [],
  short_term_debt: ["lender"],
  payroll_liabilities: ["government"],

  // ── Equity subtypes ──────────────────────────────────────
  additional_paid_in_capital: ["shareholder"],
  common_stock: ["shareholder"],
  other_comprehensive_income: [],
  owners_equity: ["shareholder"],
  preferred_stock: ["shareholder"],
  retained_earnings: ["shareholder"],
  safes: ["shareholder"],
  treasury_stock: ["shareholder"],
  uncategorized_equity: [],

  // ── Revenue subtypes ─────────────────────────────────────
  partner_revenue: ["vendor"],
  refunds_discounts: ["customer"],
  sales_revenue: ["customer"],
  subscription_revenue: ["customer"],
  transaction_revenue: ["customer"],
  uncategorized_income: [],

  // ── Cost of Revenue subtypes ─────────────────────────────
  cost_of_goods: ["vendor"],
  cost_of_labor: ["employee"],
  hosting_fees: ["vendor"],
  other_cost_of_revenue: ["vendor"],
  payment_processing_fees: ["vendor"],

  // ── Operating Expenses subtypes ──────────────────────────
  bad_debt_expense: ["customer"],
  bank_fees: ["bank"],
  business_application_software: ["vendor"],
  facilities: ["vendor"],
  general_operations: ["vendor"],
  insurance: ["vendor"],
  payroll_expenses: ["employee"],
  professional_fees: ["vendor"],
  sales_marketing: ["vendor"],
  supplies_and_materials: ["vendor"],
  travel_entertainment: ["employee", "vendor"],
  uncategorized_expenses: [],

  // ── Other Income subtypes ────────────────────────────────
  credit_card_rewards: ["bank"],
  interests_dividends: ["lender"],
  other_miscellaneous_income: [],

  // ── Other Expenses subtypes ──────────────────────────────
  depreciation_amortization: [],
  interest_expense: ["lender"],
  other_miscellaneous_expenses: [],
  taxes: ["government"],
};

/**
 * System defaults for MUTATING/CREATING parties (which types can be created inline).
 * For most subtypes this is the same as read (first entry),
 * but bank accounts create "bank" entities while reading others.
 */
export const SUBTYPE_MUTATE_MAP: Record<string, PartyType[]> = {
  // ── Asset subtypes ──────────────────────────────────────
  account_receivable: ["customer"],
  accrued_revenue: ["customer"],
  asset_clearing: [],
  bank_accounts: ["bank"],
  fixed_assets: ["vendor"],
  goodwill: [],
  intangible_assets: [],
  inventory: ["vendor"],
  investments: ["lender"],
  other_current_assets: [],
  other_long_term_assets: [],
  prepaid_expenses: ["vendor"],
  shareholder_loans: ["shareholder"],
  uncategorized_assets: [],

  // ── Liability subtypes ──────────────────────────────────
  accounts_payable: ["vendor"],
  accrued_expenses: ["vendor"],
  convertible_notes: ["lender"],
  credit_cards: ["bank"],
  deferred_revenue: ["customer"],
  liability_clearing: [],
  long_term_debt: ["lender"],
  other_current_liabilities: [],
  other_long_term_liabilities: [],
  short_term_debt: ["lender"],
  payroll_liabilities: ["government"],

  // ── Equity subtypes ──────────────────────────────────────
  additional_paid_in_capital: ["shareholder"],
  common_stock: ["shareholder"],
  other_comprehensive_income: [],
  owners_equity: ["shareholder"],
  preferred_stock: ["shareholder"],
  retained_earnings: ["shareholder"],
  safes: ["shareholder"],
  treasury_stock: ["shareholder"],
  uncategorized_equity: [],

  // ── Revenue subtypes ─────────────────────────────────────
  partner_revenue: ["vendor"],
  refunds_discounts: ["customer"],
  sales_revenue: ["customer"],
  subscription_revenue: ["customer"],
  transaction_revenue: ["customer"],
  uncategorized_income: [],

  // ── Cost of Revenue subtypes ─────────────────────────────
  cost_of_goods: ["vendor"],
  cost_of_labor: ["employee"],
  hosting_fees: ["vendor"],
  other_cost_of_revenue: ["vendor"],
  payment_processing_fees: ["vendor"],

  // ── Operating Expenses subtypes ──────────────────────────
  bad_debt_expense: ["customer"],
  bank_fees: ["bank"],
  business_application_software: ["vendor"],
  facilities: ["vendor"],
  general_operations: ["vendor"],
  insurance: ["vendor"],
  payroll_expenses: ["employee"],
  professional_fees: ["vendor"],
  sales_marketing: ["vendor"],
  supplies_and_materials: ["vendor"],
  travel_entertainment: ["vendor"],
  uncategorized_expenses: [],

  // ── Other Income subtypes ────────────────────────────────
  credit_card_rewards: ["bank"],
  interests_dividends: ["lender"],
  other_miscellaneous_income: [],

  // ── Other Expenses subtypes ──────────────────────────────
  depreciation_amortization: [],
  interest_expense: ["lender"],
  other_miscellaneous_expenses: [],
  taxes: ["government"],
};

/**
 * Get the preferred party types for READING/LISTING parties.
 *
 * 3-tier resolution priority:
 *   Tier 1: Account-level readPartyTypes (per category record)
 *   Tier 2: Org-level override (from party_type_mappings.read_types)
 *   Tier 3: System default (SUBTYPE_READ_MAP)
 */
export function getReadPartyTypes(
  subtype?: string | null,
  transactionType?: TransactionType | null,
  overrides?: Record<string, PartyMappingOverride>,
  accountReadTypes?: string[] | null,
): PartyType[] {
  // Tier 1: Account-level override
  if (accountReadTypes?.length) return accountReadTypes as PartyType[];

  if (subtype) {
    // Tier 2: Org-level override
    const orgOverride = overrides?.[subtype]?.readTypes;
    if (orgOverride?.length) return orgOverride;

    // Tier 3: System default
    const systemDefault = SUBTYPE_READ_MAP[subtype];
    if (systemDefault?.length) return systemDefault;
  }

  // Fall back to transaction-type-based defaults
  if (transactionType === "pay_out") return ["vendor"];
  if (transactionType === "pay_in") return ["customer"];

  // Journal & Transfer: no filter (show all)
  return [];
}

/**
 * Get the preferred party types for MUTATING/CREATING parties.
 *
 * 3-tier resolution priority:
 *   Tier 1: Account-level mutatePartyTypes (per category record)
 *   Tier 2: Org-level override (from party_type_mappings.mutate_types)
 *   Tier 3: System default (SUBTYPE_MUTATE_MAP)
 */
export function getMutatePartyTypes(
  subtype?: string | null,
  transactionType?: TransactionType | null,
  overrides?: Record<string, PartyMappingOverride>,
  accountMutateTypes?: string[] | null,
): PartyType[] {
  // Tier 1: Account-level override
  if (accountMutateTypes?.length) return accountMutateTypes as PartyType[];

  if (subtype) {
    // Tier 2: Org-level override
    const orgOverride = overrides?.[subtype]?.mutateTypes;
    if (orgOverride?.length) return orgOverride;

    // Tier 3: System default
    const systemDefault = SUBTYPE_MUTATE_MAP[subtype];
    if (systemDefault?.length) return systemDefault;
  }

  // Transaction-type default
  if (transactionType === "pay_out") return ["vendor"];
  if (transactionType === "pay_in") return ["customer"];

  // Fallback
  return ["vendor"];
}

/**
 * Convert preferred party types to a `listParties` API filter value.
 *
 * The API accepts an array of PartyType values or a single string.
 * Returns the preferred types directly, or "all" when no filter needed.
 */
export function toPartyApiFilter(preferredTypes: PartyType[]): PartyType | PartyType[] | "all" {
  if (preferredTypes.length === 0) return "all";
  if (preferredTypes.length === 1) return preferredTypes[0];
  return preferredTypes;
}

// ── Legacy compatibility aliases ──────────────────────────
// Keep for any callers that haven't migrated yet.
export const SUBTYPE_PARTY_MAP = SUBTYPE_READ_MAP;
export const SUBTYPE_RETRIEVE_MAP = SUBTYPE_READ_MAP;
export const SUBTYPE_CREATE_MAP = SUBTYPE_MUTATE_MAP;
export const getPreferredPartyTypes = getReadPartyTypes;
export const getRetrievePartyTypes = getReadPartyTypes;
export const getCreatePartyTypes = getMutatePartyTypes;
export const getDefaultPartyTypeForCreation = (
  subtype?: string | null,
  transactionType?: TransactionType | null,
  overrides?: Record<string, PartyMappingOverride>,
  accountMutateTypes?: string[] | null,
): PartyType => {
  const types = getMutatePartyTypes(subtype, transactionType, overrides, accountMutateTypes);
  return types.length > 0 ? types[0] : "vendor";
};
