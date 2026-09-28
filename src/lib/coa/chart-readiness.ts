/**
 * "Has this organization applied a chart of accounts?" — asked before anything
 * automated is allowed to feed papers into the books (Inbox v2 routines).
 *
 * The answer reuses the posting resolver rather than inventing a second
 * notion of "set up": the chart counts as applied when EVERY mapping key the
 * system expects (bank, bill, invoice) resolves to a live account through
 * resolve-mapped-account.ts. Applying any preset guarantees that ("fully
 * mapped or untouched"), and it is exactly the condition under which a paper
 * the Inbox classifies can later be posted without an UnmappedAccountError.
 */
import type { DbExecutor } from "../../db";
import { allMappingKeys, type MappingKey } from "./mapping-registry";
import { MAPPING_TYPES } from "./mapping-types";
import { resolveMappedAccountIds } from "./resolve-mapped-account";

export const CHART_OF_ACCOUNTS_REQUIRED_MESSAGE = "Set up your chart of accounts first.";

export class ChartOfAccountsRequiredError extends Error {
  constructor(readonly missing: MappingKey[]) {
    super(CHART_OF_ACCOUNTS_REQUIRED_MESSAGE);
    this.name = "ChartOfAccountsRequiredError";
  }
}

/** Mapping keys that do not resolve to a live account in this organization. */
export async function unresolvedMappingKeys(db: DbExecutor, orgId: string): Promise<MappingKey[]> {
  const expected = allMappingKeys();
  const missing: MappingKey[] = [];
  for (const mappingType of MAPPING_TYPES) {
    const sourceKeys = expected
      .filter((key) => key.mappingType === mappingType)
      .map((key) => key.sourceKey);
    if (sourceKeys.length === 0) continue;
    const resolved = await resolveMappedAccountIds(db, orgId, mappingType, sourceKeys);
    for (const sourceKey of sourceKeys) {
      if (!resolved[sourceKey]) missing.push({ mappingType, sourceKey });
    }
  }
  return missing;
}

export async function assertChartOfAccountsApplied(db: DbExecutor, orgId: string): Promise<void> {
  const missing = await unresolvedMappingKeys(db, orgId);
  if (missing.length > 0) throw new ChartOfAccountsRequiredError(missing);
}
