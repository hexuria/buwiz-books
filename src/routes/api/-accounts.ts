/**
 * Accounts API Server Functions
 * CRUD operations for Chart of Accounts
 */
import { createServerFn } from "@tanstack/react-start";
import type { DbExecutor } from "../../db";
import { accounts } from "../../db/schema/accounts";
import { financialAccounts } from "../../db/schema/financial-accounts";
import { effectiveJournalPredicate, journalLines, journalHeaders } from "../../db/schema/journals";
import { parties } from "../../db/schema/parties";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RANGES,
  isAccountType,
  isSubtypeLegalForType,
} from "../../db/schema/account-constants";
import { eq, isNull, isNotNull, asc, and, inArray, lte, gte, sql, desc } from "drizzle-orm";
import { z } from "zod";
import { getAllDescendantIds } from "../../lib/account-helpers";
import { createLogger } from "../../lib/logger";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { resolveGranularity, generateTimeBuckets } from "../../lib/time-series";

// ============================================================================
// Types
// ============================================================================

export type AccountWithChildren = typeof accounts.$inferSelect & {
  children?: AccountWithChildren[];
};

// ============================================================================
// Schemas
// ============================================================================

const listAccountsSchema = z.object({
  includeChildren: z.boolean().optional().default(false),
  status: z.array(z.string()).optional().default(["active"]),
  types: z.array(z.string()).optional().default([]),
  subtypes: z.array(z.string()).optional().default([]),
});

const getAccountSchema = z.object({
  id: z.string().uuid(),
});

const createAccountSchema = z
  .object({
    name: z.string().min(1).max(255),
    accountNumber: z.string().max(10).optional(),
    description: z.string().optional(),
    accountType: z.enum(ACCOUNT_TYPES),
    subtype: z.string().optional(),
    parentId: z.string().uuid().optional(),
    icon: z.string().max(50).optional(),
  })
  // The `subtype` column is a plain varchar, so an illegal value would otherwise
  // be written silently and then be unfixable — `updateAccountSchema` has no
  // subtype field, and nothing else can change one after creation.
  .superRefine((value, ctx) => {
    if (value.subtype && !isSubtypeLegalForType(value.accountType, value.subtype)) {
      ctx.addIssue({
        code: "custom",
        path: ["subtype"],
        message: `Subtype "${value.subtype}" is not valid for account type "${value.accountType}"`,
      });
    }
  });

const updateAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  accountNumber: z.string().max(10).optional(),
  description: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  icon: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
  readPartyTypes: z.array(z.string()).nullable().optional(),
  mutatePartyTypes: z.array(z.string()).nullable().optional(),
});

const deleteAccountSchema = z.object({
  id: z.string().uuid(),
});

const getAccountsByTypeSchema = z.object({
  accountType: z.enum(ACCOUNT_TYPES),
});

// ============================================================================
// Server Functions
// ============================================================================

const logger = createLogger("api.accounts");

/**
 * List all accounts with optional hierarchy
 */
export const listAccounts = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listAccountsSchema>) =>
    listAccountsSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = listAccountsSchema.parse(rawData ?? {});
      const { includeChildren, status, types, subtypes } = parsed;

      // Build where conditions — always scope to org
      const conditions = [eq(accounts.organizationId, orgId)];

      // Status filter: if both or none selected, no status filter
      if (status.length > 0 && status.length < 2) {
        if (status.includes("active")) {
          conditions.push(eq(accounts.isActive, true));
        } else if (status.includes("deactivated")) {
          conditions.push(eq(accounts.isActive, false));
        }
      }

      // Type filter
      if (types.length > 0) {
        conditions.push(inArray(accounts.accountType, types as (typeof ACCOUNT_TYPES)[number][]));
      }

      // Subtype filter
      if (subtypes.length > 0) {
        conditions.push(inArray(accounts.subtype, subtypes as string[]));
      }

      // Fetch accounts with combined conditions
      const allAccounts = await db
        .select()
        .from(accounts)
        .where(and(...conditions))
        .orderBy(asc(accounts.accountNumber), asc(accounts.name));

      if (!includeChildren) {
        return allAccounts;
      }

      // Build tree structure
      const accountMap = new Map<string, AccountWithChildren>();
      const rootAccounts: AccountWithChildren[] = [];

      // First pass: create map
      for (const account of allAccounts) {
        accountMap.set(account.id, { ...account, children: [] });
      }

      // Second pass: build hierarchy
      for (const account of allAccounts) {
        const node = accountMap.get(account.id)!;
        if (account.parentId) {
          const parent = accountMap.get(account.parentId);
          if (parent) {
            parent.children = parent.children || [];
            parent.children.push(node);
          } else {
            // Parent not found (maybe inactive), add to root
            rootAccounts.push(node);
          }
        } else {
          rootAccounts.push(node);
        }
      }

      return rootAccounts;
    });
  });

