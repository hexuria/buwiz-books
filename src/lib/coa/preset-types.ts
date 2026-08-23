/**
 * Chart-of-accounts preset types.
 *
 * Presets are code, not database rows. That buys compile-time checking of every
 * `accountType`/`subtype` pair against the schema constants, review of chart
 * changes in a PR diff, and invariant tests that run with no database. Users
 * customize the *result* of applying a preset, never the preset itself.
 */
import type { AccountSubtype, AccountType } from "../../db/schema/account-constants";
import type { MappingType } from "./mapping-types";

/**
 * A preset-local, stable identifier. Never a uuid — uuids do not exist until
 * apply time, which is why mappings and parent links are expressed
 * symbolically and resolved by the planner.
 */
export type PresetKey = string;

export interface PresetAccount {
  key: PresetKey;
  name: string;
  /** 5 digits, unique within the preset, inside its type's range. */
  accountNumber: string;
  accountType: AccountType;
  /** null ONLY for the 8 roots. Validated against SUBTYPES_BY_TYPE. */
  subtype: AccountSubtype | null;
  icon: string;
  description?: string;
  /** true ONLY for roots. User input can never reach this. */
  isSystem?: boolean;
  children?: readonly PresetAccount[];
}

/** Symbolic mapping assignment: `targetKey` refers to a PresetAccount.key. */
export interface PresetMappingAssignment {
  mappingType: MappingType;
  /** Must exist in the corresponding MappingConfig.rows. */
  sourceKey: string;
  targetKey: PresetKey;
}

export type FinancialAccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "money_market"
  | "investment"
  | "other";

/**
 * An entity to scaffold alongside the chart.
 *
 * Every shipped preset declares `entities: []`. A `financial_accounts` row
 * asserts that the org holds a real account at a real institution — it shows up
 * in reconciliation, can be pointed at by `orgMetadata.paymentBankAccountId`,
 * and is reused by name in `ensureBankInfrastructure`. The mapping-completeness
 * guarantee does not need one: `BANK_MAPPING_CONFIG` maps financial-account
 * *types* to ledger categories, so ledger accounts alone satisfy it. The type
 * exists so an AI-authored preset can request one behind an explicit opt-in.
 */
export interface PresetFinancialAccountScaffold {
  kind: "financial_account";
  key: PresetKey;
  accountName: string;
  accountType: FinancialAccountType;
  /** The ledger account it links to; must be under bank_accounts / credit_cards. */
  ledgerAccountKey: PresetKey;
  institutionName?: string;
}

export type PresetEntityScaffold = PresetFinancialAccountScaffold;

export type CoaPresetId =
  | "general_small_business"
  | "saas_startup"
  | "freelancer"
  | "retail_ecommerce"
  | "philippines_smb";

export interface CoaPreset {
  /**
   * Catalog packs use a `CoaPresetId`. An AI-derived draft is assembled into
   * this same shape so it can share the one write path, and carries its own id
   * (e.g. "ai_coa_draft") — hence `string` rather than the catalog union, which
   * would otherwise force a lie-to-the-compiler cast at that call site.
   * `COA_PRESETS` still constrains the shipped catalog.
   */
  id: string;
  /** Bump on ANY change to accounts/mappings/entities. Shipped versions are frozen. */
  version: number;
  label: string;
  description: string;
  /** onboarding INDUSTRIES values this preset is the default for. */
  industries: readonly string[];
  accounts: readonly PresetAccount[];
  mappings: readonly PresetMappingAssignment[];
  entities: readonly PresetEntityScaffold[];
}

/** Depth-first flatten, parent always emitted before its children. */
export function flattenPresetAccounts(
  accounts: readonly PresetAccount[],
  depth = 0,
  parentKey: PresetKey | null = null,
): Array<{ account: PresetAccount; depth: number; parentKey: PresetKey | null }> {
  const out: Array<{ account: PresetAccount; depth: number; parentKey: PresetKey | null }> = [];
  for (const account of accounts) {
    out.push({ account, depth, parentKey });
    if (account.children?.length) {
      out.push(...flattenPresetAccounts(account.children, depth + 1, account.key));
    }
  }
  return out;
}
