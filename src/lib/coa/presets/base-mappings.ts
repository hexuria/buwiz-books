/**
 * Explicit mapping assignments against BASE_ACCOUNTS.
 *
 * Every mapping row is declared explicitly rather than left to the resolver's
 * subtype fallback, because subtypes are many-to-one: `other_current_liabilities`
 * is carried by three baseline accounts (Other Current Liabilities, Uncategorized
 * Liabilities, Sales Tax Payable) and `professional_fees` by five. Leaving those
 * to a fallback makes which account a bill posts to depend on ordering.
 */
import type { PresetMappingAssignment } from "../preset-types";

export const BASE_MAPPINGS: readonly PresetMappingAssignment[] = [
  // ─── Bank & card: financial-account type -> ledger category ───
  { mappingType: "bank", sourceKey: "checking", targetKey: "bank_accounts" },
  { mappingType: "bank", sourceKey: "savings", targetKey: "bank_accounts" },
  { mappingType: "bank", sourceKey: "money_market", targetKey: "bank_accounts" },
  { mappingType: "bank", sourceKey: "credit_card", targetKey: "credit_cards" },
  { mappingType: "bank", sourceKey: "investment", targetKey: "investments" },
  { mappingType: "bank", sourceKey: "other", targetKey: "uncategorized_assets" },

  // ─── Bills ───
  { mappingType: "bill", sourceKey: "default_expense", targetKey: "uncategorized_expense" },
  { mappingType: "bill", sourceKey: "accounts_payable", targetKey: "accounts_payable" },
  { mappingType: "bill", sourceKey: "facilities", targetKey: "facilities" },
  { mappingType: "bill", sourceKey: "general_operations", targetKey: "general_operations" },
  { mappingType: "bill", sourceKey: "insurance", targetKey: "insurance" },
  { mappingType: "bill", sourceKey: "supplies_and_materials", targetKey: "supplies_and_materials" },
  { mappingType: "bill", sourceKey: "professional_fees", targetKey: "professional_fees" },
  {
    mappingType: "bill",
    sourceKey: "business_application_software",
    targetKey: "business_applications_and_software",
  },
  {
    mappingType: "bill",
    sourceKey: "payment_processing_fees",
    targetKey: "payment_processing_fees",
  },
  { mappingType: "bill", sourceKey: "hosting_fees", targetKey: "hosting_fees" },
  { mappingType: "bill", sourceKey: "cost_of_goods", targetKey: "cost_of_goods_sold" },
  { mappingType: "bill", sourceKey: "taxes", targetKey: "taxes" },
  { mappingType: "bill", sourceKey: "interest_expense", targetKey: "interest_expense" },
  {
    mappingType: "bill",
    sourceKey: "other_miscellaneous_expenses",
    targetKey: "other_miscellaneous_expenses",
  },
  {
    mappingType: "bill",
    sourceKey: "other_current_liabilities",
    targetKey: "other_current_liabilities",
  },

  // ─── Invoices ───
  { mappingType: "invoice", sourceKey: "default_revenue", targetKey: "sales_revenue" },
  { mappingType: "invoice", sourceKey: "accounts_receivable", targetKey: "accounts_receivable" },
  // Explicit is load-bearing here: the subtype fallback would otherwise credit
  // sales tax to whichever other-current-liability account sorted first.
  { mappingType: "invoice", sourceKey: "sales_tax_payable", targetKey: "sales_tax_payable" },
  { mappingType: "invoice", sourceKey: "discounts", targetKey: "refunds_and_discounts" },
  { mappingType: "invoice", sourceKey: "payment_clearing", targetKey: "asset_clearing" },
];
