import { createServerFn } from "@tanstack/react-start";
import { and, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../../db/schema/accounts";
import { dimensions } from "../../db/schema/dimensions";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../../db/schema/journals";
import {
  withMutationPermissionOrgContext,
  withSessionOrgContext,
  type OrgServerContext,
} from "../../lib/server-context";

type DimensionType = "department" | "location";
type DbDimensionRecord = typeof dimensions.$inferSelect;
type SerializableDimensionRecord = Omit<DbDimensionRecord, "metadata"> & {
  metadata: Record<string, {}> | null;
};

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

const listDimensionsSchema = z.object({
  search: z.string().optional(),
  includeInactive: z.boolean().optional().default(false),
});

const getDimensionSchema = z.object({ id: z.string().uuid() });

const createDimensionSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  parentId: z.string().uuid().optional(),
  isActive: z.boolean().optional().default(true),
});

const updateDimensionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  code: z.string().optional(),
  description: z.string().optional(),
  parentId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
});

const deleteDimensionSchema = z.object({ id: z.string().uuid() });

const dimensionSummarySchema = z.object({
  id: z.string().uuid(),
  year: z.number().int().optional(),
});

function getDimensionLineColumn(dimensionType: DimensionType) {
  return dimensionType === "department" ? journalLines.departmentId : journalLines.locationId;
}

function normalizeDimensionRecord(
  record: DbDimensionRecord | null,
): SerializableDimensionRecord | null {
  if (!record) {
    return null;
  }

  return {
    ...record,
    metadata: (record.metadata ?? null) as Record<string, {}> | null,
  };
}

async function getDimensionRecord(
  ctx: Pick<OrgServerContext, "db" | "orgId">,
  id: string,
  dimensionType: DimensionType,
) {
  const [record] = await ctx.db
    .select()
    .from(dimensions)
    .where(
      and(
        eq(dimensions.id, id),
        eq(dimensions.dimensionType, dimensionType),
        eq(dimensions.organizationId, ctx.orgId),
      ),
    )
    .limit(1);

  return record ?? null;
}

async function listDimensionsImpl(rawData: unknown, dimensionType: DimensionType) {
  return withSessionOrgContext(async (ctx) => {
    const { search, includeInactive } = listDimensionsSchema.parse(rawData ?? {});
    const conditions = [
      eq(dimensions.organizationId, ctx.orgId),
      eq(dimensions.dimensionType, dimensionType),
    ];

    if (!includeInactive) {
      conditions.push(eq(dimensions.isActive, true));
    }

    if (search?.trim()) {
      const query = `%${search.trim()}%`;
      conditions.push(or(ilike(dimensions.name, query), ilike(dimensions.code, query))!);
    }

    const records = await ctx.db
      .select()
      .from(dimensions)
      .where(and(...conditions))
      .orderBy(dimensions.name);

    return records.map((record) => normalizeDimensionRecord(record)!);
  });
}

async function getDimensionImpl(rawData: unknown, dimensionType: DimensionType) {
  return withSessionOrgContext(async (ctx) => {
    const { id } = getDimensionSchema.parse(rawData);
    return normalizeDimensionRecord(await getDimensionRecord(ctx, id, dimensionType));
  });
}

async function createDimensionImpl(rawData: unknown, dimensionType: DimensionType) {
  return withMutationPermissionOrgContext(
    "dimension",
    "create",
    {
      routeKey: `dimension:create-${dimensionType}`,
      limit: 30,
      windowMs: 60_000,
    },
    async (ctx) => {
      const parsed = createDimensionSchema.parse(rawData);
      const [created] = await ctx.db
        .insert(dimensions)
        .values({
          organizationId: ctx.orgId,
          dimensionType,
          ...parsed,
        })
        .returning();

      return normalizeDimensionRecord(created);
    },
  );
}

async function updateDimensionImpl(rawData: unknown, dimensionType: DimensionType) {
  return withMutationPermissionOrgContext(
    "dimension",
    "update",
    {
      routeKey: `dimension:update-${dimensionType}`,
      limit: 45,
      windowMs: 60_000,
    },
    async (ctx) => {
      const parsed = updateDimensionSchema.parse(rawData);
      const { id, ...updates } = parsed;

      const [updated] = await ctx.db
        .update(dimensions)
        .set({ ...updates, updatedAt: new Date() })
        .where(
          and(
            eq(dimensions.id, id),
            eq(dimensions.dimensionType, dimensionType),
            eq(dimensions.organizationId, ctx.orgId),
          ),
        )
        .returning();

      return normalizeDimensionRecord(updated);
    },
  );
}

