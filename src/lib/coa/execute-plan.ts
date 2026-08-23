/**
 * Preset executor — the only code that turns a PresetPlan into writes.
 *
 * Atomicity comes for free: `withOrgContext` already wraps its callback in
 * `db.transaction`, so `ctx.db` IS a transaction and one throw rolls back
 * accounts, mappings and entities together. That is why this file deliberately
 * does NOT try/catch per row the way the CSV/export importers do — a
 * half-applied chart is worse than none — and why it must not open a nested
 * transaction, which would only create a savepoint and obscure the guarantee.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { accounts } from "../../db/schema/accounts";
import { activityLogs } from "../../db/schema/activity-logs";
import { categoryMappings } from "../../db/schema/category-mappings";
import { financialAccounts } from "../../db/schema/financial-accounts";
import { createLogger } from "../logger";
import { allMappingKeys } from "./mapping-registry";
import type { PresetPlan } from "./plan-preset";

const logger = createLogger("coa:execute-plan");

export interface PresetApplyResult {
  presetId: string;
  presetVersion: number;
  created: number;
  reused: number;
  subtypesFilled: number;
  mappingsWritten: number;
  mappingsSkipped: number;
  entitiesCreated: number;
  renumbered: Array<{ name: string; from: string; to: string }>;
  warnings: string[];
}

export class PresetConflictError extends Error {
  constructor(readonly conflicts: PresetPlan["conflicts"]) {
    super(
      `Cannot apply preset: ${conflicts.length} account number(s) are already used by accounts of a different type — ` +
        conflicts
          .map(
            (c) =>
              `${c.accountNumber} is ${c.existingAccountType}, preset expects ${c.presetAccountType}`,
          )
          .join("; "),
    );
    this.name = "PresetConflictError";
  }
}

/**
 * Serialize chart-of-accounts work for one organization.
 *
 * Callers should take this BEFORE loading the snapshot they plan from,
 * otherwise two concurrent applies can both read an empty chart and the loser
 * only discovers the collision at insert time. Advisory locks are re-entrant
 * within a transaction, so `executeCoaPlan` re-acquiring it is free.
 */