/**
 * Get account by ID with full details
 */
export const getAccount = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getAccountSchema>) => getAccountSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getAccountSchema.parse(rawData);

      const [account] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, parsed.id), eq(accounts.organizationId, orgId)))
        .limit(1);

      if (!account) {
        throw new Error("Account not found");
      }

      // Fetch all org accounts in one query and build tree in-memory
      const allAccounts = await db
        .select()
        .from(accounts)
        .where(eq(accounts.organizationId, orgId))
        .orderBy(asc(accounts.accountNumber), asc(accounts.name));

      // Resolve parent
      const parent = account.parentId
        ? (allAccounts.find((a) => a.id === account.parentId) ?? null)
        : null;

      // Build children tree from flat list
      const buildChildren = (parentId: string): AccountWithChildren[] => {
        return allAccounts
          .filter((a) => a.parentId === parentId)
          .map((child) => ({
            ...child,
            children: buildChildren(child.id),
          }));
      };

      const children = buildChildren(account.id);

      return { ...account, parent, children };
    });
  });

// ============================================================================
// Account Number Auto-Generation
// ============================================================================

/**
 * Generate the next available account number for a new category.
 *
 * Strategy:
 *  1. If parentId is set and parent has a number → derive from parent with +100 increments
 *  2. If root-level → derive from existing roots of the same accountType with +1000 increments
 *  3. Fallback → use the type range base (e.g. 10000 for asset)
 *
 * Always checks for collisions within the org and increments until a free slot is found.
 */
async function generateAccountNumber(
  db: DbExecutor,
  orgId: string,
  parentId?: string,
  accountType?: string,
): Promise<string> {
  // Helper: find existing account numbers for this org
  const existingNumbers = async (): Promise<Set<string>> => {
    const rows = await db
      .select({ accountNumber: accounts.accountNumber })
      .from(accounts)
      .where(and(eq(accounts.organizationId, orgId), isNotNull(accounts.accountNumber)));
    return new Set(rows.map((r) => r.accountNumber!));
  };

  // Strategy 1: Derive from parent
  if (parentId) {
    const [parent] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, parentId), eq(accounts.organizationId, orgId)))
      .limit(1);

    if (parent?.accountNumber) {
      const parentNum = Number.parseInt(parent.accountNumber, 10);
      if (!Number.isNaN(parentNum)) {
        // Find all sibling numbers under this parent
        const siblings = await db
          .select({ accountNumber: accounts.accountNumber })
          .from(accounts)
          .where(
            and(
              eq(accounts.organizationId, orgId),
              eq(accounts.parentId, parentId),
              isNotNull(accounts.accountNumber),
            ),
          );

        const siblingNums = siblings
          .map((s) => Number.parseInt(s.accountNumber!, 10))
          .filter((n) => !Number.isNaN(n));

        // Start at parent + 100, increment by 100 until free
        let candidate = parentNum + 100;
        const used = new Set(siblingNums);
        while (used.has(candidate)) {
          candidate += 100;
        }

        // Verify no collision with any org account number
        const allNums = await existingNumbers();
        let candidateStr = String(candidate);
        while (allNums.has(candidateStr)) {
          candidate += 1;
          candidateStr = String(candidate);
        }

        return candidateStr;
      }
    }
  }

  // Strategy 2: Root-level — find highest root number in same type and add 1000
  if (accountType) {
    const base = isAccountType(accountType) ? ACCOUNT_TYPE_RANGES[accountType] : 10000;
    const roots = await db
      .select({ accountNumber: accounts.accountNumber })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, orgId),
          eq(accounts.accountType, accountType),
          isNull(accounts.parentId),
          isNotNull(accounts.accountNumber),
        ),
      );

    const rootNums = roots
      .map((r) => Number.parseInt(r.accountNumber!, 10))
      .filter((n) => !Number.isNaN(n));

    let candidate: number;
    if (rootNums.length > 0) {
      candidate = Math.max(...rootNums) + 1000;
    } else {
      candidate = base;
    }

    const allNums = await existingNumbers();
    let candidateStr = String(candidate);
    while (allNums.has(candidateStr)) {
      candidate += 1;
      candidateStr = String(candidate);
    }

    return candidateStr;
  }

  // Fallback: just find the global max and add 100
  const allNums = await existingNumbers();
  const allNumeric = [...allNums]
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => !Number.isNaN(n));
  const maxNum = allNumeric.length > 0 ? Math.max(...allNumeric) : 10000;
  let candidate = maxNum + 100;
  let candidateStr = String(candidate);
  while (allNums.has(candidateStr)) {
    candidate += 1;
    candidateStr = String(candidate);
  }

  return candidateStr;
}

