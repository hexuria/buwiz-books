// ============================================================================
// Chart-of-accounts appliers.
//
// ADDITIVE ONLY in v1. `coaAccountsApplier` declares `account:create` and
// nothing else, and it can only ever insert: renaming or reparenting an
// existing account silently redirects where posted money lands and re-signs
// history, which is not a thing an approval click should be able to do.
//
// Neither applier writes to `accounts` itself. The COA one converts its
// payload into a `CoaPreset`-shaped object and hands it to the SAME
// planCoaPreset + executeCoaPlan path the deterministic presets use — which
// owns the org advisory lock, level-by-level insertion, number-collision
// handling, the activity log, and the mapping-completeness postcondition.
// Duplicating any of that here is how the two paths would drift.
//
// Both RE-VALIDATE against live state. A proposal payload is data at rest:
// between creation and approval a parent can be deleted, a name can be taken,
// and an account number can be claimed.
// ============================================================================

import { and, eq, inArray } from "drizzle-orm";
import { accounts } from "../../../db/schema/accounts";
import { categoryMappings } from "../../../db/schema/category-mappings";
import type { AccountType } from "../../../db/schema/account-constants";
import { assertMappingCompleteness, executeCoaPlan, lockCoaForOrg } from "../../coa/execute-plan";
import { isMappingTargetCompatible, mappingRowFor } from "../../coa/mapping-registry";
import { planCoaPreset, type ExistingAccount } from "../../coa/plan-preset";
import type { CoaPreset, PresetAccount } from "../../coa/preset-types";
import { loadCoaSnapshot } from "../../coa/snapshot";
import {
  validateCoaDraft,
  type DraftAccountInput,
  type ValidatedDraftAccount,
} from "../../coa/validate-draft";
import { createLogger } from "../../logger";
import { categoryMappingProposalSchema, coaAccountsProposalSchema } from "../proposal-types";
// Type-only: a value import here would close a require cycle with index.ts.
import type { ApplierContext, ProposalApplier } from "./index";

const logger = createLogger("ai.appliers.coa");

/**
 * Provenance id for the synthesized preset. It only ever reaches
 * `plan.presetId` and the activity-log row, and using a catalog id there would
 * claim a shipped pack was applied when it was not. Cast because `CoaPresetId`
 * is the closed set of SHIPPED packs and this is deliberately not one.
 */
/**
 * Deliberately NOT a catalog id: the activity log and `plan.presetId` must not
 * claim a shipped pack was applied when the accounts came from a model draft.
 */
const AI_PRESET_ID = "ai_coa_draft";

/** Icons mirror the roots in `presets/base.ts`, so a drafted account renders. */
const DRAFT_ICONS: Record<AccountType, string> = {
  asset: "Wallet",
  liability: "Iou",
  equity: "Certificate01",
  revenue: "SvgTagDollar",
  cost_of_revenue: "BagDollar01",
  expense: "Opex",
  other_income: "OtherIncome",
  other_expense: "OtherExpenses",
};

/**
 * Turn validated accounts into a preset tree.
 *
 * Existing parents become TOP-LEVEL preset nodes carrying their real name,
 * number and type; the planner resolves those by account number and marks them
 * "reuse", which is how a drafted child gets a `parentAccountId` without this
 * module ever touching the accounts table. Their `subtype` is null so
 * `fillMissingSubtypes` has nothing to write even if it were enabled.
 */
export function buildDraftPreset(
  drafted: ValidatedDraftAccount[],
  existing: ExistingAccount[],
): CoaPreset {
  const existingById = new Map(existing.map((a) => [a.id, a]));
  const childrenOfDraft = new Map<string, ValidatedDraftAccount[]>();
  for (const account of drafted) {
    if (!account.parentDraftKey) continue;
    const bucket = childrenOfDraft.get(account.parentDraftKey);
    if (bucket) bucket.push(account);
    else childrenOfDraft.set(account.parentDraftKey, [account]);
  }

  const toPresetAccount = (account: ValidatedDraftAccount): PresetAccount => ({
    key: account.key,
    name: account.name,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
    subtype: account.subtype,
    icon: DRAFT_ICONS[account.accountType],
    ...(account.description ? { description: account.description } : {}),
    // Never model- or reviewer-supplied. Only preset roots are system.
    isSystem: false,
    ...(childrenOfDraft.has(account.key)
      ? { children: childrenOfDraft.get(account.key)!.map(toPresetAccount) }
      : {}),
  });

  const byParent = new Map<string, ValidatedDraftAccount[]>();
  for (const account of drafted) {
    if (!account.parentAccountId) continue;
    const bucket = byParent.get(account.parentAccountId);
    if (bucket) bucket.push(account);
    else byParent.set(account.parentAccountId, [account]);
  }

  const roots: PresetAccount[] = [];
  for (const [parentId, children] of byParent) {
    const parent = existingById.get(parentId);
    if (!parent?.accountNumber) continue;
    roots.push({
      key: `__existing_${parentId}`,
      name: parent.name,
      accountNumber: parent.accountNumber,
      accountType: parent.accountType as AccountType,
      subtype: null,
      icon: "",
      isSystem: false,
      children: children.map(toPresetAccount),
    });
  }

  return {
    id: AI_PRESET_ID,
    version: 0,
    label: "AI-drafted accounts",
    description: "Accounts drafted by the chart-of-accounts scaffold and approved by a human",
    industries: [],
    accounts: roots,
    mappings: [],
    entities: [],
  };
}

