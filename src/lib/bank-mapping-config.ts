/**
 * Bank Category Mapping Config — unified MappingConfig shape
 * Mirrors ACCOUNT_TYPE_ROWS from BankCategorySettings but uses the
 * shared MappingConfig interface so it works with CategoryMappingPanel.
 */
import type { MappingConfig } from "./coa/mapping-types";

export const BANK_MAPPING_CONFIG: MappingConfig = {
  storageKey: "digits:bank-category-mappings",
  mappingType: "bank",
  title: "Bank & Card Category Mapping",
  description: "Choose which ledger category is assigned for each financial account type",
  rows: [
    {
      type: "checking",
      label: "Checking",
      icon: "🏦",
      ledgerType: "asset",
      defaultSubtype: "bank_accounts",
      defaultName: "Bank Accounts",
      defaultNumber: "11000",
    },
    {
      type: "savings",
      label: "Savings",
      icon: "🏦",
      ledgerType: "asset",
      defaultSubtype: "bank_accounts",
      defaultName: "Bank Accounts",
      defaultNumber: "11000",
    },
    {
      type: "credit_card",
      label: "Credit Card",
      icon: "💳",
      ledgerType: "liability",
      defaultSubtype: "credit_cards",
      defaultName: "Credit Cards",
      defaultNumber: "22000",
    },
    {
      type: "money_market",
      label: "Money Market",
      icon: "🏦",
      ledgerType: "asset",
      defaultSubtype: "bank_accounts",
      defaultName: "Bank Accounts",
      defaultNumber: "11000",
    },
    {
      type: "investment",
      label: "Investment",
      icon: "📈",
      ledgerType: "asset",
      defaultSubtype: "investments",
      defaultName: "Investments",
      defaultNumber: "14000",
    },
    {
      type: "other",
      label: "Other",
      icon: "🏛️",
      ledgerType: "asset",
      defaultSubtype: "uncategorized_assets",
      defaultName: "Uncategorized Assets",
      defaultNumber: "15999",
    },
  ],
};
