/**
 * Category-mapping types.
 *
 * These live in `src/lib/coa/` rather than in a React component so that server
 * code (resolvers, preset appliers, jobs) can depend on them without a nominal
 * dependency on a `.tsx` module.
 */
import type { AccountSubtype, AccountType } from "../../db/schema/account-constants";

/** The three mapping scopes persisted in `category_mappings.mapping_type`. */
export const MAPPING_TYPES = ["bank", "bill", "invoice"] as const;
export type MappingType = (typeof MAPPING_TYPES)[number];

export interface MappingRow {
  /** The `source_key` persisted in `category_mappings`. */
  type: string;
  label: string;
  icon: string;
  /** The account type a target account MUST have. Enforced on resolve and apply. */
  ledgerType: AccountType;
  defaultSubtype: AccountSubtype;
  defaultName: string;
  defaultNumber: string;
}

export interface MappingConfig {
  /**
   * @deprecated Retained only as a reference for the old localStorage keys.
   *
   * The `digits:`-prefixed literals are deliberately NOT rebranded. Category
   * mappings used to live in localStorage; `CategoryMappingSettings` still
   * reads these exact keys once, uploads what it finds to the server, and then
   * removes them. Renaming the key makes that lookup miss, so any user who has
   * not yet been migrated silently loses their category mappings. Drop the keys
   * outright once the migration is known complete — do not rename them.
   */
  storageKey: string;
  mappingType: MappingType;
  title: string;
  description: string;
  rows: MappingRow[];
}

export interface LedgerAccountRef {
  id: string;
  name: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
}