export const coaAccountsApplier: ProposalApplier = {
  requiredPermissions() {
    // Additive only: nothing here updates or deletes an account.
    return [{ resource: "account", action: "create" }];
  },

  async apply(ctx: ApplierContext, payload: unknown) {
    const parsed = coaAccountsProposalSchema.parse(payload);

    // Take the lock BEFORE the snapshot, so a concurrent apply cannot change
    // the chart between validation and execution.
    await lockCoaForOrg(ctx.db, ctx.orgId);
    const snapshot = await loadCoaSnapshot(ctx.db, ctx.orgId);

    const excluded = new Set(parsed.excludedKeys);
    const overrides = new Map(parsed.overrides.map((o) => [o.key, o]));

    const inputs: DraftAccountInput[] = parsed.accounts
      .filter((account) => !excluded.has(account.key))
      .map((account) => {
        const override = overrides.get(account.key);
        const parentAccountId =
          override && "parentAccountId" in override
            ? (override.parentAccountId ?? null)
            : account.parentAccountId;
        return {
          key: account.key,
          name: override?.name ?? account.name,
          accountType: account.accountType,
          subtype: override?.subtype ?? account.subtype,
          description: account.description,
          // The validator works on an abstract parent namespace. Here that
          // namespace is account IDs, so the map is the identity over every
          // account still eligible to be a parent — a parent deleted since the
          // proposal was written simply is not in it, and the drafted account
          // degrades to the root for its type.
          parentKey: parentAccountId ?? "",
          // An excluded parent is not going to exist; drop the link so the
          // child degrades rather than dangling.
          parentDraftKey: excluded.has(account.parentDraftKey) ? "" : account.parentDraftKey,
        };
      });

    const identityKeys = new Map<string, string>();
    for (const account of snapshot.accounts) identityKeys.set(account.id, account.id);

    const validation = validateCoaDraft(inputs, {
      existing: snapshot.accounts,
      parentKeys: identityKeys,
    });

    if (validation.accounts.length === 0) {
      logger.warn("COA proposal applied with nothing left to create", {
        orgId: ctx.orgId,
        rejected: validation.rejected.length,
      });
      return {
        created: 0,
        skipped: validation.rejected.length,
        rejected: validation.rejected,
      };
    }

    const preset = buildDraftPreset(validation.accounts, snapshot.accounts);
    const plan = planCoaPreset(snapshot, preset, {
      // Drafted numbers are ours to move; a collision must not abort the batch.
      onConflict: "renumber",
      // This applier holds account:create and nothing else. Filling a subtype
      // is an UPDATE to an account that may already carry journal lines.
      fillMissingSubtypes: false,
      overwriteExistingMappings: false,
      createScaffoldEntities: false,
      // Bounded to the reviewed batch: no synthesizing accounts for unrelated
      // mapping gaps, and no failing this approval because of one.
      fillMappingGaps: false,
    });

    const result = await executeCoaPlan(ctx.db, ctx.orgId, plan, ctx.userId);

    return {
      created: result.created,
      renumbered: result.renumbered,
      skipped: validation.rejected.length,
      rejected: validation.rejected,
      warnings: result.warnings,
    };
  },
};

export const categoryMappingApplier: ProposalApplier = {
  requiredPermissions() {
    // Posting defaults are org configuration, and choosing one means reading
    // the chart. Both keys, explicitly.
    return [
      { resource: "organization", action: "update" },
      { resource: "account", action: "view" },
    ];
  },

  async apply(ctx: ApplierContext, payload: unknown) {
    const parsed = categoryMappingProposalSchema.parse(payload);
    const excluded = new Set(parsed.excludedKeys);
    const candidates = parsed.assignments.filter(
      (a) => !excluded.has(`${a.mappingType}:${a.sourceKey}`),
    );
    if (candidates.length === 0) return { written: 0, skipped: 0 };

    const targets = await ctx.db
      .select({
        id: accounts.id,
        name: accounts.name,
        accountType: accounts.accountType,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, ctx.orgId),
          inArray(
            accounts.id,
            candidates.map((a) => a.targetAccountId),
          ),
        ),
      );
    const byId = new Map(targets.map((t) => [t.id, t]));

    let written = 0;
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const assignment of candidates) {
      const key = `${assignment.mappingType}:${assignment.sourceKey}`;
      const row = mappingRowFor(assignment.mappingType, assignment.sourceKey);
      if (!row) {
        skipped.push({ key, reason: "unknown_mapping_row" });
        continue;
      }
      const target = byId.get(assignment.targetAccountId);
      // Silently inert, by design: a stale or hostile assignment must change
      // nothing, and must not take the rest of the batch down with it.
      if (!target || !target.isActive) {
        skipped.push({ key, reason: "target_unavailable" });
        continue;
      }
      if (!isMappingTargetCompatible(row, target)) {
        skipped.push({ key, reason: "incompatible_target" });
        continue;
      }

      await ctx.db
        .insert(categoryMappings)
        .values({
          organizationId: ctx.orgId,
          mappingType: assignment.mappingType,
          sourceKey: assignment.sourceKey,
          targetCategoryId: target.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            categoryMappings.organizationId,
            categoryMappings.mappingType,
            categoryMappings.sourceKey,
          ],
          set: { targetCategoryId: target.id, updatedAt: new Date() },
        });
      written++;
    }

    if (skipped.length > 0) {
      logger.warn("Skipped incompatible or stale mapping assignments", {
        orgId: ctx.orgId,
        skipped,
      });
    }

    // Same postcondition executeCoaPlan asserts: re-pointing a default must
    // never leave the org with a mapping row that resolves to nothing.
    await assertMappingCompleteness(ctx.db, ctx.orgId);

    return { written, skipped: skipped.length, skippedRows: skipped };
  },
};
