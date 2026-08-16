/**
 * Transactions API — Read Queries
 * List, detail, grouped, loadMore, balances, similar
 */
import { createServerFn } from "@tanstack/react-start";
import {
  effectiveJournalPredicate,
  journalHeaders,
  journalLines,
} from "../../../db/schema/journals";
import { accounts } from "../../../db/schema/accounts";
import { journalDuplicateMerges } from "../../../db/schema/match-history";
import { parties } from "../../../db/schema/parties";
import { dimensions } from "../../../db/schema/dimensions";
import { user as authUsers } from "../../../db/schema/auth";
import { integrationSources, ledgerSourceLinks, sourceRecords } from "../../../db/schema/inbox";
import { eq, desc, and, inArray, gte, lte, sql, asc, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isDateInLockedPeriod } from "../../../lib/period-close";
import { withSessionOrgContext } from "../../../lib/server-context";

import {
  listTransactionsSchema,
  groupedTransactionsSchema,
  loadMoreSchema,
  accountBalancesSchema,
  getTransactionSchema,
} from "./-_shared";

const similarTransactionsSchema = z.object({
  transactionId: z.string().uuid(),
  limit: z.number().int().min(1).max(20).optional().default(10),
});

// ============================================================================
// Server Functions — Reads
// ============================================================================

/**
 * List transactions with filters and pagination
 */
