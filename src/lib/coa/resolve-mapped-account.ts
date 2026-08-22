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
 *
 * Everything public here funnels through ONE implementation,
 * `resolveMappedAccountsBatch`. Resolving one key and resolving fifty run the
 * same code, so the single-key and batch paths cannot drift apart: a divergence
 * would show up as the settings UI prefilling a different account than the
 * posting path actually uses.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { accounts } from "../../db/schema/accounts";
import { categoryMappings } from "../../db/schema/category-mappings";
import { mappingRowFor } from "./mapping-registry";
import type { MappingRow, MappingType } from "./mapping-types";

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

/** Tier 2 rows come back from raw SQL, so they are typed by hand. */
interface SubtypeMatchRow {
  sourceKey: string;
  id: string;
  name: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
}

/**
 * Resolve many mapping keys at once.
 *
 * Cost: at most TWO round trips regardless of how many keys are passed — one
 * for the configured mappings, one for the subtype fallback (skipped entirely
 * when tier 1 answered everything). Every requested key gets an entry; unknown
 * or unresolvable keys map to null.
 */
async function resolveMappedAccountsBatch(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKeys: string[],
): Promise<Map<string, ResolvedAccount | null>> {
  const resolved = new Map<string, ResolvedAccount | null>();

  // Unknown keys are not an error — they simply resolve to nothing, exactly as
  // the single-key path has always behaved.
  const known = new Map<string, MappingRow>();
  for (const sourceKey of new Set(sourceKeys)) {
    const row = mappingRowFor(mappingType, sourceKey);
    resolved.set(sourceKey, null);
    if (row) known.set(sourceKey, row);
  }
  if (known.size === 0) return resolved;

  // ---- Tier 1 — the configured mapping, type-guarded. -------------------
  //
  // The `ledgerType` guard differs per key, so it is applied in JS rather than
  // in SQL. That is safe precisely because it is an equality test: unlike the
  // tier 2 ranking below, exact string comparison cannot disagree with
  // Postgres. `uq_org_mapping` on (organization_id, mapping_type, source_key)
  // guarantees at most one row per key, so no ranking is needed here either.
  const mappedRows = await db
    .select({
      sourceKey: categoryMappings.sourceKey,
      id: accounts.id,
      name: accounts.name,
      accountNumber: accounts.accountNumber,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
    })
    .from(categoryMappings)
    .innerJoin(accounts, eq(accounts.id, categoryMappings.targetCategoryId))
    .where(
      and(
        eq(categoryMappings.organizationId, orgId),
        eq(categoryMappings.mappingType, mappingType),
        inArray(categoryMappings.sourceKey, [...known.keys()]),
        eq(accounts.organizationId, orgId),
        eq(accounts.isActive, true),
      ),
    );

  for (const row of mappedRows) {
    const expected = known.get(row.sourceKey);
    if (!expected || row.accountType !== expected.ledgerType) continue;
    const { sourceKey, ...account } = row;
    resolved.set(sourceKey, { ...account, source: "mapping" });
  }

  // ---- Tier 2 — subtype match, deterministically ordered. ---------------
  const pending = [...known.entries()].filter(([sourceKey]) => !resolved.get(sourceKey));
  if (pending.length === 0) return resolved;

  // Raw SQL with a bound VALUES list and DISTINCT ON, rather than this repo's
  // usual `inArray` + group-in-JS idiom. Those precedents group but never RANK.
  // Ranking in JS would mean re-implementing this ORDER BY over
  // `account_number` — a nullable varchar(10) sorted under whatever collation
  // the cluster was initialized with, since nothing here sets COLLATE. A JS
  // comparator is not guaranteed to agree with Postgres, and the disagreement
  // would be silent. Keeping the ordering server-side removes that class of bug.
  //
  // The tie-break itself is unchanged from when this was one query per key:
  // the previous resolvers used `.limit(1)` with no ORDER BY at all, so which
  // account got credited depended on the query plan.
  const keyTuples = pending.map(
    ([sourceKey, row]) =>
      sql`(${sourceKey}::text, ${row.ledgerType}::text, ${row.defaultSubtype}::text, ${row.defaultNumber}::text)`,
  );

  const matched = (await db.execute(sql`
    select distinct on (k.source_key)
      k.source_key as "sourceKey",
      a.id as "id",
      a.name as "name",
      a.account_number as "accountNumber",
      a.account_type as "accountType",
      a.subtype as "subtype"
    from (values ${sql.join(keyTuples, sql`, `)})
      as k(source_key, ledger_type, default_subtype, default_number)
    join accounts a
      on a.organization_id = ${orgId}
     and a.is_active = true
     and a.account_type = k.ledger_type
     and a.subtype = k.default_subtype
    order by
      k.source_key,
      case when a.account_number = k.default_number then 0 else 1 end,
      a.account_number asc nulls last,
      a.created_at asc,
      a.id asc
  `)) as unknown as SubtypeMatchRow[];

  for (const row of matched) {
    const { sourceKey, ...account } = row;
    resolved.set(sourceKey, { ...account, source: "subtype" });
  }

  return resolved;
}

/**
 * Resolve one mapping row to an account.
 *
 * @returns the account, or null when nothing valid matches.
 */
async function resolveMappedAccount(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKey: string,
): Promise<ResolvedAccount | null> {
  const resolved = await resolveMappedAccountsBatch(db, orgId, mappingType, [sourceKey]);
  return resolved.get(sourceKey) ?? null;
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

/**
 * Batch variant for UI prefill.
 *
 * Two round trips total, not two per key — see `resolveMappedAccountsBatch`.
 * Every requested key appears in the result; unresolvable ones map to null.
 */
export async function resolveMappedAccountIds(
  db: DbExecutor,
  orgId: string,
  mappingType: MappingType,
  sourceKeys: string[],
): Promise<Record<string, string | null>> {
  const resolved = await resolveMappedAccountsBatch(db, orgId, mappingType, sourceKeys);
  const out: Record<string, string | null> = {};
  for (const sourceKey of sourceKeys) {
    out[sourceKey] = resolved.get(sourceKey)?.id ?? null;
  }
  return out;
}