export async function lockCoaForOrg(db: DbExecutor, orgId: string): Promise<void> {
  const lockKey = `${orgId}:coa-preset`;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

/**
 * @param db MUST already be inside `withOrgContext` for this same `orgId`.
 */
export async function executeCoaPlan(
  db: DbExecutor,
  orgId: string,
  plan: PresetPlan,
  actorId: string | null = null,
): Promise<PresetApplyResult> {
  // Turn "called outside an org-context wrapper" from a silent cross-tenant
  // write into a throw. RLS policies are permissive today (`current_org IS NULL
  // OR ...`), so without this the whole apply would run unscoped.
  const [ctx] = await db.execute<{ current_org: string | null }>(
    sql`SELECT current_setting('app.current_organization_id', true) AS current_org`,
  );
  if (!ctx?.current_org) {
    throw new Error(
      "executeCoaPlan must run inside withOrgContext — no organization context is set",
    );
  }
  if (ctx.current_org !== orgId) {
    throw new Error(
      `executeCoaPlan called for organization ${orgId} inside a context for ${ctx.current_org}`,
    );
  }

  // Serialize concurrent applies for this org rather than racing the
  // accounts_org_account_number_unique index. Released at commit or rollback,
  // so there is no cleanup path to get wrong. The per-route rate-limit guard is
  // process-local and does not help across replicas; this does.
  await lockCoaForOrg(db, orgId);

  if (plan.conflicts.length > 0 && plan.options.onConflict === "abort") {
    throw new PresetConflictError(plan.conflicts);
  }

  // ── Accounts ──────────────────────────────────────────────────────────
  // Ids are minted here so children can reference parents without a second
  // UPDATE pass. Inserted level by level rather than as one multi-row VALUES:
  // that would satisfy the self-FK through row ordering, but relying on
  // intra-statement ordering for referential integrity is not worth the risk.
  const idByKey = new Map<string, string>();
  for (const reused of plan.reuseAccounts) idByKey.set(reused.key, reused.accountId);
  for (const planned of plan.createAccounts) idByKey.set(planned.key, randomUUID());

  const byDepth = new Map<number, typeof plan.createAccounts>();
  for (const planned of plan.createAccounts) {
    const bucket = byDepth.get(planned.depth);
    if (bucket) bucket.push(planned);
    else byDepth.set(planned.depth, [planned]);
  }

  let created = 0;
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const rows = byDepth.get(depth)!.map((planned) => ({
      id: idByKey.get(planned.key)!,
      organizationId: orgId,
      name: planned.name,
      accountNumber: planned.accountNumber,
      accountType: planned.accountType,
      subtype: planned.subtype,
      description: planned.description,
      icon: planned.icon,
      parentId:
        planned.parentAccountId ?? (planned.parentKey ? idByKey.get(planned.parentKey)! : null),
      // Only preset roots are system. Nothing user- or model-supplied reaches this.
      isSystem: planned.isSystem,
      isActive: true,
      status: "active",
    }));
    if (rows.length === 0) continue;
    const inserted = await db
      .insert(accounts)
      .values(rows)
      // Belt-and-braces against a concurrent apply that slipped past the lock.
      .onConflictDoNothing({ target: [accounts.organizationId, accounts.accountNumber] })
      .returning({ id: accounts.id });
    created += inserted.length;
    if (inserted.length !== rows.length) {
      // A skipped row means a child could reference an id that was never
      // inserted, so fail loudly rather than leaving a dangling parent.
      throw new Error(
        `Account number collision during apply: expected ${rows.length} inserts at depth ${depth}, got ${inserted.length}`,
      );
    }
  }

  // ── Subtype repairs (NULL -> value only) ──────────────────────────────
  for (const fill of plan.subtypeFills) {
    await db
      .update(accounts)
      .set({ subtype: fill.subtype, updatedAt: new Date() })
      .where(
        and(
          eq(accounts.id, fill.accountId),
          eq(accounts.organizationId, orgId),
          // Re-assert the precondition: only ever fill a NULL.
          sql`${accounts.subtype} IS NULL`,
        ),
      );
  }

  // ── Mappings ──────────────────────────────────────────────────────────
  let mappingsWritten = 0;
  let mappingsSkipped = 0;
  for (const mapping of plan.mappings) {
    if (mapping.skipped) {
      mappingsSkipped++;
      continue;
    }
    const targetId =
      mapping.targetAccountId ?? (mapping.targetKey ? idByKey.get(mapping.targetKey) : null);
    if (!targetId) {
      mappingsSkipped++;
      continue;
    }
    await db
      .insert(categoryMappings)
      .values({
        organizationId: orgId,
        mappingType: mapping.mappingType,
        sourceKey: mapping.sourceKey,
        targetCategoryId: targetId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          categoryMappings.organizationId,
          categoryMappings.mappingType,
          categoryMappings.sourceKey,
        ],
        set: { targetCategoryId: targetId, updatedAt: new Date() },
      });
    mappingsWritten++;
  }

  // ── Entities (opt-in only) ────────────────────────────────────────────
  let entitiesCreated = 0;
  for (const entity of plan.entities) {
    const ledgerAccountId = idByKey.get(entity.ledgerAccountKey);
    if (!ledgerAccountId) continue;
    const inserted = await db
      .insert(financialAccounts)
      .values({
        organizationId: orgId,
        accountName: entity.accountName,
        institutionName: entity.institutionName,
        accountType: entity.accountType as never,
        ledgerAccountId,
        // A scaffolded row must never look like a connected, owned account.
        isManual: true,
        connectionStatus: "pending",
        isOwned: false,
        lastFour: null,
      })
      .returning({ id: financialAccounts.id });
    entitiesCreated += inserted.length;
  }

  // ── Postcondition: the completeness guarantee, checked not promised ────
  // Only when this plan was allowed to close mapping gaps. A reviewed batch
  // (the AI applier) is deliberately bounded to what the reviewer saw, so it
  // must not be failed by an unrelated pre-existing gap it was not permitted
  // to fix.
  if (plan.options.fillMappingGaps) {
    await assertMappingCompleteness(db, orgId);
  }

  await db.insert(activityLogs).values({
    organizationId: orgId,
    entityType: "coa_preset",
    // Polymorphic entity_id is a uuid column; the preset id lives in `changes`.
    entityId: randomUUID(),
    action: "applied",
    actorId,
    changes: {
      presetId: plan.presetId,
      presetVersion: plan.presetVersion,
      created,
      reused: plan.reuseAccounts.length,
      mappingsWritten,
    },
  });

  const result: PresetApplyResult = {
    presetId: plan.presetId,
    presetVersion: plan.presetVersion,
    created,
    reused: plan.reuseAccounts.length,
    subtypesFilled: plan.subtypeFills.length,
    mappingsWritten,
    mappingsSkipped,
    entitiesCreated,
    renumbered: plan.createAccounts
      .filter((a) => a.renumberedFrom)
      .map((a) => ({ name: a.name, from: a.renumberedFrom!, to: a.accountNumber })),
    warnings: plan.warnings,
  };
  logger.info("Applied chart-of-accounts preset", { orgId, ...result });
  return result;
}

/**
 * Every (mappingType, sourceKey) must resolve to a live, org-owned account.
 *
 * Throwing here rolls the whole apply back, so an organization ends up either
 * fully mapped or untouched. This is the direct anti-regression for the bug
 * that let `category_mappings` sit unreadable and half-populated.
 */
export async function assertMappingCompleteness(db: DbExecutor, orgId: string): Promise<void> {
  const rows = await db
    .select({
      mappingType: categoryMappings.mappingType,
      sourceKey: categoryMappings.sourceKey,
    })
    .from(categoryMappings)
    .innerJoin(accounts, eq(accounts.id, categoryMappings.targetCategoryId))
    .where(
      and(
        eq(categoryMappings.organizationId, orgId),
        eq(accounts.organizationId, orgId),
        eq(accounts.isActive, true),
      ),
    );

  const present = new Set(rows.map((r) => `${r.mappingType}:${r.sourceKey}`));
  const missing = allMappingKeys()
    .map((k) => `${k.mappingType}:${k.sourceKey}`)
    .filter((k) => !present.has(k));

  if (missing.length > 0) {
    throw new Error(
      `Chart-of-accounts apply incomplete: ${missing.length} mapping(s) unresolved (${missing.join(", ")}). ` +
        "If these were skipped because an earlier chart already mapped them to accounts that no " +
        "longer resolve, re-apply the preset with overwriteExistingMappings to repoint them.",
    );
  }
}

/** Accounts created by a preset apply, for the preview's "already present" note. */
export async function countPresetAccounts(db: DbExecutor, orgId: string, ids: string[]) {
  if (ids.length === 0) return 0;
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), inArray(accounts.id, ids)));
  return rows.length;
}
