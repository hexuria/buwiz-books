/**
 * Category Connections API
 * CRUD for linking external data sources (bank accounts, cards, apps) to chart of accounts categories.
 * Powers the "Manage Connection" pattern .
 */
import { createServerFn } from "@tanstack/react-start";
import { escapeLikePattern } from "../../lib/sql-escape";
import type { DbExecutor } from "../../db";
import { categoryConnections } from "../../db/schema/connections";
import { accounts } from "../../db/schema/accounts";
import { parties } from "../../db/schema/parties";
import { partyableLinks } from "../../db/schema/partyable-links";
import { eq, and, ilike } from "drizzle-orm";
import { z } from "zod";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import type { PartyType } from "../../lib/party-scoping";

const SOURCE_TYPES = [
  "bank",
  "credit_card",
  "payroll",
  "payment_processor",
  "expense_management",
  "other",
] as const;

// Map connection source type → party type for auto-creation
// bank/credit_card are skipped (too generic — the institution name matters)
const SOURCE_TYPE_TO_PARTY_TYPE: Record<string, PartyType | null> = {
  bank: null, // Skip — banks don't map to a party
  credit_card: null,
  payroll: "vendor",
  payment_processor: "vendor",
  expense_management: "vendor",
  other: "vendor",
};

/**
 * Auto-create a party for a connection source if one doesn't already exist.
 * Links the party to the connection's category via partyable_links.
 */
async function autoCreatePartyForConnection(
  db: DbExecutor,
  orgId: string,
  sourceType: string,
  sourceName: string,
  sourceInstitution: string | null,
  categoryId: string,
): Promise<void> {
  const partyType = SOURCE_TYPE_TO_PARTY_TYPE[sourceType];
  if (!partyType) return; // Skip bank/credit_card

  const displayName = sourceInstitution ? `${sourceInstitution} - ${sourceName}` : sourceName;

  // Check if a party with this name already exists in the org
  const [existing] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(
      and(eq(parties.organizationId, orgId), ilike(parties.name, escapeLikePattern(displayName))),
    )
    .limit(1);

  const partyId = existing?.id;

  if (!partyId) {
    // Auto-create the party
    const [created] = await db
      .insert(parties)
      .values({
        organizationId: orgId,
        name: displayName,
        partyType,
        defaultAccountId: categoryId,
      })
      .returning({ id: parties.id });

    if (!created) return;

    // Link to the category via partyable_links
    await db
      .insert(partyableLinks)
      .values({
        organizationId: orgId,
        partyId: created.id,
        partyableType: "account",
        partyableId: categoryId,
        role: "primary",
      })
      .onConflictDoNothing();
  } else {
    // Party exists — just ensure the link exists
    await db
      .insert(partyableLinks)
      .values({
        organizationId: orgId,
        partyId,
        partyableType: "account",
        partyableId: categoryId,
        role: "primary",
      })
      .onConflictDoNothing();
  }
}

// ============================================================================
// List connections for an organization
// ============================================================================

const listSchema = z.object({
  categoryId: z.string().uuid().optional(),
  sourceType: z.enum(SOURCE_TYPES).optional(),
});

export const listConnections = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listSchema>) => listSchema.parse(data ?? {}))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { categoryId, sourceType } = listSchema.parse(rawData ?? {});

      const conditions = [eq(categoryConnections.organizationId, orgId)];

      if (categoryId) {
        conditions.push(eq(categoryConnections.categoryId, categoryId));
      }
      if (sourceType) {
        conditions.push(eq(categoryConnections.sourceType, sourceType));
      }

      return db
        .select({
          id: categoryConnections.id,
          categoryId: categoryConnections.categoryId,
          categoryName: accounts.name,
          sourceType: categoryConnections.sourceType,
          sourceName: categoryConnections.sourceName,
          sourceInstitution: categoryConnections.sourceInstitution,
          externalId: categoryConnections.externalId,
          externalSource: categoryConnections.externalSource,
          lastFourDigits: categoryConnections.lastFourDigits,
          createdAt: categoryConnections.createdAt,
          updatedAt: categoryConnections.updatedAt,
        })
        .from(categoryConnections)
        .leftJoin(accounts, eq(categoryConnections.categoryId, accounts.id))
        .where(and(...conditions))
        .orderBy(categoryConnections.sourceType, categoryConnections.sourceName);
    });
  });