/**
 * Create a new account
 */
export const createAccount = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof createAccountSchema>) => createAccountSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "account",
      "create",
      { routeKey: "account:create", limit: 60, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createAccountSchema.parse(rawData);

        // Auto-generate account number if not provided
        const finalAccountNumber =
          parsed.accountNumber ||
          (await generateAccountNumber(db, orgId, parsed.parentId, parsed.accountType));

        const [created] = await db
          .insert(accounts)
          .values({
            organizationId: orgId,
            name: parsed.name,
            accountNumber: finalAccountNumber,
            description: parsed.description,
            accountType: parsed.accountType,
            subtype: parsed.subtype ?? null,
            parentId: parsed.parentId,
            icon: parsed.icon,
          })
          .returning();

        return created;
      },
    );
  });

/**
 * Update an existing account
 */
export const updateAccount = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof updateAccountSchema>) => updateAccountSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "account",
      "update",
      { routeKey: "account:update", limit: 120, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = updateAccountSchema.parse(rawData);
        const { id, ...updates } = parsed;

        // Check if account exists in this org
        const [existing] = await db
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, id), eq(accounts.organizationId, orgId)))
          .limit(1);

        if (!existing) {
          throw new Error("Account not found");
        }

        if (existing.isSystem && updates.isActive === false) {
          throw new Error("Cannot deactivate system account");
        }

        // Cycle detection: prevent setting parent to self or any descendant
        if (updates.parentId !== undefined && updates.parentId !== null) {
          if (updates.parentId === id) {
            throw new Error("Account cannot be its own parent");
          }
          let currentParentId: string | null = updates.parentId;
          while (currentParentId) {
            const [parent] = await db
              .select({ parentId: accounts.parentId })
              .from(accounts)
              .where(and(eq(accounts.id, currentParentId), eq(accounts.organizationId, orgId)))
              .limit(1);

            if (!parent) break;
            if (parent.parentId === id) {
              throw new Error(
                "Cannot move account under its own descendant (would create a cycle)",
              );
            }
            currentParentId = parent.parentId;
          }
        }

        // If accountNumber is being explicitly cleared, auto-generate one
        const finalUpdates = { ...updates };
        if (
          "accountNumber" in finalUpdates &&
          !finalUpdates.accountNumber &&
          !existing.accountNumber
        ) {
          finalUpdates.accountNumber = await generateAccountNumber(
            db,
            orgId,
            existing.parentId ?? undefined,
            existing.accountType,
          );
        }

        const [updated] = await db
          .update(accounts)
          .set({
            ...finalUpdates,
            updatedAt: new Date(),
          })
          .where(and(eq(accounts.id, id), eq(accounts.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  });

/**
 * Soft delete an account (set isActive = false)
 */
// The `inputValidator` is what types the caller's `data` — without it the fetcher signature
// says `data: undefined`, which is why every call site had to cast the fn to
// `(opts: { data: unknown }) => …` and thereby threw the real return type away too. The
// handler already re-parses `rawData`, so this only closes the type hole.
export const deleteAccount = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof deleteAccountSchema>) => deleteAccountSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "account",
      "delete",
      { routeKey: "account:delete", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = deleteAccountSchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, parsed.id), eq(accounts.organizationId, orgId)))
          .limit(1);

        if (!existing) {
          throw new Error("Account not found");
        }

        if (existing.isSystem) {
          throw new Error("Cannot delete system account");
        }

        if (!existing.parentId) {
          throw new Error("Cannot delete root category");
        }

        // Check for children
        const children = await db
          .select()
          .from(accounts)
          .where(
            and(
              eq(accounts.parentId, parsed.id),
              eq(accounts.isActive, true),
              eq(accounts.organizationId, orgId),
            ),
          );

        if (children.length > 0) {
          throw new Error(
            "Cannot delete account with active children. Delete or deactivate children first.",
          );
        }

        const [deleted] = await db
          .update(accounts)
          .set({
            isActive: false,
            updatedAt: new Date(),
          })
          .where(and(eq(accounts.id, parsed.id), eq(accounts.organizationId, orgId)))
          .returning();

        return deleted;
      },
    );
  });