export const listTransactions = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listTransactionsSchema>) =>
    listTransactionsSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = listTransactionsSchema.parse(rawData ?? {});
      const {
        types,
        statuses,
        dateFrom,
        dateTo,
        partyId,
        partyIds,
        accountId,
        departmentIds,
        locationIds,
        search,
        limit,
        offset,
      } = parsed;

      const conditions = [eq(journalHeaders.organizationId, orgId), effectiveJournalPredicate()];

      if (types.length > 0) {
        conditions.push(inArray(journalHeaders.transactionType, types));
      }

      if (statuses.length > 0) {
        conditions.push(inArray(journalHeaders.status, statuses));
      }

      if (dateFrom) {
        conditions.push(gte(journalHeaders.transactionDate, dateFrom));
      }

      if (dateTo) {
        conditions.push(lte(journalHeaders.transactionDate, dateTo));
      }

      if (partyIds && partyIds.length > 0) {
        conditions.push(inArray(journalHeaders.partyId, partyIds));
      } else if (partyId) {
        conditions.push(eq(journalHeaders.partyId, partyId));
      }

      if (search && search.trim()) {
        const q = `%${search.trim()}%`;
        conditions.push(
          or(
            ilike(journalHeaders.memo, q),
            ilike(journalHeaders.transactionNumber, q),
            ilike(journalHeaders.referenceNumber, q),
            ilike(parties.name, q),
          ) as SQL<unknown>,
        );
      }

      let accountFilterHeaderIds: string[] | null = null;
      if (accountId) {
        const matchingLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(eq(journalLines.accountId, accountId));
        accountFilterHeaderIds = matchingLines.map((l) => l.headerId);
        if (accountFilterHeaderIds.length === 0) return [];
        conditions.push(inArray(journalHeaders.id, accountFilterHeaderIds));
      }

      if (departmentIds && departmentIds.length > 0) {
        const deptLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(inArray(journalLines.departmentId, departmentIds));
        const deptHeaderIds = deptLines.map((l) => l.headerId);
        if (deptHeaderIds.length === 0) return [];
        conditions.push(inArray(journalHeaders.id, deptHeaderIds));
      }

      if (locationIds && locationIds.length > 0) {
        const locLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(inArray(journalLines.locationId, locationIds));
        const locHeaderIds = locLines.map((l) => l.headerId);
        if (locHeaderIds.length === 0) return [];
        conditions.push(inArray(journalHeaders.id, locHeaderIds));
      }

      // Fetch headers with party name + creator name join
      const rows = await db
        .select({
          id: journalHeaders.id,
          transactionNumber: journalHeaders.transactionNumber,
          referenceNumber: journalHeaders.referenceNumber,
          transactionDate: journalHeaders.transactionDate,
          transactionType: journalHeaders.transactionType,
          source: journalHeaders.source,
          memo: journalHeaders.memo,
          partyId: journalHeaders.partyId,
          totalAmount: journalHeaders.totalAmount,
          status: journalHeaders.status,
          duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
          isMatched: journalHeaders.isMatched,
          sourceDocumentId: journalHeaders.sourceDocumentId,
          sourceDocumentType: journalHeaders.sourceDocumentType,
          createdAt: journalHeaders.createdAt,
          updatedAt: journalHeaders.updatedAt,
          postedAt: journalHeaders.postedAt,
          voidedAt: journalHeaders.voidedAt,
          partyName: parties.name,
          createdByName: authUsers.name,
        })
        .from(journalHeaders)
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .leftJoin(authUsers, eq(journalHeaders.createdBy, authUsers.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(journalHeaders.transactionDate), desc(journalHeaders.createdAt))
        .limit(limit)
        .offset(offset);

      // Get line counts + per-account amounts for each transaction
      const headerIds = rows.map((r) => r.id);
      let lineCounts: Record<string, number> = {};
      let accountAmounts: Record<string, { debit: string; credit: string; categoryName: string }> =
        {};
      let lineCategories: Record<string, { name: string; accountId: string }> = {};
      let txnDeptLoc: Record<string, { departmentId: string | null; locationId: string | null }> =
        {};
      let txnDimMap: Record<string, string> = {};

      if (headerIds.length > 0) {
        const counts = await db
          .select({
            headerId: journalLines.journalHeaderId,
            count: sql<number>`count(*)::int`,
          })
          .from(journalLines)
          .where(inArray(journalLines.journalHeaderId, headerIds))
          .groupBy(journalLines.journalHeaderId);

        lineCounts = Object.fromEntries(counts.map((c) => [c.headerId, c.count]));

        // If we have an account filter, get the per-line amount for that account
        // and the contra-account (category) from the other side
        if (accountId) {
          const accountLines = await db
            .select({
              headerId: journalLines.journalHeaderId,
              debit: journalLines.debit,
              credit: journalLines.credit,
            })
            .from(journalLines)
            .where(
              and(
                inArray(journalLines.journalHeaderId, headerIds),
                eq(journalLines.accountId, accountId),
              ),
            );

          // Get contra-account (category) — the OTHER line's account
          const contraLines = await db
            .select({
              headerId: journalLines.journalHeaderId,
              accountName: accounts.name,
            })
            .from(journalLines)
            .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
            .where(
              and(
                inArray(journalLines.journalHeaderId, headerIds),
                sql`${journalLines.accountId} != ${accountId}`,
              ),
            );

          const contraMap: Record<string, string> = {};
          for (const cl of contraLines) {
            if (!contraMap[cl.headerId]) {
              contraMap[cl.headerId] = cl.accountName;
            }
          }

          for (const al of accountLines) {
            accountAmounts[al.headerId] = {
              debit: al.debit ?? "0",
              credit: al.credit ?? "0",
              categoryName: contraMap[al.headerId] ?? "",
            };
          }
        }

        // Always resolve a categoryName from journal lines when not filtered by accountId.
        // For Pay In/Out the category is the "Pay For" side (the non-bank-account line).
        // We grab the first line's account name as the primary category for display.
        if (!accountId) {
          const firstLines = await db
            .select({
              headerId: journalLines.journalHeaderId,
              accountId: journalLines.accountId,
              accountName: accounts.name,
              sortOrder: journalLines.sortOrder,
            })
            .from(journalLines)
            .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
            .where(inArray(journalLines.journalHeaderId, headerIds))
            .orderBy(desc(journalLines.sortOrder));

          // Use last sort-order line (the "Pay For" line) as category,
          // since sort 0 is typically the bank/cash account (Pay In Category)
          for (const fl of firstLines) {
            // First one wins per header (highest sortOrder = the "for" side)
            if (!lineCategories[fl.headerId]) {
              lineCategories[fl.headerId] = { name: fl.accountName, accountId: fl.accountId };
            }
          }
        }

        // Resolve department + location per transaction from journal lines.
        // Use the highest-sortOrder line (the "category" / "for" side) for each header.
        const deptLocLines = await db
          .select({
            headerId: journalLines.journalHeaderId,
            departmentId: journalLines.departmentId,
            locationId: journalLines.locationId,
            sortOrder: journalLines.sortOrder,
          })
          .from(journalLines)
          .where(inArray(journalLines.journalHeaderId, headerIds))
          .orderBy(desc(journalLines.sortOrder));

        for (const dl of deptLocLines) {
          // First one wins per header (highest sortOrder)
          if (!txnDeptLoc[dl.headerId]) {
            txnDeptLoc[dl.headerId] = {
              departmentId: dl.departmentId,
              locationId: dl.locationId,
            };
          }
        }

        // Batch-resolve dimension names
        const allDimIds = [
          ...new Set(
            Object.values(txnDeptLoc)
              .flatMap((v) => [v.departmentId, v.locationId])
              .filter(Boolean) as string[],
          ),
        ];
        if (allDimIds.length > 0) {
          const dims = await db
            .select({ id: dimensions.id, name: dimensions.name })
            .from(dimensions)
            .where(inArray(dimensions.id, allDimIds));
          txnDimMap = Object.fromEntries(dims.map((d) => [d.id, d.name]));
        }
      }

      return rows.map((r) => ({
        ...r,
        lineCount: lineCounts[r.id] || 0,
        accountDebit: accountAmounts[r.id]?.debit,
        accountCredit: accountAmounts[r.id]?.credit,
        categoryName: accountAmounts[r.id]?.categoryName ?? lineCategories[r.id]?.name,
        categoryId: lineCategories[r.id]?.accountId,
        departmentId: txnDeptLoc[r.id]?.departmentId ?? null,
        departmentName: txnDeptLoc[r.id]?.departmentId
          ? (txnDimMap[txnDeptLoc[r.id].departmentId!] ?? null)
          : null,
        locationId: txnDeptLoc[r.id]?.locationId ?? null,
        locationName: txnDeptLoc[r.id]?.locationId
          ? (txnDimMap[txnDeptLoc[r.id].locationId!] ?? null)
          : null,
      }));
    });
  });