// ============================================================================
// Get a single connection by ID
// ============================================================================

const getSchema = z.object({
  id: z.string().uuid(),
});

export const getConnection = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getSchema>) => getSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { id } = getSchema.parse(rawData);

      const [row] = await db
        .select({
          id: categoryConnections.id,
          categoryId: categoryConnections.categoryId,
          categoryName: accounts.name,
          sourceType: categoryConnections.sourceType,
          sourceName: categoryConnections.sourceName,
          sourceInstitution: categoryConnections.sourceInstitution,
          externalId: categoryConnections.externalId,
          externalSource: categoryConnections.externalSource,
          lastFourDigits: categoryConnections.lastFourDigits,
          createdAt: categoryConnections.createdAt,
          updatedAt: categoryConnections.updatedAt,
        })
        .from(categoryConnections)
        .leftJoin(accounts, eq(categoryConnections.categoryId, accounts.id))
        .where(and(eq(categoryConnections.id, id), eq(categoryConnections.organizationId, orgId)))
        .limit(1);

      if (!row) throw new Error("Connection not found");
      return row;
    });
  });

// ============================================================================
// Create a new connection
// ============================================================================

const createSchema = z.object({
  categoryId: z.string().uuid(),
  sourceType: z.enum(SOURCE_TYPES),
  sourceName: z.string().min(1).max(255),
  sourceInstitution: z.string().max(255).optional(),
  externalId: z.string().max(255).optional(),
  externalSource: z.string().max(100).optional(),
  lastFourDigits: z.string().max(4).optional(),
});

export const createConnection = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof createSchema>) => createSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "connection",
      "create",
      { routeKey: "connection:create", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createSchema.parse(rawData);

        const [category] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.id, parsed.categoryId), eq(accounts.organizationId, orgId)))
          .limit(1);

        if (!category) throw new Error("Category not found in this organization");

        const [row] = await db
          .insert(categoryConnections)
          .values({
            organizationId: orgId,
            categoryId: parsed.categoryId,
            sourceType: parsed.sourceType,
            sourceName: parsed.sourceName,
            sourceInstitution: parsed.sourceInstitution || null,
            externalId: parsed.externalId || null,
            externalSource: parsed.externalSource || null,
            lastFourDigits: parsed.lastFourDigits || null,
          })
          .returning();

        await autoCreatePartyForConnection(
          db,
          orgId,
          parsed.sourceType,
          parsed.sourceName,
          parsed.sourceInstitution || null,
          parsed.categoryId,
        );

        return row;
      },
    );
  });

// ============================================================================
// Update a connection
// ============================================================================

const updateSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid().optional(),
  sourceName: z.string().min(1).max(255).optional(),
  sourceInstitution: z.string().max(255).optional().nullable(),
  externalId: z.string().max(255).optional().nullable(),
  externalSource: z.string().max(100).optional().nullable(),
  lastFourDigits: z.string().max(4).optional().nullable(),
});

export const updateConnection = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof updateSchema>) => updateSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "connection",
      "update",
      { routeKey: "connection:update", limit: 45, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id, ...updates } = updateSchema.parse(rawData);

        if (updates.categoryId) {
          const [category] = await db
            .select({ id: accounts.id })
            .from(accounts)
            .where(and(eq(accounts.id, updates.categoryId), eq(accounts.organizationId, orgId)))
            .limit(1);

          if (!category) throw new Error("Category not found in this organization");
        }

        const setFields: Record<string, unknown> = { updatedAt: new Date() };
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            setFields[key] = value;
          }
        }

        const [row] = await db
          .update(categoryConnections)
          .set(setFields)
          .where(and(eq(categoryConnections.id, id), eq(categoryConnections.organizationId, orgId)))
          .returning();

        if (!row) throw new Error("Connection not found");
        return row;
      },
    );
  });

// ============================================================================
// Delete a connection
// ============================================================================

const deleteSchema = z.object({
  id: z.string().uuid(),
});

export const deleteConnection = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof deleteSchema>) => deleteSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "connection",
      "delete",
      { routeKey: "connection:delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id } = deleteSchema.parse(rawData);

        await db
          .delete(categoryConnections)
          .where(
            and(eq(categoryConnections.id, id), eq(categoryConnections.organizationId, orgId)),
          );

        return { success: true };
      },
    );
  });
