import { createServerFn } from "@tanstack/react-start";
import { parties } from "../../db/schema/parties";
import { accounts } from "../../db/schema/accounts";
import { bills } from "../../db/schema/bills";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../../db/schema/journals";
import { asc, eq, and, or, sql, gte, lte } from "drizzle-orm";

import { z } from "zod";
import { ilike } from "drizzle-orm";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";

// ============================================================================
// Types
// ============================================================================

export type PartyRecord = typeof parties.$inferSelect;

// Helper: resolve R2 key → presigned download URL for logoUrl
async function resolveLogoUrl(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  // Already a full URL (legacy or external) — return as-is
  if (logoUrl.startsWith("http")) return logoUrl;
  // Treat as R2 key
  const { getPresignedDownloadUrl } = await import("../../lib/storage");
  return getPresignedDownloadUrl(logoUrl, { expiresIn: 60 * 60 * 24 });
}

// ============================================================================
// Address Schema (reusable)
// ============================================================================

const addressSchema = z
  .object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  })
  .optional();

// ============================================================================
// List Parties
// ============================================================================

const PARTY_TYPES = [
  "vendor",
  "customer",
  "both",
  "employee",
  "shareholder",
  "lender",
  "bank",
  "government",
  "other",
] as const;

const partyTypeEnum = z.enum([...PARTY_TYPES, "all"]);

const listPartiesSchema = z.object({
  type: z.union([partyTypeEnum, z.array(z.enum(PARTY_TYPES))]).optional(),
  search: z.string().optional(),
  limit: z.number().optional().default(50),
  includeInactive: z.boolean().optional().default(false),
});

export const listParties = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof listPartiesSchema>) => listPartiesSchema.parse(data ?? {}))
  .handler(async ({ data }) => {
    // `data` is already validated by inputValidator above — do NOT re-parse it here
    // (the historical double-parse ran the schema twice per request).
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { type, search, limit, includeInactive } = data;

      const conditions = [eq(parties.organizationId, orgId)];

      // Only filter by isActive when not including inactive parties
      if (!includeInactive) {
        conditions.push(eq(parties.isActive, true));
      }

      if (type && type !== "all") {
        // Normalize to array
        const types = Array.isArray(type) ? type : [type];

        // Build OR conditions — vendor/customer also match "both"
        const typeConditions = types.map((t) => {
          if (t === "vendor")
            return or(eq(parties.partyType, "vendor"), eq(parties.partyType, "both"))!;
          if (t === "customer")
            return or(eq(parties.partyType, "customer"), eq(parties.partyType, "both"))!;
          return eq(parties.partyType, t);
        });

        if (typeConditions.length === 1) {
          conditions.push(typeConditions[0]);
        } else {
          conditions.push(or(...typeConditions)!);
        }
      }

      if (search) {
        conditions.push(ilike(parties.name, `%${search}%`));
      }

      let query = db
        .select()
        .from(parties)
        .where(and(...conditions))
        .orderBy(asc(parties.name))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      const results = await query;

      const resolved = await Promise.all(
        results.map(async (party) => ({
          ...party,
          logoUrl: await resolveLogoUrl(party.logoUrl),
        })),
      );

      return resolved;
    });
  });

// ============================================================================
// Get Single Party
// ============================================================================

const getPartySchema = z.object({
  id: z.string().uuid(),
});

export const getParty = createServerFn({ method: "GET" })
  .inputValidator((data) => getPartySchema.parse(data))
  .handler(async ({ data }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { id } = data;

      const [party] = await db
        .select({
          id: parties.id,
          name: parties.name,
          partyType: parties.partyType,
          email: parties.email,
          phone: parties.phone,
          website: parties.website,
          address: parties.address,
          logoUrl: parties.logoUrl,
          description: parties.description,
          notes: parties.notes,
          is1099Vendor: parties.is1099Vendor,
          taxId: parties.taxId,
          bankRoutingNumber: parties.bankRoutingNumber,
          bankAccountNumber: parties.bankAccountNumber,
          mailingAddress: parties.mailingAddress,
          paymentTerms: parties.paymentTerms,
          creditLimit: parties.creditLimit,
          defaultAccountId: parties.defaultAccountId,
          isActive: parties.isActive,
          createdAt: parties.createdAt,
          updatedAt: parties.updatedAt,
          defaultAccountName: accounts.name,
        })
        .from(parties)
        .leftJoin(accounts, eq(parties.defaultAccountId, accounts.id))
        .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
        .limit(1);

      if (!party) throw new Error("Party not found");

      return { ...party, logoUrl: await resolveLogoUrl(party.logoUrl) };
    });
  });