async function softDeleteDimensionImpl(rawData: unknown, dimensionType: DimensionType) {
  return withMutationPermissionOrgContext(
    "dimension",
    "delete",
    {
      routeKey: `dimension:delete-${dimensionType}`,
      limit: 20,
      windowMs: 60_000,
    },
    async (ctx) => {
      const { id } = deleteDimensionSchema.parse(rawData);
      const [deactivated] = await ctx.db
        .update(dimensions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(dimensions.id, id),
            eq(dimensions.dimensionType, dimensionType),
            eq(dimensions.organizationId, ctx.orgId),
          ),
        )
        .returning();

      return normalizeDimensionRecord(deactivated);
    },
  );
}

async function permanentlyDeleteDimensionImpl(rawData: unknown, dimensionType: DimensionType) {
  return withMutationPermissionOrgContext(
    "dimension",
    "delete",
    {
      routeKey: `dimension:hard-delete-${dimensionType}`,
      limit: 10,
      windowMs: 60_000,
    },
    async (ctx) => {
      const { id } = deleteDimensionSchema.parse(rawData);
      await ctx.db
        .delete(dimensions)
        .where(
          and(
            eq(dimensions.id, id),
            eq(dimensions.dimensionType, dimensionType),
            eq(dimensions.organizationId, ctx.orgId),
          ),
        );

      return { success: true };
    },
  );
}

async function getDimensionTransactionSummaryImpl(rawData: unknown, dimensionType: DimensionType) {
  return withSessionOrgContext(async (ctx) => {
    const { id, year } = dimensionSummarySchema.parse(rawData);
    const dimension = await getDimensionRecord(ctx, id, dimensionType);

    if (!dimension) {
      throw new Error(
        `${dimensionType.charAt(0).toUpperCase() + dimensionType.slice(1)} not found`,
      );
    }

    const targetYear = year || new Date().getFullYear();
    const dateFrom = `${targetYear}-01-01`;
    const dateTo = `${targetYear}-12-31`;
    const dimensionColumn = getDimensionLineColumn(dimensionType);

    const monthlyTotals = await ctx.db
      .select({
        month: sql<number>`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})::int`,
        totalAmount: sql<string>`COALESCE(SUM(ABS(COALESCE(${journalLines.debit}::numeric, 0)) + ABS(COALESCE(${journalLines.credit}::numeric, 0))), 0)::text`,
        transactionCount: sql<number>`COUNT(DISTINCT ${journalHeaders.id})::int`,
      })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(
        and(
          eq(journalHeaders.organizationId, ctx.orgId),
          eq(journalHeaders.status, "posted"),
          effectiveJournalPredicate(),
          eq(dimensionColumn, id),
          gte(journalHeaders.transactionDate, dateFrom),
          lte(journalHeaders.transactionDate, dateTo),
          inArray(accounts.accountType, [
            "expense",
            "revenue",
            "cost_of_goods_sold",
            "other_expense",
            "other_income",
          ]),
        ),
      )
      .groupBy(sql`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})`)
      .orderBy(sql`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})`);

    const months = Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      const found = monthlyTotals.find((entry) => entry.month === month);
      return {
        month,
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
      entity: normalizeDimensionRecord(dimension)!,
      year: targetYear,
      months,
      totalAmount: totalAmount.toFixed(2),
      totalTransactions,
    };
  });
}