/**
 * Get accounts by type (for filtering)
 */
export const getAccountsByType = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getAccountsByTypeSchema.parse(rawData);

      return db
        .select()
        .from(accounts)
        .where(
          and(eq(accounts.accountType, parsed.accountType), eq(accounts.organizationId, orgId)),
        )
        .orderBy(asc(accounts.accountNumber), asc(accounts.name));
    });
  },
);

/**
 * Get root accounts (no parent)
 */
export const getRootAccounts = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    return db
      .select()
      .from(accounts)
      .where(and(isNull(accounts.parentId), eq(accounts.organizationId, orgId)))
      .orderBy(asc(accounts.accountNumber), asc(accounts.name));
  });
});

/**
 * List financial account connections (for category connection badges)
 */
export const listFinancialConnections = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const rows = await db
      .select({
        id: financialAccounts.id,
        accountName: financialAccounts.accountName,
        institutionName: financialAccounts.institutionName,
        institutionLogoUrl: financialAccounts.institutionLogoUrl,
        ledgerAccountId: financialAccounts.ledgerAccountId,
      })
      .from(financialAccounts)
      .where(
        and(eq(financialAccounts.isActive, true), eq(financialAccounts.organizationId, orgId)),
      );
    return rows;
  });
});

// ============================================================================
// Account Transaction Summaries (Charts)
// ============================================================================

const accountSummarySchema = z.object({
  id: z.string().uuid(),
  dateFrom: z.string(),
  dateTo: z.string(),
  includeChildren: z.boolean().optional().default(false),
});

