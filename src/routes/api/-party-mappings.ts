/**
 * Party Type Mappings API
 * CRUD for per-org overrides to SUBTYPE_PARTY_MAP defaults.
 * Supports separate read and mutate type arrays per subtype.
 */
import { createServerFn } from "@tanstack/react-start";
import { partyTypeMappings } from "../../db/schema/party-type-mappings";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import type { PartyMappingOverride, PartyType } from "../../lib/party-scoping";

// ============================================================================
// List all overrides for an organization
// ============================================================================

export const listPartyMappings = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const rows = await db
      .select({
        subtype: partyTypeMappings.subtype,
        readTypes: partyTypeMappings.readTypes,
        mutateTypes: partyTypeMappings.mutateTypes,
      })
      .from(partyTypeMappings)
      .where(eq(partyTypeMappings.organizationId, orgId));

    const result: Record<string, PartyMappingOverride> = {};
    for (const row of rows) {
      result[row.subtype] = {
        readTypes: row.readTypes as PartyType[],
        mutateTypes: row.mutateTypes as PartyType[],
      };
    }
    return result;
  });
});

// ============================================================================
// Upsert a single subtype mapping
// ============================================================================

const upsertSchema = z.object({
  subtype: z.string().min(1),
  readTypes: z.array(z.string()).min(1),
  mutateTypes: z.array(z.string()).min(1),
});

export const upsertPartyMapping = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof upsertSchema>) => upsertSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "party-mapping:upsert", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { subtype, readTypes, mutateTypes } = upsertSchema.parse(rawData);

        const [row] = await db
          .insert(partyTypeMappings)
          .values({
            organizationId: orgId,
            subtype,
            readTypes,
            mutateTypes,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [partyTypeMappings.organizationId, partyTypeMappings.subtype],
            set: {
              readTypes,
              mutateTypes,
              updatedAt: new Date(),
            },
          })
          .returning();

        return row;
      },
    );
  });

// ============================================================================
// Delete a single subtype override (revert to default)
// ============================================================================

const deleteSchema = z.object({
  subtype: z.string().min(1),
});

export const deletePartyMapping = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof deleteSchema>) => deleteSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "party-mapping:delete", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { subtype } = deleteSchema.parse(rawData);

        await db
          .delete(partyTypeMappings)
          .where(
            and(
              eq(partyTypeMappings.organizationId, orgId),
              eq(partyTypeMappings.subtype, subtype),
            ),
          );

        return { success: true };
      },
    );
  });

// ============================================================================
// Reset all overrides for the organization
// ============================================================================

const resetPartyMappingsSchema = z.object({});

export const resetPartyMappings = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof resetPartyMappingsSchema>) =>
    resetPartyMappingsSchema.parse(data ?? {}),
  )
  .handler(async () => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "party-mapping:reset", limit: 10, windowMs: 60_000 },
      async ({ orgId, db }) => {
        await db.delete(partyTypeMappings).where(eq(partyTypeMappings.organizationId, orgId));

        return { success: true };
      },
    );
  });