async function getDimensionCategoriesImpl(rawData: unknown, dimensionType: DimensionType) {
  return withSessionOrgContext(async (ctx) => {
    const { id, year } = dimensionSummarySchema.parse(rawData);
    const targetYear = year || new Date().getFullYear();
    const dateFrom = `${targetYear}-01-01`;
    const dateTo = `${targetYear}-12-31`;
    const dimensionColumn = getDimensionLineColumn(dimensionType);

    const lineData = await ctx.db
      .select({
        accountId: journalLines.accountId,
        totalAmount: sql<string>`COALESCE(SUM(GREATEST(ABS(${journalLines.debit}::numeric), ABS(${journalLines.credit}::numeric))), 0)::text`,
        transactionCount: sql<number>`COUNT(DISTINCT ${journalLines.journalHeaderId})::int`,
      })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .where(
        and(
          eq(journalHeaders.organizationId, ctx.orgId),
          eq(journalHeaders.status, "posted"),
          effectiveJournalPredicate(),
          eq(dimensionColumn, id),
          gte(journalHeaders.transactionDate, dateFrom),
          lte(journalHeaders.transactionDate, dateTo),
        ),
      )
      .groupBy(journalLines.accountId);

    if (lineData.length === 0) {
      return [] as CategoryNode[];
    }

    const allAccounts = await ctx.db
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
      .where(eq(accounts.organizationId, ctx.orgId));

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

    const lineDataMap = new Map(lineData.map((line) => [line.accountId, line]));

    const buildTree = (parentId: string | null): CategoryNode[] => {
      const relevantIds = new Set([...usedAccountIds, ...ancestorIds]);
      const children = allAccounts
        .filter((account) => account.parentId === parentId && relevantIds.has(account.id))
        .sort((left, right) => (left.accountNumber || "").localeCompare(right.accountNumber || ""));

      return children.map((account) => {
        const childNodes = buildTree(account.id);
        const directData = lineDataMap.get(account.id);
        const directAmount = Number.parseFloat(directData?.totalAmount || "0");
        const childAmount = childNodes.reduce(
          (sum, child) => sum + Number.parseFloat(child.totalAmount),
          0,
        );
        const directCount = directData?.transactionCount || 0;
        const childCount = childNodes.reduce((sum, child) => sum + child.transactionCount, 0);

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
}

export const listDepartments = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof listDimensionsSchema>) =>
    listDimensionsSchema.parse(data ?? {}),
  )
  .handler(async ({ data }) => listDimensionsImpl(data, "department"));

export const listLocations = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof listDimensionsSchema>) =>
    listDimensionsSchema.parse(data ?? {}),
  )
  .handler(async ({ data }) => listDimensionsImpl(data, "location"));

export const getDepartment = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getDimensionSchema>) => getDimensionSchema.parse(data))
  .handler(async ({ data }) => getDimensionImpl(data, "department"));

export const getLocation = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getDimensionSchema>) => getDimensionSchema.parse(data))
  .handler(async ({ data }) => getDimensionImpl(data, "location"));

export const createDepartment = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  createDimensionImpl(data, "department"),
);

export const createLocation = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  createDimensionImpl(data, "location"),
);

export const updateDepartment = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  updateDimensionImpl(data, "department"),
);

export const updateLocation = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  updateDimensionImpl(data, "location"),
);

export const deleteDepartment = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  softDeleteDimensionImpl(data, "department"),
);

export const deleteLocation = createServerFn({ method: "POST" }).handler(async ({ data }) =>
  softDeleteDimensionImpl(data, "location"),
);

export const permanentlyDeleteDepartment = createServerFn({ method: "POST" }).handler(
  async ({ data }) => permanentlyDeleteDimensionImpl(data, "department"),
);

export const permanentlyDeleteLocation = createServerFn({ method: "POST" }).handler(
  async ({ data }) => permanentlyDeleteDimensionImpl(data, "location"),
);

export const getDepartmentTransactionSummary = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof dimensionSummarySchema>) =>
    dimensionSummarySchema.parse(data),
  )
  .handler(async ({ data }) => getDimensionTransactionSummaryImpl(data, "department"));

export const getLocationTransactionSummary = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof dimensionSummarySchema>) =>
    dimensionSummarySchema.parse(data),
  )
  .handler(async ({ data }) => getDimensionTransactionSummaryImpl(data, "location"));

export const getDepartmentCategories = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof dimensionSummarySchema>) =>
    dimensionSummarySchema.parse(data),
  )
  .handler(async ({ data }) => getDimensionCategoriesImpl(data, "department"));

export const getLocationCategories = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof dimensionSummarySchema>) =>
    dimensionSummarySchema.parse(data),
  )
  .handler(async ({ data }) => getDimensionCategoriesImpl(data, "location"));
