/**
 * Invoice Category Mapping Config — extracted from invoices.tsx route
 * to avoid cross-route imports that break TanStack Start server functions.
 */
import type { MappingConfig } from "./coa/mapping-types";

export const INVOICE_MAPPING_CONFIG: MappingConfig = {
  storageKey: "digits:invoice-category-mappings",
  mappingType: "invoice",
  title: "Invoice Category Mapping",
  description: "Choose default ledger accounts for invoice line items and receivables",
  rows: [
    {
      type: "default_revenue",
      label: "Default Revenue",
      icon: "💰",
      ledgerType: "revenue",
      defaultSubtype: "sales_revenue",
      defaultName: "Sales Revenue",
      defaultNumber: "41000",
    },
    {
      type: "accounts_receivable",
      label: "Accounts Receivable",
      icon: "📥",
      ledgerType: "asset",
      defaultSubtype: "account_receivable",
      defaultName: "Accounts Receivable",
      defaultNumber: "12000",
    },
    // Previously resolved by scanning account NAMES for "%sales tax%", which
    // broke on any rename and was non-deterministic with more than one match.
    {
      type: "sales_tax_payable",
      label: "Sales Tax Payable",
      icon: "🏛️",
      ledgerType: "liability",
      defaultSubtype: "other_current_liabilities",
      defaultName: "Sales Tax Payable",
      defaultNumber: "21500",
    },
    {
      type: "discounts",
      label: "Refunds & Discounts",
      icon: "🏷️",
      ledgerType: "revenue",
      defaultSubtype: "refunds_discounts",
      defaultName: "Refunds & Discounts",
      defaultNumber: "49000",
    },
    {
      type: "payment_clearing",
      label: "Payment Clearing",
      icon: "🔄",
      ledgerType: "asset",
      defaultSubtype: "asset_clearing",
      defaultName: "Asset Clearing",
      defaultNumber: "11500",
    },
  ],
};
