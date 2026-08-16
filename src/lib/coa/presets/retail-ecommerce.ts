import type { CoaPreset, PresetAccount } from "../preset-types";
import { withChildren } from "../tree-ops";
import { BASE_ACCOUNTS } from "./base";
import { BASE_MAPPINGS } from "./base-mappings";

const ASSET_ADDITIONS: PresetAccount[] = [
  {
    key: "retail_inventory_in_transit",
    name: "Inventory In Transit",
    accountNumber: "13600",
    accountType: "asset",
    subtype: "inventory",
    icon: "Package",
    description: "Goods purchased and paid for but not yet received into stock",
  },
];

const REVENUE_ADDITIONS: PresetAccount[] = [
  {
    key: "retail_online_sales",
    name: "Online Store Sales",
    accountNumber: "44000",
    accountType: "revenue",
    subtype: "sales_revenue",
    icon: "ShoppingCart",
    description: "Direct-to-consumer sales through the owned storefront",
  },
  {
    key: "retail_marketplace_sales",
    name: "Marketplace Sales",
    accountNumber: "45000",
    accountType: "revenue",
    subtype: "partner_revenue",
    icon: "Store",
    description: "Sales through third-party marketplaces net of marketplace fees",
  },
  {
    key: "retail_shipping_income",
    name: "Shipping Income",
    accountNumber: "46000",
    accountType: "revenue",
    subtype: "sales_revenue",
    icon: "Truck",
    description: "Shipping and handling charged to customers",
  },
];

const COST_OF_REVENUE_ADDITIONS: PresetAccount[] = [
  {
    key: "retail_shipping_fulfillment",
    name: "Shipping & Fulfillment",
    accountNumber: "55000",
    accountType: "cost_of_revenue",
    subtype: "other_cost_of_revenue",
    icon: "Truck",
    description: "Outbound freight, packaging, pick-and-pack, and warehouse fulfillment fees",
  },
  {
    key: "retail_merchant_fees",
    name: "Merchant & Marketplace Fees",
    accountNumber: "56000",
    accountType: "cost_of_revenue",
    subtype: "payment_processing_fees",
    icon: "CreditCard",
    description: "Card processing, gateway, and marketplace commission fees",
  },
  {
    key: "retail_inventory_shrinkage",
    name: "Inventory Shrinkage",
    accountNumber: "57000",
    accountType: "cost_of_revenue",
    subtype: "cost_of_goods",
    icon: "QuestionTransaction",
    description: "Write-offs for damaged, lost, or stolen stock",
  },
];

/**
 * Retail / e-commerce.
 *
 * Sales tax payable and the refunds/discounts contra-revenue account are in the
 * baseline chart, so returns and taxed invoices post out of the box.
 */
export const RETAIL_ECOMMERCE: CoaPreset = {
  id: "retail_ecommerce",
  version: 1,
  label: "Retail / e-commerce",
  description:
    "Inventory and inventory-in-transit, cost of goods by channel, merchant and marketplace fees, shipping and fulfillment, plus sales tax payable and returns.",
  industries: ["retail"],
  accounts: withChildren(BASE_ACCOUNTS, {
    assets: ASSET_ADDITIONS,
    revenue: REVENUE_ADDITIONS,
    cost_of_revenue: COST_OF_REVENUE_ADDITIONS,
  }),
  mappings: BASE_MAPPINGS,
  entities: [],
};