/**
 * Get a single transaction with all journal lines
 */
export const getTransaction = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getTransactionSchema>) => getTransactionSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getTransactionSchema.parse(rawData);

      const [header] = await db
        .select({
          id: journalHeaders.id,
          transactionNumber: journalHeaders.transactionNumber,
          referenceNumber: journalHeaders.referenceNumber,
          transactionDate: journalHeaders.transactionDate,
          transactionType: journalHeaders.transactionType,
          source: journalHeaders.source,
          memo: journalHeaders.memo,
          partyId: journalHeaders.partyId,
          totalAmount: journalHeaders.totalAmount,
          status: journalHeaders.status,
          duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
          sourceDocumentId: journalHeaders.sourceDocumentId,
          sourceDocumentType: journalHeaders.sourceDocumentType,
          createdAt: journalHeaders.createdAt,
          updatedAt: journalHeaders.updatedAt,
          postedAt: journalHeaders.postedAt,
          voidedAt: journalHeaders.voidedAt,
          partyName: parties.name,
          createdByName: authUsers.name,
        })
        .from(journalHeaders)
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .leftJoin(authUsers, eq(journalHeaders.createdBy, authUsers.id))
        .where(and(eq(journalHeaders.id, parsed.id), eq(journalHeaders.organizationId, orgId)))
        .limit(1);

      if (!header) {
        throw new Error("Transaction not found");
      }

      const lines = await db
        .select({
          id: journalLines.id,
          journalHeaderId: journalLines.journalHeaderId,
          accountId: journalLines.accountId,
          debit: journalLines.debit,
          credit: journalLines.credit,
          lineDescription: journalLines.lineDescription,
          partyId: journalLines.partyId,
          departmentId: journalLines.departmentId,
          locationId: journalLines.locationId,
          sortOrder: journalLines.sortOrder,
          createdAt: journalLines.createdAt,
          accountName: accounts.name,
          accountNumber: accounts.accountNumber,
        })
        .from(journalLines)
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .where(eq(journalLines.journalHeaderId, parsed.id))
        .orderBy(asc(journalLines.sortOrder));

      const periodLock = await isDateInLockedPeriod(orgId, header.transactionDate);
      const duplicateMerges = await db
        .select({
          id: journalDuplicateMerges.id,
          canonicalTransactionId: journalDuplicateMerges.canonicalHeaderId,
          duplicateTransactionId: journalDuplicateMerges.duplicateHeaderId,
          state: journalDuplicateMerges.state,
        })
        .from(journalDuplicateMerges)
        .where(
          and(
            eq(journalDuplicateMerges.organizationId, orgId),
            eq(journalDuplicateMerges.state, "active"),
            or(
              eq(journalDuplicateMerges.canonicalHeaderId, parsed.id),
              eq(journalDuplicateMerges.duplicateHeaderId, parsed.id),
            ),
          ),
        );
      const evidenceHeaderIds =
        header.duplicateOfHeaderId === null
          ? [
              parsed.id,
              ...duplicateMerges
                .filter(({ canonicalTransactionId }) => canonicalTransactionId === parsed.id)
                .map(({ duplicateTransactionId }) => duplicateTransactionId),
            ]
          : [parsed.id];
      const sourceEvidence = await db
        .select({
          journalHeaderId: ledgerSourceLinks.journalHeaderId,
          relationship: ledgerSourceLinks.relationship,
          sourceRecordId: sourceRecords.id,
          recordType: sourceRecords.recordType,
          providerStatus: sourceRecords.providerStatus,
          economicEventClass: sourceRecords.economicEventClass,
          direction: sourceRecords.direction,
          description: sourceRecords.description,
          amount: sourceRecords.originalAmount,
          currency: sourceRecords.originalCurrency,
          effectiveDate: sourceRecords.effectiveDate,
          provider: integrationSources.provider,
          channel: integrationSources.channel,
          sourceName: integrationSources.name,
        })
        .from(ledgerSourceLinks)
        .innerJoin(sourceRecords, eq(ledgerSourceLinks.sourceRecordId, sourceRecords.id))
        .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
        .where(
          and(
            eq(ledgerSourceLinks.organizationId, orgId),
            inArray(ledgerSourceLinks.journalHeaderId, evidenceHeaderIds),
          ),
        );
      const duplicateMerge = duplicateMerges[0] ?? null;

      return {
        ...header,
        createdAt:
          header.createdAt instanceof Date ? header.createdAt.toISOString() : header.createdAt,
        updatedAt:
          header.updatedAt instanceof Date ? header.updatedAt.toISOString() : header.updatedAt,
        postedAt: header.postedAt instanceof Date ? header.postedAt.toISOString() : header.postedAt,
        voidedAt: header.voidedAt instanceof Date ? header.voidedAt.toISOString() : header.voidedAt,
        lines,
        isLocked: periodLock.locked,
        closedThrough: periodLock.closedThrough,
        sourceEvidence,
        duplicateMerges: duplicateMerges.map((merge) => ({
          ...merge,
          role:
            merge.canonicalTransactionId === parsed.id
              ? ("canonical" as const)
              : ("duplicate" as const),
        })),
        duplicateMerge: duplicateMerge
          ? {
              ...duplicateMerge,
              role:
                duplicateMerge.canonicalTransactionId === parsed.id
                  ? ("canonical" as const)
                  : ("duplicate" as const),
            }
          : null,
      };
    });
  });

