/**
 * The single server-side resolver for "which ledger account does this domain
 * concept post to?".
 *
 * Before this existed, `category_mappings` was effectively write-only: the two
 * client callers of `resolveMappedCategory` both omitted the `serverMappings`
 * argument, the bank path read localStorage, and everything else scanned for a
 * hardcoded subtype. A user could configure mappings and change no behavior.
 *
 * Two rules bound the blast radius of finally honoring saved mappings:
 *
 *  1. A stored mapping is honored ONLY if its target is still in this org,
 *     still active, and still of the row's `ledgerType`. `deleteAccount` is a
 *     soft delete, so stale mappings are the common case, not the rare one —
 *     and a "Default Expense" pointed at a liability would unbalance every bill
 *     journal the moment we started reading the table.
 *
 *  2. There is no "first account of roughly the right type" fallback. The old
 *     `ledgerAccounts[0]` tier would happily post a bill line to Accounts
 *     Receivable. Unresolvable returns null (or throws, for posting paths).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { accounts } from "../../db/schema/accounts";
import { categoryMappings } from "../../db/schema/category-mappings";
import { mappingRowFor } from "./mapping-registry";
import type { MappingType } from "./mapping-types";

export class UnmappedAccountError extends Error {
  constructor(
    readonly mappingType: string,
    readonly sourceKey: string,
    readonly label: string,
  ) {
    super(
      `No ledger account is configured for "${label}". Set it under Settings → Mappings, or apply a chart-of-accounts preset.`,
    );
    this.name = "UnmappedAccountError";
  }
}

export interface ResolvedAccount {
  id: string;
  name: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
  source: "mapping" | "subtype";
}

/**
 * Resolve one mapping row to an account.
 *
 * @returns the account, or null when nothing valid matches.
 */
export async function resolveMappedAccount(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKey: string,
): Promise<ResolvedAccount | null> {
  const row = mappingRowFor(mappingType, sourceKey);
  if (!row) return null;

  const columns = {
    id: accounts.id,
    name: accounts.name,
    accountNumber: accounts.accountNumber,
    accountType: accounts.accountType,
    subtype: accounts.subtype,
  };

  // Tier 1 — the configured mapping, type-guarded.
  const [mapped] = await db
    .select(columns)
    .from(categoryMappings)
    .innerJoin(accounts, eq(accounts.id, categoryMappings.targetCategoryId))
    .where(
      and(
        eq(categoryMappings.organizationId, orgId),
        eq(categoryMappings.mappingType, mappingType),
        eq(categoryMappings.sourceKey, sourceKey),
        eq(accounts.organizationId, orgId),
        eq(accounts.isActive, true),
        eq(accounts.accountType, row.ledgerType),
      ),
    )
    .limit(1);
  if (mapped) return { ...mapped, source: "mapping" };

  // Tier 2 — subtype match, deterministically ordered. The previous resolvers
  // used `.limit(1)` with no ORDER BY, so which account got credited depended
  // on the query plan.
  const [matched] = await db
    .select(columns)
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, orgId),
        eq(accounts.isActive, true),
        eq(accounts.accountType, row.ledgerType),
        eq(accounts.subtype, row.defaultSubtype),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${accounts.accountNumber} = ${row.defaultNumber} THEN 0 ELSE 1 END`,
      sql`${accounts.accountNumber} ASC NULLS LAST`,
      asc(accounts.createdAt),
      asc(accounts.id),
    )
    .limit(1);
  if (matched) return { ...matched, source: "subtype" };

  return null;
}

export async function resolveMappedAccountId(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKey: string,
): Promise<string | null> {
  const account = await resolveMappedAccount(db, orgId, mappingType, sourceKey);
  return account?.id ?? null;
}

/** Posting paths use this: an unresolvable account must fail loudly and actionably. */
export async function requireMappedAccountId(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKey: string,
): Promise<string> {
  const account = await resolveMappedAccount(db, orgId, mappingType, sourceKey);
  if (!account) {
    const row = mappingRowFor(mappingType, sourceKey);
    throw new UnmappedAccountError(mappingType, sourceKey, row?.label ?? sourceKey);
  }
  return account.id;
}

/**
 * The mapped account plus every descendant, for REPORTING rather than posting.
 *
 * Aging reports must match all lines under the AP/AR account, not just the one
 * mapped account — sub-accounts of Accounts Payable are still payables.
 * Narrowing an aging report to a single account silently understates what the
 * business owes, so callers union this with the subtype predicate: the result
 * can only widen coverage, never shrink it.
 */
export async function mappedAccountFamilyIds(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKey: string,
): Promise<string[]> {
  const account = await resolveMappedAccount(db, orgId, mappingType, sourceKey);
  if (!account) return [];
  const { getAllDescendantIds } = await import("../account-helpers");
  const descendants = await getAllDescendantIds(db, account.id, orgId);
  return [account.id, ...descendants];
}

/** Batch variant for UI prefill — one round trip per tier, never N+1. */
export async function resolveMappedAccountIds(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKeys: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(
    sourceKeys.map(async (sourceKey) => {
      out[sourceKey] = await resolveMappedAccountId(db, orgId, mappingType, sourceKey);
    }),
  );
  return out;
}
