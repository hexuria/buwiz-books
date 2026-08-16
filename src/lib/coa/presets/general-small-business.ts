import type { CoaPreset } from "../preset-types";
import { BASE_ACCOUNTS } from "./base";
import { BASE_MAPPINGS } from "./base-mappings";

/**
 * The baseline pack, and the fallback when an industry does not match.
 * Every other pack is this tree plus a small diff.
 */
export const GENERAL_SMALL_BUSINESS: CoaPreset = {
  id: "general_small_business",
  version: 1,
  label: "General small business",
  description:
    "A complete double-entry chart covering the eight root types, payroll, facilities, professional fees, and the receivable/payable accounts every business needs. Start here if none of the others fit.",
  industries: [
    "finance",
    "healthcare",
    "manufacturing",
    "real_estate",
    "education",
    "nonprofit",
    "other",
  ],
  accounts: BASE_ACCOUNTS,
  mappings: BASE_MAPPINGS,
  // No financial_accounts row: mapping completeness needs only ledger accounts,
  // and a placeholder would assert an institution the org does not yet have.
  entities: [],
};
