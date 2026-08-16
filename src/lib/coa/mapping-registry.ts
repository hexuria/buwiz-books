/**
 * The registry of every category-mapping config.
 *
 * Anything that needs to reason about mappings as a whole — the preset applier's
 * completeness guarantee, the resolver, the "how many rows are still unmapped"
 * indicator — reads this rather than importing the three configs individually,
 * so adding a fourth scope is a one-line change here.
 */
import { BANK_MAPPING_CONFIG } from "../bank-mapping-config";
import { BILL_MAPPING_CONFIG } from "../bill-mapping-config";
import { INVOICE_MAPPING_CONFIG } from "../invoice-mapping-config";
import type { MappingConfig, MappingRow, MappingType } from "./mapping-types";

export const MAPPING_CONFIGS: Record<MappingType, MappingConfig> = {
  bank: BANK_MAPPING_CONFIG,
  bill: BILL_MAPPING_CONFIG,
  invoice: INVOICE_MAPPING_CONFIG,
};

export const ALL_MAPPING_CONFIGS: MappingConfig[] = Object.values(MAPPING_CONFIGS);

export interface MappingKey {
  mappingType: MappingType;
  sourceKey: string;
}

/** Every (mappingType, sourceKey) pair the system expects to be mapped. */
export function allMappingKeys(): MappingKey[] {
  return ALL_MAPPING_CONFIGS.flatMap((config) =>
    config.rows.map((row) => ({ mappingType: config.mappingType, sourceKey: row.type })),
  );
}

export function mappingRowFor(mappingType: string, sourceKey: string): MappingRow | null {
  const config = MAPPING_CONFIGS[mappingType as MappingType];
  if (!config) return null;
  return config.rows.find((row) => row.type === sourceKey) ?? null;
}

/**
 * Whether an account may be the target of a mapping row.
 *
 * This is the check that keeps a mapping from pointing "Default Expense" at a
 * revenue account — which would unbalance every bill journal once the mapping
 * is actually read. Enforced on resolve AND on apply, because a mapping row is
 * data at rest that can go stale after it is written.
 */
export function isMappingTargetCompatible(
  row: MappingRow,
  account: { accountType: string },
): boolean {
  return account.accountType === row.ledgerType;
}