// ============================================================================
// Create Party
// ============================================================================

const createPartySchema = z.object({
  name: z.string().min(1),
  partyType: z.enum(PARTY_TYPES).default("vendor"),
  email: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  address: addressSchema,
  logoUrl: z.string().optional(),
  is1099Vendor: z.boolean().optional(),
  taxId: z.string().optional(),
  bankRoutingNumber: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  mailingAddress: addressSchema,
  paymentTerms: z.string().optional(),
  creditLimit: z.string().optional(),
  defaultAccountId: z.string().uuid().optional(),
});

export const createParty = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof createPartySchema>) => createPartySchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "party",
      "create",
      { routeKey: "party:create", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createPartySchema.parse(rawData);

        const [party] = await db
          .insert(parties)
          .values({
            organizationId: orgId,
            name: parsed.name,
            partyType: parsed.partyType,
            email: parsed.email,
            phone: parsed.phone,
            website: parsed.website,
            address: parsed.address,
            logoUrl: parsed.logoUrl,
            is1099Vendor: parsed.is1099Vendor,
            taxId: parsed.taxId,
            bankRoutingNumber: parsed.bankRoutingNumber,
            bankAccountNumber: parsed.bankAccountNumber,
            mailingAddress: parsed.mailingAddress,
            paymentTerms: parsed.paymentTerms,
            creditLimit: parsed.creditLimit,
            defaultAccountId: parsed.defaultAccountId,
          })
          .returning();

        return party;
      },
    );
  });

// ============================================================================
// Update Party
// ============================================================================

const updatePartySchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  partyType: z.enum(PARTY_TYPES).optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  address: addressSchema,
  logoUrl: z.string().optional().nullable(),
  is1099Vendor: z.boolean().optional(),
  taxId: z.string().optional(),
  bankRoutingNumber: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  mailingAddress: addressSchema,
  paymentTerms: z.string().optional(),
  creditLimit: z.string().optional(),
  defaultAccountId: z.string().uuid().optional().nullable(),
});

export const updateParty = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof updatePartySchema>) => updatePartySchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "party",
      "update",
      { routeKey: "party:update", limit: 120, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = updatePartySchema.parse(rawData);
        const { id, ...updates } = parsed;

        const updateFields: Record<string, unknown> = { updatedAt: new Date() };
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            updateFields[key] = value;
          }
        }

        const [updated] = await db
          .update(parties)
          .set(updateFields)
          .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  });
// Upload Party Avatar
// ============================================================================

const MAX_BASE64_SIZE = Math.ceil(5 * 1024 * 1024 * 1.4); // ~5 MB file → ~7 MB base64

const uploadAvatarSchema = z.object({
  partyId: z.string().uuid(),
  entityType: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileBase64: z.string().min(1).max(MAX_BASE64_SIZE, "File exceeds maximum allowed size"),
});

export const uploadPartyAvatar = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof uploadAvatarSchema>) => uploadAvatarSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "party",
      "update",
      { routeKey: "party:avatar-upload", limit: 20, windowMs: 300_000 },
      async ({ orgId, db }) => {
        const { partyId, entityType, filename, contentType, fileBase64 } =
          uploadAvatarSchema.parse(rawData);

        const { uploadToR2, getPresignedDownloadUrl } = await import("../../lib/storage");

        const ext = filename.split(".").pop() ?? "png";
        const key = `${orgId}/entities/${entityType}/${partyId}.${ext}`;

        const buffer = Buffer.from(fileBase64, "base64");
        await uploadToR2(key, buffer, contentType);

        await db
          .update(parties)
          .set({ logoUrl: key, updatedAt: new Date() })
          .where(and(eq(parties.id, partyId), eq(parties.organizationId, orgId)));

        const logoUrl = await getPresignedDownloadUrl(key, { expiresIn: 60 * 60 * 24 });

        return { logoUrl, r2Key: key };
      },
    );
  });