export const getAccountTransactionSummary = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof accountSummarySchema>) => accountSummarySchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = accountSummarySchema.parse(rawData);
      const { id, dateFrom, dateTo, includeChildren } = parsed;

      // Verify account exists
      const [account] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, id), eq(accounts.organizationId, orgId)))
        .limit(1);

      if (!account) {
        throw new Error("Account not found");
      }

      const fromDate = new Date(dateFrom);
      const toDate = new Date(dateTo);

      // Resolve smart scaling based on time duration
      const granularity = resolveGranularity(fromDate, toDate);
      // Generate empty array containing matching scaled periods (e.g. 7 days, 4 weeks, etc)
      const buckets = generateTimeBuckets(fromDate, toDate, granularity);

      let accountIds = [id];

      if (includeChildren) {
        const childIds = await getAllDescendantIds(db, id, orgId);
        accountIds = [id, ...childIds];
      }

      // 1. Group DB calls by exact Day strictly using post-gres date_trunc
      const groupedTotals = await db
        .select({
          bucketDate: sql<string>`DATE_TRUNC('day', ${journalHeaders.transactionDate})::text`,
          accountType: accounts.accountType,
          totalDebit: sql<string>`COALESCE(SUM(COALESCE(${journalLines.debit}::numeric, 0)), 0)::text`,
          totalCredit: sql<string>`COALESCE(SUM(COALESCE(${journalLines.credit}::numeric, 0)), 0)::text`,
          transactionCount: sql<number>`COUNT(DISTINCT ${journalHeaders.id})::int`,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            eq(journalHeaders.status, "posted"),
            effectiveJournalPredicate(),
            inArray(journalLines.accountId, accountIds),
            gte(journalHeaders.transactionDate, dateFrom),
            lte(journalHeaders.transactionDate, dateTo),
          ),
        )
        .groupBy(sql`DATE_TRUNC('day', ${journalHeaders.transactionDate})`, accounts.accountType)
        .orderBy(sql`DATE_TRUNC('day', ${journalHeaders.transactionDate})`);

      // 2. Map day-level rows into the properly scaled output buckets (day, week, month)
      for (const row of groupedTotals) {
        if (!row.bucketDate) continue;

        const rowDate = new Date(row.bucketDate);
        const rowTimestamp = rowDate.getTime();

        // Find which bucket this day belongs to
        const targetBucket = buckets.find(
          (b) => rowTimestamp >= b.start.getTime() && rowTimestamp <= b.end.getTime(),
        );

        if (targetBucket) {
          const debit = Number.parseFloat(row.totalDebit);
          const credit = Number.parseFloat(row.totalCredit);

          const isDEA = ["asset", "expense", "cost_of_revenue", "other_expense"].includes(
            row.accountType,
          );

          const normalBalance = isDEA ? debit - credit : credit - debit;

          targetBucket.value += normalBalance;
        }
      }

      // Format numbers
      const formattedBuckets = buckets.map((b) => ({
        label: b.label,
        start: b.start.toISOString(),
        end: b.end.toISOString(),
        value: Number.parseFloat(b.value.toFixed(2)),
      }));

      const totalAmount = formattedBuckets.reduce((sum, b) => sum + b.value, 0);

      return {
        account,
        granularity,
        buckets: formattedBuckets,
        totalAmount: totalAmount.toFixed(2),
      };
    });
  });

const getChildCategoryStatsSchema = z.object({
  parentId: z.string().uuid(),
  dateFrom: z.string(),
  dateTo: z.string(),
});

/**
 * Get transaction stats for all child categories of a parent category (including nested)
 * Returns count, debit total, and credit total for each child
 */
export const getChildCategoryStats = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getChildCategoryStatsSchema>) =>
    getChildCategoryStatsSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getChildCategoryStatsSchema.parse(rawData);
      const { parentId, dateFrom, dateTo } = parsed;

      const allChildIds = await getAllDescendantIds(db, parentId, orgId);

      if (allChildIds.length === 0) {
        return {};
      }

      // Get transaction stats for all descendants
      const stats = await db
        .select({
          accountId: journalLines.accountId,
          accountType: accounts.accountType,
          transactionCount: sql<number>`COUNT(DISTINCT ${journalHeaders.id})::int`,
          totalDebit: sql<string>`COALESCE(SUM(COALESCE(${journalLines.debit}::numeric, 0)), 0)::text`,
          totalCredit: sql<string>`COALESCE(SUM(COALESCE(${journalLines.credit}::numeric, 0)), 0)::text`,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            eq(journalHeaders.status, "posted"),
            effectiveJournalPredicate(),
            inArray(journalLines.accountId, allChildIds),
            gte(journalHeaders.transactionDate, dateFrom),
            lte(journalHeaders.transactionDate, dateTo),
          ),
        )
        .groupBy(journalLines.accountId, accounts.accountType);

      // Convert to map for easy lookup
      const statsMap: Record<string, { count: number; balance: number }> = {};

      for (const stat of stats) {
        const debit = Number.parseFloat(stat.totalDebit);
        const credit = Number.parseFloat(stat.totalCredit);

        // Calculate normal balance based on account type (DEA-LER convention)
        const isDEA = ["asset", "expense", "cost_of_revenue", "other_expense"].includes(
          stat.accountType,
        );

        const normalBalance = isDEA ? debit - credit : credit - debit;

        statsMap[stat.accountId] = {
          count: stat.transactionCount,
          balance: normalBalance,
        };
      }

      // Fill in zeros for children with no transactions
      for (const childId of allChildIds) {
        if (!statsMap[childId]) {
          statsMap[childId] = { count: 0, balance: 0 };
        }
      }

      return statsMap;
    });
  });

const getChildCategoryTimeSeriesSchema = z.object({
  parentId: z.string().uuid(),
  dateFrom: z.string(),
  dateTo: z.string(),
});

