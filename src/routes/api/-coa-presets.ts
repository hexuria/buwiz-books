/**
 * Chart-of-Accounts Preset Server Functions
 *
 * `previewCoaPreset` and `applyCoaPreset` run the SAME planner, so what a user
 * approves on the preview screen is exactly what executes.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertRolePermission } from "../../lib/auth-middleware";
import { executeCoaPlan, lockCoaForOrg } from "../../lib/coa/execute-plan";
import { planCoaPreset, isNoopPlan } from "../../lib/coa/plan-preset";
import { getPreset, listPresets, presetForIndustry } from "../../lib/coa/presets";
import { loadCoaSnapshot } from "../../lib/coa/snapshot";
import { flattenPresetAccounts } from "../../lib/coa/preset-types";
import { parseOrgMetadata } from "../../lib/org-metadata";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
  withSessionOrgContext,
} from "../../lib/server-context";
import type { DbExecutor } from "../../db";
import { organization } from "../../db/schema/auth";
import { accounts } from "../../db/schema/accounts";
import { count } from "drizzle-orm";
import { eq } from "drizzle-orm";

async function readOrgMetadata(db: DbExecutor, orgId: string) {
  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return parseOrgMetadata(org?.metadata);
}

async function recordAppliedPreset(
  db: DbExecutor,
  orgId: string,
  presetId: string,
  presetVersion: number,
) {
  const metadata = await readOrgMetadata(db, orgId);
  await db
    .update(organization)
    .set({
      metadata: JSON.stringify({
        ...metadata,
        coaPresetId: presetId,
        coaPresetVersion: presetVersion,
      }),
    })
    .where(eq(organization.id, orgId));
}

const planOptionsSchema = z.object({
  onConflict: z.enum(["abort", "renumber"]).optional(),
  fillMissingSubtypes: z.boolean().optional(),
  overwriteExistingMappings: z.boolean().optional(),
  createScaffoldEntities: z.boolean().optional(),
});

const previewSchema = z.object({
  presetId: z.string().min(1),
  options: planOptionsSchema.optional(),
});

const applySchema = z.object({
  presetId: z.string().min(1),
  options: planOptionsSchema.optional(),
  /**
   * The planHash the user saw on the preview. When supplied and the chart has
   * changed since, the apply aborts instead of doing something unreviewed.
   */
  expectedPlanHash: z.string().optional(),
});

// ============================================================================
// List
// ============================================================================

export const listCoaPresets = createServerFn({ method: "GET" }).handler(async () =>
  withSessionOrgContext(async ({ orgId, db }) => {
    const metadata = await readOrgMetadata(db, orgId);
    const recommended = presetForIndustry(metadata.industry);
    return {
      appliedPresetId: metadata.coaPresetId ?? null,
      appliedPresetVersion: metadata.coaPresetVersion ?? null,
      recommendedPresetId: recommended.id,
      industry: metadata.industry ?? null,
      presets: listPresets().map((preset) => ({
        id: preset.id,
        version: preset.version,
        label: preset.label,
        description: preset.description,
        industries: preset.industries,
        accountCount: flattenPresetAccounts(preset.accounts).length,
      })),
    };
  }),
);

// ============================================================================
// Chart status — is this org set up at all?
// ============================================================================

/**
 * Whether the org has any chart of accounts.
 *
 * Deliberately its own tiny fn rather than a field on `getAppConfig`, which is
 * not org-scoped, or on `listCoaPresets`, which loads the whole catalog and org
 * metadata. This runs on every app-entry guard pass, so it is one COUNT.
 *
 * An org with no accounts cannot post a bill, an invoice or a payment — every
 * resolver throws — so the app routes it to the Category Manager, which offers
 * the preset picker in its empty state.
 */
export const getChartStatus = createServerFn({ method: "GET" }).handler(async () =>
  withSessionOrgContext(async ({ orgId, db }) => {
    const [row] = await db
      .select({ total: count() })
      .from(accounts)
      .where(eq(accounts.organizationId, orgId));
    return { hasAccounts: (row?.total ?? 0) > 0 };
  }),
);

// ============================================================================
// Preview — read-only dry run
// ============================================================================

export const previewCoaPreset = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof previewSchema>) => previewSchema.parse(data))
  .handler(async ({ data }: { data: z.infer<typeof previewSchema> }) =>
    withPermissionOrgContext("account", "view", async ({ orgId, db }) => {
      const preset = getPreset(data.presetId);
      if (!preset) throw new Error(`Unknown chart-of-accounts preset "${data.presetId}"`);

      const snapshot = await loadCoaSnapshot(db, orgId);
      const plan = planCoaPreset(snapshot, preset, data.options ?? {});

      return {
        presetId: preset.id,
        presetLabel: preset.label,
        presetVersion: preset.version,
        planHash: plan.planHash,
        isNoop: isNoopPlan(plan),
        willCreate: plan.createAccounts.map((a) => ({
          name: a.name,
          accountNumber: a.accountNumber,
          accountType: a.accountType,
          subtype: a.subtype,
          renumberedFrom: a.renumberedFrom ?? null,
          synthesizedFor: a.synthesizedFor ?? null,
        })),
        willReuse: plan.reuseAccounts.map((a) => ({
          name: a.name,
          accountNumber: a.accountNumber,
          matchedBy: a.matchedBy,
        })),
        willFillSubtype: plan.subtypeFills.map((f) => ({ name: f.name, subtype: f.subtype })),
        willMap: plan.mappings
          .filter((m) => !m.skipped)
          .map((m) => ({ mappingType: m.mappingType, sourceKey: m.sourceKey, source: m.source })),
        keepsExistingMappings: plan.mappings.filter((m) => m.skipped).length,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
      };
    }),
  );

// ============================================================================
// Apply
// ============================================================================

export const applyCoaPreset = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof applySchema>) => applySchema.parse(data))
  .handler(async ({ data }: { data: z.infer<typeof applySchema> }) =>
    withMutationPermissionOrgContext(
      "account",
      "create",
      { routeKey: "coa-preset:apply", limit: 3, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const preset = getPreset(data.presetId);
        if (!preset) throw new Error(`Unknown chart-of-accounts preset "${data.presetId}"`);

        // The wrapper gates on account:create, but this also writes
        // category_mappings and (opt-in) financial_accounts. Assert those
        // explicitly so a future role change cannot silently widen one
        // permission into three.
        assertRolePermission(role, "organization", "update");
        if (data.options?.createScaffoldEntities) {
          assertRolePermission(role, "financialAccount", "create");
        }

        // Take the org lock BEFORE snapshotting, so a concurrent apply cannot
        // plan against a chart that is about to change underneath it.
        await lockCoaForOrg(db, orgId);
        const snapshot = await loadCoaSnapshot(db, orgId);
        const plan = planCoaPreset(snapshot, preset, data.options ?? {});

        if (data.expectedPlanHash && data.expectedPlanHash !== plan.planHash) {
          throw new Error(
            "Your chart of accounts changed since this preview was generated. Review the preset again before applying.",
          );
        }

        const result = await executeCoaPlan(db, orgId, plan, userId);

        await recordAppliedPreset(db, orgId, preset.id, preset.version);

        return result;
      },
    ),
  );