/**
 * List account balances — aggregated debits/credits per account
 * Used for the "Balances" view in the Ledger
 */
export const listAccountBalances = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof accountBalancesSchema>) =>
    accountBalancesSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = accountBalancesSchema.parse(rawData ?? {});
      const { dateFrom, dateTo, statuses } = parsed;

      const headerConditions = [
        eq(journalHeaders.organizationId, orgId),
        effectiveJournalPredicate(),
      ];
      if (statuses.length > 0) {
        headerConditions.push(inArray(journalHeaders.status, statuses));
      }
      if (dateFrom) {
        headerConditions.push(gte(journalHeaders.transactionDate, dateFrom));
      }
      if (dateTo) {
        headerConditions.push(lte(journalHeaders.transactionDate, dateTo));
      }

      const balances = await db
        .select({
          accountId: journalLines.accountId,
          accountName: accounts.name,
          accountNumber: accounts.accountNumber,
          accountType: accounts.accountType,
          parentId: accounts.parentId,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
          transactionCount: sql<number>`count(distinct ${journalLines.journalHeaderId})::int`,
        })
        .from(journalLines)
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .where(headerConditions.length > 0 ? and(...headerConditions) : undefined)
        .groupBy(
          journalLines.accountId,
          accounts.name,
          accounts.accountNumber,
          accounts.accountType,
          accounts.parentId,
        )
        .orderBy(asc(accounts.accountNumber), asc(accounts.name));

      return balances.map((b) => {
        const debit = Number.parseFloat(b.totalDebit);
        const credit = Number.parseFloat(b.totalCredit);
        const balance = debit - credit;
        return {
          ...b,
          balance: balance.toFixed(2),
        };
      });
    });
  });

/**
 * List transactions grouped by account — used for the "all accounts" view
 * Returns each account that has transactions in the period with:
 *   - account info (id, name, number, type, parentPath, icon)
 *   - balance and transaction count
 *   - first N transactions for initial render
 */