/**
 * Get time-series data for sparkline charts for all child categories
 * Returns monthly ACTIVITY (not cumulative) for each child category
 */
export const getChildCategoryTimeSeries = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getChildCategoryTimeSeriesSchema>) =>
    getChildCategoryTimeSeriesSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getChildCategoryTimeSeriesSchema.parse(rawData);
      const { parentId, dateFrom, dateTo } = parsed;

      const allChildIds = await getAllDescendantIds(db, parentId, orgId);

      if (allChildIds.length === 0) {
        return {};
      }

      // Get monthly time-series data for each child - ACTIVITY not cumulative
      const timeSeries = await db
        .select({
          accountId: journalLines.accountId,
          accountType: accounts.accountType,
          month: sql<number>`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})::int`,
          year: sql<number>`EXTRACT(YEAR FROM ${journalHeaders.transactionDate})::int`,
          totalDebit: sql<string>`COALESCE(SUM(COALESCE(${journalLines.debit}::numeric, 0)), 0)::text`,
          totalCredit: sql<string>`COALESCE(SUM(COALESCE(${journalLines.credit}::numeric, 0)), 0)::text`,
          transactionCount: sql<number>`COUNT(DISTINCT ${journalHeaders.id})::int`,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            eq(journalHeaders.status, "posted"),
            effectiveJournalPredicate(),
            inArray(journalLines.accountId, allChildIds),
            gte(journalHeaders.transactionDate, dateFrom),
            lte(journalHeaders.transactionDate, dateTo),
          ),
        )
        .groupBy(
          journalLines.accountId,
          accounts.accountType,
          sql`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})`,
          sql`EXTRACT(YEAR FROM ${journalHeaders.transactionDate})`,
        )
        .orderBy(
          journalLines.accountId,
          sql`EXTRACT(YEAR FROM ${journalHeaders.transactionDate})`,
          sql`EXTRACT(MONTH FROM ${journalHeaders.transactionDate})`,
        );

      // Group by account and calculate normal balance for each month
      const seriesMap: Record<
        string,
        Array<{ month: number; year: number; value: number; count: number }>
      > = {};

      for (const row of timeSeries) {
        const debit = Number.parseFloat(row.totalDebit);
        const credit = Number.parseFloat(row.totalCredit);

        // Calculate normal balance based on account type (DEA-LER convention)
        const isDEA = ["asset", "expense", "cost_of_revenue", "other_expense"].includes(
          row.accountType,
        );

        const normalBalance = isDEA ? debit - credit : credit - debit;

        if (!seriesMap[row.accountId]) {
          seriesMap[row.accountId] = [];
        }

        seriesMap[row.accountId].push({
          month: row.month,
          year: row.year,
          value: Math.abs(normalBalance), // Use absolute value for activity visualization
          count: row.transactionCount,
        });
      }

      return seriesMap;
    });
  });

const getCategoryTransactionsSchema = z.object({
  categoryId: z.string().uuid(),
  dateFrom: z.string(),
  dateTo: z.string(),
  includeChildren: z.boolean().optional().default(false),
});

/**
 * Get transactions for a category with proper signed amounts based on normal balance
 * For parent categories, includes all child transactions
 */
