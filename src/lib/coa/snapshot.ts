/**
 * The two reads that feed the pure planner.
 *
 * Kept separate from planning so `previewCoaPreset` and `applyCoaPreset` share
 * one code path, and so every planner case is unit-testable with no database.
 */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { accounts } from "../../db/schema/accounts";
import { categoryMappings } from "../../db/schema/category-mappings";
import type { CoaSnapshot } from "./plan-preset";

export async function loadCoaSnapshot(db: DbExecutor, orgId: string): Promise<CoaSnapshot> {
  const [accountRows, mappingRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        accountNumber: accounts.accountNumber,
        name: accounts.name,
        accountType: accounts.accountType,
        subtype: accounts.subtype,
        parentId: accounts.parentId,
        isActive: accounts.isActive,
        isSystem: accounts.isSystem,
      })
      .from(accounts)
      .where(eq(accounts.organizationId, orgId)),
    db
      .select({
        mappingType: categoryMappings.mappingType,
        sourceKey: categoryMappings.sourceKey,
        targetCategoryId: categoryMappings.targetCategoryId,
      })
      .from(categoryMappings)
      .where(eq(categoryMappings.organizationId, orgId)),
  ]);

  return { accounts: accountRows, mappings: mappingRows };
}