// ============================================================================
// Delete Party (soft delete)
// ============================================================================

const deletePartySchema = z.object({
  id: z.string().uuid(),
});

export const deleteParty = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof deletePartySchema>) => deletePartySchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "party",
      "delete",
      { routeKey: "party:delete", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id } = deletePartySchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(parties)
          .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
          .limit(1);

        if (!existing) throw new Error("Party not found");

        const [updated] = await db
          .update(parties)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  });

// ============================================================================
// Hard Delete Party (permanent removal for already-deactivated parties)
// ============================================================================

const hardDeletePartySchema = z.object({
  id: z.string().uuid(),
});

export const hardDeleteParty = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof hardDeletePartySchema>) =>
    hardDeletePartySchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "party",
      "delete",
      { routeKey: "party:hard-delete", limit: 15, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id } = hardDeletePartySchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(parties)
          .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
          .limit(1);

        if (!existing) throw new Error("Party not found");
        if (existing.isActive)
          throw new Error("Cannot permanently delete an active party. Deactivate it first.");

        const [billRef] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(bills)
          .where(eq(bills.vendorId, id));

        if (billRef && billRef.count > 0) {
          throw new Error(
            `Cannot delete: ${billRef.count} bill(s) reference this vendor. Remove those references first.`,
          );
        }

        await db.delete(parties).where(and(eq(parties.id, id), eq(parties.organizationId, orgId)));

        return { deleted: true, id };
      },
    );
  });

// ============================================================================
// Restore Party (reactivate a soft-deleted party)
// ============================================================================

const restorePartySchema = z.object({
  id: z.string().uuid(),
});