export const listTransactionsGrouped = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof groupedTransactionsSchema>) =>
    groupedTransactionsSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = groupedTransactionsSchema.parse(rawData ?? {});
      const {
        types,
        statuses,
        dateFrom,
        dateTo,
        partyIds,
        departmentIds,
        locationIds,
        search,
        perAccountLimit,
      } = parsed;

      // Build header conditions
      const headerConditions = [
        eq(journalHeaders.organizationId, orgId),
        effectiveJournalPredicate(),
      ];
      if (types.length > 0) {
        headerConditions.push(inArray(journalHeaders.transactionType, types));
      }
      if (statuses.length > 0) {
        headerConditions.push(inArray(journalHeaders.status, statuses));
      }
      if (dateFrom) {
        headerConditions.push(gte(journalHeaders.transactionDate, dateFrom));
      }
      if (dateTo) {
        headerConditions.push(lte(journalHeaders.transactionDate, dateTo));
      }
      if (partyIds && partyIds.length > 0) {
        headerConditions.push(inArray(journalHeaders.partyId, partyIds));
      }

      if (search && search.trim()) {
        const q = `%${search.trim()}%`;
        headerConditions.push(
          or(
            ilike(journalHeaders.memo, q),
            ilike(journalHeaders.transactionNumber, q),
            ilike(journalHeaders.referenceNumber, q),
            ilike(parties.name, q),
          ) as SQL<unknown>,
        );
      }

      // Department filter: find headers whose lines match the selected departments
      if (departmentIds && departmentIds.length > 0) {
        const deptLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(inArray(journalLines.departmentId, departmentIds));
        const deptHeaderIds = deptLines.map((l) => l.headerId);
        if (deptHeaderIds.length === 0) return [];
        headerConditions.push(inArray(journalHeaders.id, deptHeaderIds));
      }

      // Location filter: find headers whose lines match the selected locations
      if (locationIds && locationIds.length > 0) {
        const locLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(inArray(journalLines.locationId, locationIds));
        const locHeaderIds = locLines.map((l) => l.headerId);
        if (locHeaderIds.length === 0) return [];
        headerConditions.push(inArray(journalHeaders.id, locHeaderIds));
      }

      // Step 1: Get all accounts with their aggregated balance + count
      const accountAggregates = await db
        .select({
          accountId: journalLines.accountId,
          accountName: accounts.name,
          accountNumber: accounts.accountNumber,
          accountType: accounts.accountType,
          accountSubtype: accounts.subtype,
          accountIcon: accounts.icon,
          parentId: accounts.parentId,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
          transactionCount: sql<number>`count(distinct ${journalLines.journalHeaderId})::int`,
        })
        .from(journalLines)
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .where(headerConditions.length > 0 ? and(...headerConditions) : undefined)
        .groupBy(
          journalLines.accountId,
          accounts.name,
          accounts.accountNumber,
          accounts.accountType,
          accounts.subtype,
          accounts.icon,
          accounts.parentId,
        )
        .orderBy(asc(accounts.accountNumber), asc(accounts.name));

      if (accountAggregates.length === 0) return [];

      // Step 2: Build parent path for each account (breadcrumb)
      // Collect all parentIds that need names
      const parentIds = new Set<string>();
      for (const acc of accountAggregates) {
        if (acc.parentId) parentIds.add(acc.parentId);
      }

      let parentMap: Record<string, { name: string; parentId: string | null }> = {};
      if (parentIds.size > 0) {
        // Recursively fetch parents up to 3 levels deep
        const allParentIds = new Set(parentIds);
        for (let depth = 0; depth < 3; depth++) {
          const idsToFetch = [...allParentIds].filter((id) => !parentMap[id]);
          if (idsToFetch.length === 0) break;

          const parents = await db
            .select({
              id: accounts.id,
              name: accounts.name,
              parentId: accounts.parentId,
            })
            .from(accounts)
            .where(inArray(accounts.id, idsToFetch));

          for (const p of parents) {
            parentMap[p.id] = { name: p.name, parentId: p.parentId };
            if (p.parentId) allParentIds.add(p.parentId);
          }
        }
      }

      // Build breadcrumb path for each account
      const getParentPath = (parentId: string | null): string[] => {
        const path: string[] = [];
        let currentId = parentId;
        for (let i = 0; i < 5 && currentId; i++) {
          const parent = parentMap[currentId];
          if (!parent) break;
          path.unshift(parent.name);
          currentId = parent.parentId;
        }
        return path;
      };

      // Step 3: Get first N transactions for each account
      const accountIds = accountAggregates.map((a) => a.accountId);

      // Get all journal lines for our accounts in the period
      const allLines = await db
        .select({
          accountId: journalLines.accountId,
          headerId: journalLines.journalHeaderId,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .where(
          and(
            inArray(journalLines.accountId, accountIds),
            ...(headerConditions.length > 0 ? headerConditions : []),
          ),
        )
        .orderBy(desc(journalHeaders.transactionDate), desc(journalHeaders.createdAt));

      // Group line data by account
      const accountLineData: Record<
        string,
        { headerId: string; debit: string | null; credit: string | null }[]
      > = {};
      for (const line of allLines) {
        if (!accountLineData[line.accountId]) {
          accountLineData[line.accountId] = [];
        }
        accountLineData[line.accountId].push({
          headerId: line.headerId,
          debit: line.debit,
          credit: line.credit,
        });
      }

      // Get unique header IDs across all accounts (limited per account)
      const headerIdsNeeded = new Set<string>();
      const accountHeaderOrder: Record<string, string[]> = {};
      for (const accId of accountIds) {
        const lines = accountLineData[accId] ?? [];
        // Get unique headers in order, limited to perAccountLimit
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const line of lines) {
          if (!seen.has(line.headerId)) {
            seen.add(line.headerId);
            ordered.push(line.headerId);
            headerIdsNeeded.add(line.headerId);
            if (ordered.length >= perAccountLimit) break;
          }
        }
        accountHeaderOrder[accId] = ordered;
      }

      // Fetch all needed headers with party info
      let headerMap: Record<string, any> = {};
      if (headerIdsNeeded.size > 0) {
        const headers = await db
          .select({
            id: journalHeaders.id,
            transactionNumber: journalHeaders.transactionNumber,
            referenceNumber: journalHeaders.referenceNumber,
            transactionDate: journalHeaders.transactionDate,
            transactionType: journalHeaders.transactionType,
            source: journalHeaders.source,
            memo: journalHeaders.memo,
            totalAmount: journalHeaders.totalAmount,
            status: journalHeaders.status,
            createdAt: journalHeaders.createdAt,
            partyName: parties.name,
            createdByName: authUsers.name,
          })
          .from(journalHeaders)
          .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
          .leftJoin(authUsers, eq(journalHeaders.createdBy, authUsers.id))
          .where(inArray(journalHeaders.id, [...headerIdsNeeded]));

        for (const h of headers) {
          headerMap[h.id] = h;
        }
      }

      // Get line counts for all fetched headers
      let lineCounts: Record<string, number> = {};
      if (headerIdsNeeded.size > 0) {
        const counts = await db
          .select({
            headerId: journalLines.journalHeaderId,
            count: sql<number>`count(*)::int`,
          })
          .from(journalLines)
          .where(inArray(journalLines.journalHeaderId, [...headerIdsNeeded]))
          .groupBy(journalLines.journalHeaderId);

        lineCounts = Object.fromEntries(counts.map((c) => [c.headerId, c.count]));
      }

      // Resolve department + location per transaction from journal lines (highest sortOrder)
      let grpDeptLoc: Record<string, { departmentId: string | null; locationId: string | null }> =
        {};
      let grpDimMap: Record<string, string> = {};
      if (headerIdsNeeded.size > 0) {
        const deptLocRows = await db
          .select({
            headerId: journalLines.journalHeaderId,
            departmentId: journalLines.departmentId,
            locationId: journalLines.locationId,
            sortOrder: journalLines.sortOrder,
          })
          .from(journalLines)
          .where(inArray(journalLines.journalHeaderId, [...headerIdsNeeded]))
          .orderBy(desc(journalLines.sortOrder));

        for (const dl of deptLocRows) {
          if (!grpDeptLoc[dl.headerId]) {
            grpDeptLoc[dl.headerId] = {
              departmentId: dl.departmentId,
              locationId: dl.locationId,
            };
          }
        }

        const dimIds = [
          ...new Set(
            Object.values(grpDeptLoc)
              .flatMap((v) => [v.departmentId, v.locationId])
              .filter(Boolean) as string[],
          ),
        ];
        if (dimIds.length > 0) {
          const dims = await db
            .select({ id: dimensions.id, name: dimensions.name })
            .from(dimensions)
            .where(inArray(dimensions.id, dimIds));
          grpDimMap = Object.fromEntries(dims.map((d) => [d.id, d.name]));
        }
      }

      // Step 4: Assemble results
      return accountAggregates.map((acc) => {
        const balance = `${acc.totalDebit}|${acc.totalCredit}`;
        const parentPath = getParentPath(acc.parentId);

        const headerIds = accountHeaderOrder[acc.accountId] ?? [];
        const lineDataForAccount = accountLineData[acc.accountId] ?? [];

        const transactions = headerIds
          .map((hid) => {
            const header = headerMap[hid];
            if (!header) return null;

            // Find the line amount for this account
            const lineForThisAccount = lineDataForAccount.find((l) => l.headerId === hid);
            const dl = grpDeptLoc[hid];

            return {
              ...header,
              lineCount: lineCounts[hid] || 0,
              accountDebit: lineForThisAccount?.debit ?? "0",
              accountCredit: lineForThisAccount?.credit ?? "0",
              // Category = the account that placed this transaction into this group
              categoryName: acc.accountName,
              categoryAccountId: acc.accountId,
              departmentId: dl?.departmentId ?? null,
              departmentName: dl?.departmentId ? (grpDimMap[dl.departmentId] ?? null) : null,
              locationId: dl?.locationId ?? null,
              locationName: dl?.locationId ? (grpDimMap[dl.locationId] ?? null) : null,
            };
          })
          .filter(Boolean);

        return {
          accountId: acc.accountId,
          accountName: acc.accountName,
          accountNumber: acc.accountNumber,
          accountType: acc.accountType,
          accountSubtype: acc.accountSubtype,
          accountIcon: acc.accountIcon,
          parentPath,
          balance,
          transactionCount: acc.transactionCount,
          transactions,
          hasMore: acc.transactionCount > perAccountLimit,
        };
      });
    });
  });

