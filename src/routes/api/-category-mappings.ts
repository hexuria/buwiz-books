/**
 * Category Mappings API
 * CRUD for per-org category mapping overrides (bank, bill, invoice).
 * Replaces the localStorage-based persistence.
 */
import { createServerFn } from "@tanstack/react-start";
import { categoryMappings } from "../../db/schema/category-mappings";
import { assertMappingTargetAssignable } from "../../lib/coa/account-guards";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { resolveMappedAccountIds } from "../../lib/coa/resolve-mapped-account";
import { MAPPING_TYPES } from "../../lib/coa/mapping-types";

// ============================================================================
// List all mappings for an organization by type
// ============================================================================

const listSchema = z.object({
  mappingType: z.string().min(1),
});

export const listCategoryMappings = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { mappingType } = listSchema.parse(rawData);

      const rows = await db
        .select({
          sourceKey: categoryMappings.sourceKey,
          targetCategoryId: categoryMappings.targetCategoryId,
        })
        .from(categoryMappings)
        .where(
          and(
            eq(categoryMappings.organizationId, orgId),
            eq(categoryMappings.mappingType, mappingType),
          ),
        );

      const result: Record<string, string> = {};
      for (const row of rows) {
        result[row.sourceKey] = row.targetCategoryId;
      }
      return result;
    });
  },
);

// ============================================================================
// Resolve mappings to real accounts (server-side fallback chain)
// ============================================================================

const resolveSchema = z.object({
  mappingType: z.enum(MAPPING_TYPES),
  sourceKeys: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * Resolve mapping keys to ledger account ids using the same chain the posting
 * paths use.
 *
 * Client components must call this instead of resolving locally: the old
 * client-side `resolveMappedCategory` fell back to `ledgerAccounts[0]`, which
 * could prefill a bill line with an arbitrary account of roughly the right
 * type. Here, unresolvable is `null` and the caller shows an empty field.
 */
export const getMappedAccounts = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { mappingType, sourceKeys } = resolveSchema.parse(rawData);
      return resolveMappedAccountIds(db, orgId, mappingType, sourceKeys);
    });
  },
);

// ============================================================================
// Upsert a single mapping
// ============================================================================

const upsertSchema = z.object({
  mappingType: z.string().min(1),
  sourceKey: z.string().min(1),
  targetCategoryId: z.string().uuid(),
});

export const upsertCategoryMapping = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "category-mapping:upsert", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { mappingType, sourceKey, targetCategoryId } = upsertSchema.parse(rawData);

        // The upsert used to accept free-form strings and any UUID: a typo'd
        // sourceKey created an orphan row, and a wrong target silently
        // rerouted the posting path the day the mapping was read.
        await assertMappingTargetAssignable(db, orgId, mappingType, sourceKey, targetCategoryId);

        const [row] = await db
          .insert(categoryMappings)
          .values({
            organizationId: orgId,
            mappingType,
            sourceKey,
            targetCategoryId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              categoryMappings.organizationId,
              categoryMappings.mappingType,
              categoryMappings.sourceKey,
            ],
            set: {
              targetCategoryId,
              updatedAt: new Date(),
            },
          })
          .returning();

        return row;
      },
    );
  },
);

// ============================================================================
// Delete a single mapping (revert to default)
// ============================================================================

const deleteSchema = z.object({
  mappingType: z.string().min(1),
  sourceKey: z.string().min(1),
});

export const deleteCategoryMapping = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "category-mapping:delete", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { mappingType, sourceKey } = deleteSchema.parse(rawData);

        await db
          .delete(categoryMappings)
          .where(
            and(
              eq(categoryMappings.organizationId, orgId),
              eq(categoryMappings.mappingType, mappingType),
              eq(categoryMappings.sourceKey, sourceKey),
            ),
          );

        return { success: true };
      },
    );
  },
);

// ============================================================================
// Reset all mappings for a type (revert all to defaults)
// ============================================================================

const resetSchema = z.object({
  mappingType: z.string().min(1),
});

export const resetCategoryMappings = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "category-mapping:reset", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { mappingType } = resetSchema.parse(rawData);

        await db
          .delete(categoryMappings)
          .where(
            and(
              eq(categoryMappings.organizationId, orgId),
              eq(categoryMappings.mappingType, mappingType),
            ),
          );

        return { success: true };
      },
    );
  },
);