export const restoreParty = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof restorePartySchema>) => restorePartySchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "party",
      "update",
      { routeKey: "party:restore", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id } = restorePartySchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(parties)
          .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
          .limit(1);

        if (!existing) throw new Error("Party not found");
        if (existing.isActive) throw new Error("Party is already active.");

        const [updated] = await db
          .update(parties)
          .set({ isActive: true, updatedAt: new Date() })
          .where(and(eq(parties.id, id), eq(parties.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  });

// ============================================================================
// Party Transaction Summary (for Insights bar chart)
// ============================================================================

const partyTransactionSummarySchema = z.object({
  partyId: z.string().uuid(),
  year: z.number().int().optional(),
});

export const getPartyTransactionSummary = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof partyTransactionSummarySchema>) =>
    partyTransactionSummarySchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { partyId, year } = partyTransactionSummarySchema.parse(rawData);

      const [party] = await db
        .select({
          id: parties.id,
          name: parties.name,
          partyType: parties.partyType,
          email: parties.email,
          phone: parties.phone,
          website: parties.website,
        })
        .from(parties)
        .where(and(eq(parties.id, partyId), eq(parties.organizationId, orgId)))
        .limit(1);

      if (!party) throw new Error("Party not found");

      const targetYear = year || new Date().getFullYear();
      const dateFrom = `${targetYear}-01-01`;
      const dateTo = `${targetYear}-12-31`;

      const monthlyTotals = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})::int`,
          totalAmount: sql<string>`COALESCE(SUM(ABS(${journalHeaders.totalAmount}::numeric)), 0)::text`,
          transactionCount: sql<number>`COUNT(*)::int`,
        })
        .from(journalHeaders)
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            eq(journalHeaders.status, "posted"),
            effectiveJournalPredicate(),
            eq(journalHeaders.partyId, partyId),
            gte(journalHeaders.transactionDate, dateFrom),
            lte(journalHeaders.transactionDate, dateTo),
          ),
        )
        .groupBy(sql`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})`)
        .orderBy(sql`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})`);

      const months = Array.from({ length: 12 }, (_, i) => {
        const found = monthlyTotals.find((month) => month.month === i + 1);
        return {
          month: i + 1,
          totalAmount: found?.totalAmount || "0",
          transactionCount: found?.transactionCount || 0,
        };
      });

      const totalAmount = months.reduce(
        (sum, month) => sum + Number.parseFloat(month.totalAmount),
        0,
      );
      const totalTransactions = months.reduce((sum, month) => sum + month.transactionCount, 0);

      return {
        party,
        year: targetYear,
        months,
        totalAmount: totalAmount.toFixed(2),
        totalTransactions,
      };
    });
  });

// ============================================================================
// Party Categories (hierarchical category breakdown)
// ============================================================================

const partyCategoriesSchema = z.object({
  partyId: z.string().uuid(),
  year: z.number().int().optional(),
});

export const getPartyCategories = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof partyCategoriesSchema>) =>
    partyCategoriesSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { partyId, year } = partyCategoriesSchema.parse(rawData);

      const targetYear = year || new Date().getFullYear();
      const dateFrom = `${targetYear}-01-01`;
      const dateTo = `${targetYear}-12-31`;

      const lineData = await db
        .select({
          accountId: journalLines.accountId,
          totalAmount: sql<string>`COALESCE(SUM(GREATEST(ABS(${journalLines.debit}::numeric), ABS(${journalLines.credit}::numeric))), 0)::text`,
          transactionCount: sql<number>`COUNT(DISTINCT ${journalLines.journalHeaderId})::int`,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            eq(journalHeaders.status, "posted"),
            effectiveJournalPredicate(),
            eq(journalHeaders.partyId, partyId),
            gte(journalHeaders.transactionDate, dateFrom),
            lte(journalHeaders.transactionDate, dateTo),
          ),
        )
        .groupBy(journalLines.accountId);

      if (lineData.length === 0) return [];

      const allAccounts = await db
        .select({
          id: accounts.id,
          name: accounts.name,
          accountNumber: accounts.accountNumber,
          accountType: accounts.accountType,
          subtype: accounts.subtype,
          parentId: accounts.parentId,
          icon: accounts.icon,
        })
        .from(accounts)
        .where(eq(accounts.organizationId, orgId));

      const accountMap = new Map(allAccounts.map((account) => [account.id, account]));

      const usedAccountIds = new Set(lineData.map((line) => line.accountId));
      const ancestorIds = new Set<string>();

      for (const accountId of usedAccountIds) {
        let current = accountMap.get(accountId);
        while (current?.parentId) {
          ancestorIds.add(current.parentId);
          current = accountMap.get(current.parentId);
        }
      }

      type CategoryNode = {
        id: string;
        name: string;
        accountNumber: string | null;
        accountType: string;
        icon: string | null;
        totalAmount: string;
        transactionCount: number;
        children: CategoryNode[];
      };

      const lineDataMap = new Map(lineData.map((line) => [line.accountId, line]));

      const buildTree = (parentId: string | null): CategoryNode[] => {
        const relevantIds = new Set([...usedAccountIds, ...ancestorIds]);
        const children = allAccounts
          .filter((account) => account.parentId === parentId && relevantIds.has(account.id))
          .sort((left, right) =>
            (left.accountNumber || "").localeCompare(right.accountNumber || ""),
          );

        return children.map((account) => {
          const childNodes = buildTree(account.id);
          const directData = lineDataMap.get(account.id);
          const directAmount = Number.parseFloat(directData?.totalAmount || "0");
          const childAmount = childNodes.reduce(
            (sum, childNode) => sum + Number.parseFloat(childNode.totalAmount),
            0,
          );
          const directCount = directData?.transactionCount || 0;
          const childCount = childNodes.reduce(
            (sum, childNode) => sum + childNode.transactionCount,
            0,
          );

          return {
            id: account.id,
            name: account.name,
            accountNumber: account.accountNumber,
            accountType: account.accountType,
            icon: account.icon,
            totalAmount: (directAmount + childAmount).toFixed(2),
            transactionCount: directCount + childCount,
            children: childNodes,
          };
        });
      };

      return buildTree(null);
    });
  });
