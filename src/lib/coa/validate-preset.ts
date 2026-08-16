/**
 * Structural validation for a chart-of-accounts preset.
 *
 * Pure and database-free, so the whole preset catalog can be checked in a unit
 * test. This is also the gate an AI-authored preset passes through before it
 * can become a proposal — see `validate-draft.ts`.
 */
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RANGES,
  isSubtypeLegalForType,
} from "../../db/schema/account-constants";
import { allMappingKeys, mappingRowFor } from "./mapping-registry";
import { flattenPresetAccounts, type CoaPreset, type PresetAccount } from "./preset-types";

export interface PresetValidationError {
  code:
    | "duplicate_key"
    | "duplicate_number"
    | "illegal_subtype"
    | "missing_subtype"
    | "root_subtype"
    | "number_out_of_range"
    | "type_mismatch_with_parent"
    | "missing_root"
    | "unexpected_system_flag"
    | "unknown_mapping_source"
    | "unknown_mapping_target"
    | "incompatible_mapping_target"
    | "incomplete_mapping_coverage"
    | "unknown_entity_account";
  message: string;
  key?: string;
}

export function validatePresetAccounts(
  accounts: readonly PresetAccount[],
): PresetValidationError[] {
  const errors: PresetValidationError[] = [];
  const flat = flattenPresetAccounts(accounts);
  const byKey = new Map(flat.map((n) => [n.account.key, n]));

  const seenKeys = new Set<string>();
  const seenNumbers = new Set<string>();

  for (const { account, depth, parentKey } of flat) {
    if (seenKeys.has(account.key)) {
      errors.push({ code: "duplicate_key", key: account.key, message: `duplicate key` });
    }
    seenKeys.add(account.key);

    if (seenNumbers.has(account.accountNumber)) {
      errors.push({
        code: "duplicate_number",
        key: account.key,
        message: `account number ${account.accountNumber} used more than once`,
      });
    }
    seenNumbers.add(account.accountNumber);

    // Roots carry no subtype; everything else must carry a legal one, because a
    // null subtype is silently dropped from the cash-flow statement.
    if (depth === 0) {
      if (account.subtype) {
        errors.push({
          code: "root_subtype",
          key: account.key,
          message: `root must have no subtype`,
        });
      }
      if (!account.isSystem) {
        errors.push({
          code: "unexpected_system_flag",
          key: account.key,
          message: `root must be isSystem`,
        });
      }
    } else {
      if (account.isSystem) {
        errors.push({
          code: "unexpected_system_flag",
          key: account.key,
          message: `only roots may be isSystem`,
        });
      }
      if (!account.subtype) {
        errors.push({ code: "missing_subtype", key: account.key, message: `subtype is required` });
      } else if (!isSubtypeLegalForType(account.accountType, account.subtype)) {
        errors.push({
          code: "illegal_subtype",
          key: account.key,
          message: `subtype "${account.subtype}" is not legal for "${account.accountType}"`,
        });
      }
    }

    const base = ACCOUNT_TYPE_RANGES[account.accountType];
    const value = Number(account.accountNumber);
    if (!Number.isInteger(value) || value < base || value > base + 9999) {
      errors.push({
        code: "number_out_of_range",
        key: account.key,
        message: `${account.accountNumber} is outside ${base}-${base + 9999} for "${account.accountType}"`,
      });
    }

    if (parentKey) {
      const parent = byKey.get(parentKey);
      if (parent && parent.account.accountType !== account.accountType) {
        errors.push({
          code: "type_mismatch_with_parent",
          key: account.key,
          message: `type "${account.accountType}" under parent of type "${parent.account.accountType}"`,
        });
      }
    }
  }

  // All 8 roots must exist: the completeness pass parents synthesized accounts
  // under the root for their ledger type.
  const rootTypes = new Set(
    flattenPresetAccounts(accounts)
      .filter((n) => n.depth === 0)
      .map((n) => n.account.accountType),
  );
  for (const type of ACCOUNT_TYPES) {
    if (!rootTypes.has(type)) {
      errors.push({ code: "missing_root", message: `no root account for type "${type}"` });
    }
  }

  return errors;
}

export function validatePreset(preset: CoaPreset): PresetValidationError[] {
  const errors = validatePresetAccounts(preset.accounts);
  const flat = flattenPresetAccounts(preset.accounts);
  const byKey = new Map(flat.map((n) => [n.account.key, n.account]));

  for (const assignment of preset.mappings) {
    const row = mappingRowFor(assignment.mappingType, assignment.sourceKey);
    if (!row) {
      errors.push({
        code: "unknown_mapping_source",
        message: `${assignment.mappingType}.${assignment.sourceKey} is not a known mapping row`,
      });
      continue;
    }
    const target = byKey.get(assignment.targetKey);
    if (!target) {
      errors.push({
        code: "unknown_mapping_target",
        key: assignment.targetKey,
        message: `${assignment.mappingType}.${assignment.sourceKey} targets unknown key`,
      });
      continue;
    }
    if (target.accountType !== row.ledgerType) {
      errors.push({
        code: "incompatible_mapping_target",
        key: assignment.targetKey,
        message: `${assignment.mappingType}.${assignment.sourceKey} expects "${row.ledgerType}" but "${assignment.targetKey}" is "${target.accountType}"`,
      });
    }
  }

  // A preset must be able to satisfy every mapping row on its own: either it
  // names a target explicitly, or it contains an account carrying that row's
  // (defaultSubtype, ledgerType). Runtime synthesis is a net for pre-existing
  // orgs, not a licence for an incomplete pack.
  const declared = new Set(preset.mappings.map((m) => `${m.mappingType}:${m.sourceKey}`));
  for (const { mappingType, sourceKey } of allMappingKeys()) {
    if (declared.has(`${mappingType}:${sourceKey}`)) continue;
    const row = mappingRowFor(mappingType, sourceKey);
    if (!row) continue;
    const satisfied = flat.some(
      ({ account }) =>
        account.subtype === row.defaultSubtype && account.accountType === row.ledgerType,
    );
    if (!satisfied) {
      errors.push({
        code: "incomplete_mapping_coverage",
        message: `${mappingType}.${sourceKey} has no target: no explicit mapping and no account with subtype "${row.defaultSubtype}"`,
      });
    }
  }

  for (const entity of preset.entities) {
    if (!byKey.has(entity.ledgerAccountKey)) {
      errors.push({
        code: "unknown_entity_account",
        key: entity.ledgerAccountKey,
        message: `entity "${entity.key}" references unknown ledger account key`,
      });
    }
  }

  return errors;
}
