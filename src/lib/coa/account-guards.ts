/**
 * DB-backed guards for the account and mapping mutation surface (audit
 * PR-14).
 *
 * The chart of accounts and category_mappings are one system: a mapping row
 * pointing at a missing, foreign, inactive, or type-incompatible account is
 * data at rest that breaks the posting path the day it is read — a bill
 * journal debiting a revenue account, or an UnmappedAccountError in the
 * middle of an approval. These guards make the incompatible states
 * unrepresentable at write time.
 */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { categoryMappings } from "@/db/schema/category-mappings";
import { isMappingTargetCompatible, mappingRowFor } from "./mapping-registry";

/**
 * Validate a (mappingType, sourceKey) -> account assignment before it is
 * written. The old upsert accepted free-form strings and any UUID; a typo'd
 * sourceKey created an orphan row and a wrong target silently rerouted
 * posting.
 */
export async function assertMappingTargetAssignable(
  db: DbExecutor,
  orgId: string,
  mappingType: string,
  sourceKey: string,
  targetCategoryId: string,
): Promise<void> {
  const row = mappingRowFor(mappingType, sourceKey);
  if (!row) {
    throw new Error(`Unknown mapping ${mappingType}/${sourceKey}`);
  }
  const [account] = await db
    .select({ accountType: accounts.accountType, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.id, targetCategoryId), eq(accounts.organizationId, orgId)))
    .limit(1);
  if (!account || !account.isActive) {
    throw new Error("Target account is unavailable for this organization");
  }
  if (!isMappingTargetCompatible(row, account)) {
    throw new Error(
      `${row.label ?? sourceKey} must map to a ${row.ledgerType} account, not ${account.accountType}`,
    );
  }
}

/**
 * Checkpoint C7: an account that is the live target of any category mapping
 * cannot be deactivated or deleted — every registry row is posting-relevant,
 * so a dangling target turns into a posting failure (or a mis-post) at the
 * moment somebody approves a bill or captures a payment. Repoint first.
 */
export async function assertNotMappingTarget(
  db: DbExecutor,
  orgId: string,
  accountId: string,
  action: "deactivate" | "delete",
): Promise<void> {
  const rows = await db
    .select({
      mappingType: categoryMappings.mappingType,
      sourceKey: categoryMappings.sourceKey,
    })
    .from(categoryMappings)
    .where(
      and(
        eq(categoryMappings.organizationId, orgId),
        eq(categoryMappings.targetCategoryId, accountId),
      ),
    );
  if (rows.length === 0) return;
  const keys = rows.map((row) => `${row.mappingType}/${row.sourceKey}`).join(", ");
  throw new Error(
    `This account is the mapping target for ${keys}. Repoint the mapping in Settings before ${
      action === "delete" ? "deleting" : "deactivating"
    } the account.`,
  );
}

/**
 * Validate a parent reassignment: the parent must exist IN THIS ORGANIZATION
 * (the old cycle walk silently broke out on a foreign id and then wrote it),
 * carry the same root account type (nesting an expense under an asset breaks
 * every type-rollup), and not create a cycle — walked with a hard depth cap
 * so pre-existing bad data cannot spin the request forever.
 */
export async function assertValidParentAssignment(
  db: DbExecutor,
  orgId: string,
  accountId: string,
  parentId: string,
  accountType: string,
): Promise<void> {
  if (parentId === accountId) {
    throw new Error("Account cannot be its own parent");
  }
  const [parent] = await db
    .select({ accountType: accounts.accountType, parentId: accounts.parentId })
    .from(accounts)
    .where(and(eq(accounts.id, parentId), eq(accounts.organizationId, orgId)))
    .limit(1);
  if (!parent) {
    throw new Error("Parent account is unavailable for this organization");
  }
  if (parent.accountType !== accountType) {
    throw new Error(
      `Parent must be the same account type (${accountType}), not ${parent.accountType}`,
    );
  }
  let currentParentId: string | null = parent.parentId;
  for (let depth = 0; currentParentId; depth++) {
    if (depth >= 100) {
      throw new Error("Account hierarchy is too deep to verify — contact support");
    }
    if (currentParentId === accountId) {
      throw new Error("Cannot move account under its own descendant (would create a cycle)");
    }
    const [ancestor] = await db
      .select({ parentId: accounts.parentId })
      .from(accounts)
      .where(and(eq(accounts.id, currentParentId), eq(accounts.organizationId, orgId)))
      .limit(1);
    if (!ancestor) break;
    currentParentId = ancestor.parentId;
  }
}