export const getCategoryTransactions = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getCategoryTransactionsSchema>) =>
    getCategoryTransactionsSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    try {
      return withSessionOrgContext(async ({ orgId, db }) => {
        const parsed = getCategoryTransactionsSchema.parse(rawData);
        const { categoryId, dateFrom, dateTo, includeChildren } = parsed;

        // Get the category to determine account type
        const [category] = await db
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, categoryId), eq(accounts.organizationId, orgId)))
          .limit(1);

        if (!category) {
          return [];
        }

        // Get all account IDs to query (category + children if requested)
        let accountIds = [categoryId];

        if (includeChildren) {
          const childIds = await getAllDescendantIds(db, categoryId, orgId);
          accountIds = [categoryId, ...childIds];
        }

        // Get transactions that touch these accounts
        const txLines = await db
          .select({
            transactionId: journalHeaders.id,
            transactionDate: journalHeaders.transactionDate,
            transactionNumber: journalHeaders.transactionNumber,
            memo: journalHeaders.memo,
            partyName: parties.name,
            accountId: journalLines.accountId,
            accountType: accounts.accountType,
            categoryName: accounts.name,
            debit: journalLines.debit,
            credit: journalLines.credit,
          })
          .from(journalLines)
          .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
          .where(
            and(
              eq(journalHeaders.organizationId, orgId),
              eq(journalHeaders.status, "posted"),
              effectiveJournalPredicate(),
              inArray(journalLines.accountId, accountIds),
              gte(journalHeaders.transactionDate, dateFrom),
              lte(journalHeaders.transactionDate, dateTo),
            ),
          )
          .orderBy(desc(journalHeaders.transactionDate));

        if (txLines.length === 0) {
          return [];
        }

        // Group by transaction AND account to prevent cross-category zero-summing
        const txMap = new Map<
          string,
          {
            id: string; // Real transaction ID for routing
            accountId: string; // Account ID for unique grouping
            transactionDate: string;
            transactionNumber: string;
            memo: string;
            partyName: string;
            categoryName: string;
            totalAmount: number;
          }
        >();

        for (const line of txLines) {
          const key = `${line.transactionId}_${line.accountId}`;

          if (!txMap.has(key)) {
            // Convert date to ISO string
            let dateStr: string;
            if (line.transactionDate) {
              dateStr = line.transactionDate;
            } else {
              dateStr = new Date().toISOString().split("T")[0];
            }

            txMap.set(key, {
              id: line.transactionId,
              accountId: line.accountId,
              transactionDate: dateStr,
              transactionNumber: line.transactionNumber ?? "",
              memo: line.memo ?? "",
              partyName: line.partyName ?? "",
              categoryName: line.categoryName ?? "",
              totalAmount: 0,
            });
          }

          const tx = txMap.get(key)!;
          const debit = Number.parseFloat(line.debit || "0");
          const credit = Number.parseFloat(line.credit || "0");

          // Calculate signed amount based on account type (DEA-LER convention)
          const isDEA = ["asset", "expense", "cost_of_revenue", "other_expense"].includes(
            line.accountType,
          );

          const signedAmount = isDEA ? debit - credit : credit - debit;
          tx.totalAmount += signedAmount;
        }

        // Filter out zero totals (e.g. perfect in-and-out of the same account) and map to plain array
        const result = Array.from(txMap.values())
          .filter((tx) => Math.abs(tx.totalAmount) > 0.001)
          .map((tx) => ({
            id: tx.id,
            lineGroupId: `${tx.id}_${tx.accountId}`, // Unique key for React mapping
            transactionDate: tx.transactionDate,
            transactionNumber: tx.transactionNumber,
            memo: tx.memo,
            partyName: tx.partyName,
            categoryName: tx.categoryName,
            totalAmount: tx.totalAmount.toFixed(2),
            createdAt: tx.transactionDate,
          }));

        logger.debug("Returning category transactions", {
          orgId,
          categoryId,
          includeChildren,
          count: result.length,
        });
        return result;
      });
    } catch (error) {
      logger.error("getCategoryTransactions error", { error });
      return [];
    }
  });

/**
 * Backfill missing account numbers for all accounts in the org.
 * Iterates through accounts without numbers and auto-generates based on hierarchy.
 */
export const backfillAccountNumbers = createServerFn({ method: "POST" }).handler(async () => {
  return withMutationPermissionOrgContext(
    "account",
    "update",
    { routeKey: "account:backfill-numbers", limit: 5, windowMs: 300_000 },
    async ({ orgId, db }) => {
      // Find all accounts without numbers, ordered by depth (parents first)
      const missing = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, orgId), isNull(accounts.accountNumber)))
        .orderBy(asc(accounts.createdAt));

      let fixed = 0;
      for (const acct of missing) {
        const newNumber = await generateAccountNumber(
          db,
          orgId,
          acct.parentId ?? undefined,
          acct.accountType,
        );

        await db
          .update(accounts)
          .set({ accountNumber: newNumber, updatedAt: new Date() })
          .where(and(eq(accounts.id, acct.id), eq(accounts.organizationId, orgId)));

        fixed++;
      }

      return { fixed, total: missing.length };
    },
  );
});