/**
 * Load more transactions for a specific account — used for per-group pagination
 */
export const loadMoreTransactions = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof loadMoreSchema>) => loadMoreSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = loadMoreSchema.parse(rawData);
      const {
        accountId,
        types,
        statuses,
        dateFrom,
        dateTo,
        partyIds,
        departmentIds,
        locationIds,
        search,
        limit,
        offset,
      } = parsed;

      // Build header conditions
      const headerConditions = [
        eq(journalHeaders.organizationId, orgId),
        effectiveJournalPredicate(),
      ];
      if (types.length > 0) {
        headerConditions.push(inArray(journalHeaders.transactionType, types));
      }
      if (statuses.length > 0) {
        headerConditions.push(inArray(journalHeaders.status, statuses));
      }
      if (dateFrom) {
        headerConditions.push(gte(journalHeaders.transactionDate, dateFrom));
      }
      if (dateTo) {
        headerConditions.push(lte(journalHeaders.transactionDate, dateTo));
      }
      if (partyIds && partyIds.length > 0) {
        headerConditions.push(inArray(journalHeaders.partyId, partyIds));
      }

      if (search && search.trim()) {
        const q = `%${search.trim()}%`;
        headerConditions.push(
          or(
            ilike(journalHeaders.memo, q),
            ilike(journalHeaders.transactionNumber, q),
            ilike(journalHeaders.referenceNumber, q),
            // For party name, we need to join parties when querying
            ilike(parties.name, q),
          ) as SQL<unknown>,
        );
      }

      // Department filter
      if (departmentIds && departmentIds.length > 0) {
        const deptLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(inArray(journalLines.departmentId, departmentIds));
        const deptHeaderIds = deptLines.map((l) => l.headerId);
        if (deptHeaderIds.length === 0) return { transactions: [], hasMore: false };
        headerConditions.push(inArray(journalHeaders.id, deptHeaderIds));
      }

      // Location filter
      if (locationIds && locationIds.length > 0) {
        const locLines = await db
          .selectDistinct({ headerId: journalLines.journalHeaderId })
          .from(journalLines)
          .where(inArray(journalLines.locationId, locationIds));
        const locHeaderIds = locLines.map((l) => l.headerId);
        if (locHeaderIds.length === 0) return { transactions: [], hasMore: false };
        headerConditions.push(inArray(journalHeaders.id, locHeaderIds));
      }

      // Find header IDs that touch this account
      const matchingLines = await db
        .select({
          headerId: journalLines.journalHeaderId,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id)) // Join parties for search
        .where(
          and(
            eq(journalLines.accountId, accountId),
            ...(headerConditions.length > 0 ? headerConditions : []),
          ),
        )
        .orderBy(desc(journalHeaders.transactionDate), desc(journalHeaders.createdAt));

      // Deduplicate by headerId and apply offset/limit
      const seen = new Set<string>();
      const deduped: { headerId: string; debit: string | null; credit: string | null }[] = [];
      for (const line of matchingLines) {
        if (!seen.has(line.headerId)) {
          seen.add(line.headerId);
          deduped.push(line);
        }
      }

      const paged = deduped.slice(offset, offset + limit);
      if (paged.length === 0) return { transactions: [], hasMore: false };

      const headerIds = paged.map((p) => p.headerId);

      // Fetch headers
      const headers = await db
        .select({
          id: journalHeaders.id,
          transactionNumber: journalHeaders.transactionNumber,
          referenceNumber: journalHeaders.referenceNumber,
          transactionDate: journalHeaders.transactionDate,
          transactionType: journalHeaders.transactionType,
          source: journalHeaders.source,
          memo: journalHeaders.memo,
          totalAmount: journalHeaders.totalAmount,
          status: journalHeaders.status,
          createdAt: journalHeaders.createdAt,
          partyName: parties.name,
          createdByName: authUsers.name,
        })
        .from(journalHeaders)
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .leftJoin(authUsers, eq(journalHeaders.createdBy, authUsers.id))
        .where(inArray(journalHeaders.id, headerIds));

      const headerMap: Record<string, any> = {};
      for (const h of headers) {
        headerMap[h.id] = h;
      }

      // Line counts
      const counts = await db
        .select({
          headerId: journalLines.journalHeaderId,
          count: sql<number>`count(*)::int`,
        })
        .from(journalLines)
        .where(inArray(journalLines.journalHeaderId, headerIds))
        .groupBy(journalLines.journalHeaderId);

      const lineCounts = Object.fromEntries(counts.map((c) => [c.headerId, c.count]));

      // Category = the account that placed these transactions into this group
      const groupAccount = await db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      const groupAccountName = groupAccount[0]?.name ?? "";

      // Resolve department + location per transaction from journal lines (highest sortOrder)
      const moreDeptLocRows = await db
        .select({
          headerId: journalLines.journalHeaderId,
          departmentId: journalLines.departmentId,
          locationId: journalLines.locationId,
          sortOrder: journalLines.sortOrder,
        })
        .from(journalLines)
        .where(inArray(journalLines.journalHeaderId, headerIds))
        .orderBy(desc(journalLines.sortOrder));

      const moreDeptLoc: Record<
        string,
        { departmentId: string | null; locationId: string | null }
      > = {};
      for (const dl of moreDeptLocRows) {
        if (!moreDeptLoc[dl.headerId]) {
          moreDeptLoc[dl.headerId] = {
            departmentId: dl.departmentId,
            locationId: dl.locationId,
          };
        }
      }

      const moreDimIds = [
        ...new Set(
          Object.values(moreDeptLoc)
            .flatMap((v) => [v.departmentId, v.locationId])
            .filter(Boolean) as string[],
        ),
      ];
      let moreDimMap: Record<string, string> = {};
      if (moreDimIds.length > 0) {
        const dims = await db
          .select({ id: dimensions.id, name: dimensions.name })
          .from(dimensions)
          .where(inArray(dimensions.id, moreDimIds));
        moreDimMap = Object.fromEntries(dims.map((d) => [d.id, d.name]));
      }

      const transactions = paged
        .map((p) => {
          const header = headerMap[p.headerId];
          if (!header) return null;
          const dl = moreDeptLoc[p.headerId];
          return {
            ...header,
            lineCount: lineCounts[p.headerId] || 0,
            accountDebit: p.debit ?? "0",
            accountCredit: p.credit ?? "0",
            categoryName: groupAccountName,
            categoryAccountId: accountId,
            departmentId: dl?.departmentId ?? null,
            departmentName: dl?.departmentId ? (moreDimMap[dl.departmentId] ?? null) : null,
            locationId: dl?.locationId ?? null,
            locationName: dl?.locationId ? (moreDimMap[dl.locationId] ?? null) : null,
          };
        })
        .filter(Boolean);

      return {
        transactions,
        hasMore: offset + limit < deduped.length,
      };
    });
  });

/**
 * Get similar transactions — transactions that share any of the same
 * category accounts as the given transaction's journal lines.
 * Excludes the source transaction itself. Sorted newest-first.
 */
export const getSimilarTransactions = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof similarTransactionsSchema>) =>
    similarTransactionsSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = similarTransactionsSchema.parse(rawData);
      const { transactionId, limit } = parsed;

      // 1. Get the account IDs from the target transaction's journal lines
      const txnLines = await db
        .select({ accountId: journalLines.accountId })
        .from(journalLines)
        .where(eq(journalLines.journalHeaderId, transactionId));

      if (txnLines.length === 0) return [];

      const accountIds = [...new Set(txnLines.map((l) => l.accountId))];

      // 2. Find other transactions that touch these same accounts
      const matchingHeaderIds = await db
        .selectDistinct({ headerId: journalLines.journalHeaderId })
        .from(journalLines)
        .where(
          and(
            inArray(journalLines.accountId, accountIds),
            sql`${journalLines.journalHeaderId} != ${transactionId}`,
          ),
        );

      if (matchingHeaderIds.length === 0) return [];

      const headerIds = matchingHeaderIds.map((r) => r.headerId);

      // 3. Fetch those transactions with party + category info
      const rows = await db
        .select({
          id: journalHeaders.id,
          transactionDate: journalHeaders.transactionDate,
          transactionType: journalHeaders.transactionType,
          totalAmount: journalHeaders.totalAmount,
          memo: journalHeaders.memo,
          partyId: journalHeaders.partyId,
          partyName: parties.name,
          partyType: parties.partyType,
        })
        .from(journalHeaders)
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            effectiveJournalPredicate(),
            inArray(journalHeaders.id, headerIds),
          ),
        )
        .orderBy(desc(journalHeaders.transactionDate))
        .limit(limit);

      // 4. Get the primary category (highest sortOrder line) for each result
      const resultIds = rows.map((r) => r.id);
      let categories: Record<string, string> = {};

      if (resultIds.length > 0) {
        const categoryLines = await db
          .select({
            headerId: journalLines.journalHeaderId,
            accountName: accounts.name,
            sortOrder: journalLines.sortOrder,
          })
          .from(journalLines)
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .where(inArray(journalLines.journalHeaderId, resultIds))
          .orderBy(desc(journalLines.sortOrder));

        for (const cl of categoryLines) {
          if (!categories[cl.headerId]) {
            categories[cl.headerId] = cl.accountName;
          }
        }
      }

      return rows.map((r) => ({
        ...r,
        categoryName: categories[r.id] ?? null,
      }));
    });
  });
