/**
 * Reports API Server Functions
 * Boundary layer for TanStack Start SSR
 */
import { createServerFn } from "@tanstack/react-start";
import { moneyToCents } from "../../lib/money";
import {
  reportPeriodSchema,
  balanceSheetSchema,
  agingSchema,
  portfolioProfitLossSchema,
} from "../../db/validation/reports";
import { bills } from "../../db/schema/bills";
import { invoices } from "../../db/schema/invoices";
import { parties } from "../../db/schema/parties";
import { accounts } from "../../db/schema/accounts";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../../db/schema/journals";
import { eq, and, or, inArray, lte, asc, sql } from "drizzle-orm";
import { daysPastDue, getBucketIndex } from "../../lib/report-utils";
import { withPermissionOrgContext, withSessionUserContext } from "../../lib/server-context";
import { mappedAccountFamilyIds } from "../../lib/coa/resolve-mapped-account";
import {
  computeBalanceSheet,
  computeProfitLoss,
  computeCashFlow,
  computeTrialBalance,
} from "../../services/reports";
import { getAccessibleGroupEntitiesForGroups } from "../../lib/business-groups/service";
import {
  computeLivePortfolioProfitLoss,
  computeProjectedPortfolioProfitLoss,
  PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING,
} from "../../lib/business-groups/portfolio-profit-loss";
import {
  invalidProjectionAllowlistWarning,
  resolveBusinessGroupReportSource,
} from "../../lib/business-groups/report-source";
import { BusinessGroupAccessError } from "../../lib/enterprise/entitlement-state";

let invalidProjectionAllowlistWarningEmitted = false;

function portfolioReportSource(enterpriseAccountId: string) {
  const resolved = resolveBusinessGroupReportSource({
    configuredSource: process.env.BUSINESS_GROUP_REPORT_SOURCE,
    configuredAccountAllowlist: process.env.BUSINESS_GROUP_PROJECTION_ACCOUNT_ALLOWLIST,
    enterpriseAccountId,
  });
  const warning = invalidProjectionAllowlistWarning(resolved.invalidAllowlistTokenCount);
  if (warning && !invalidProjectionAllowlistWarningEmitted) {
    invalidProjectionAllowlistWarningEmitted = true;
    console.warn(JSON.stringify(warning));
  }
  return resolved.source;
}

export const getBalanceSheet = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("report", "view", async ({ orgId, db }) => {
      const { asOf, compare } = balanceSheetSchema.parse(rawData ?? {});
      return computeBalanceSheet(orgId, asOf, compare, db);
    });
  },
);

export const getProfitLoss = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("report", "view", async ({ orgId, db }) => {
      const { dateFrom, dateTo, compare } = reportPeriodSchema.parse(rawData ?? {});
      return computeProfitLoss(orgId, dateFrom, dateTo, compare, db);
    });
  },
);

/**
 * Enterprise portfolio P&L. The browser identifies an account and its selected
 * groups, while the server derives the authorized subsidiary set. Organization
 * IDs and RLS roles never cross the client trust boundary.
 */
export const getPortfolioProfitLoss = createServerFn({ method: "GET" })
  .validator((data: unknown) => portfolioProfitLossSchema.parse(data))
  .handler(async ({ data: input }) =>
    withSessionUserContext(async ({ db, userId }) => {
      const groupIds = [...new Set(input.groupIds)];
      const groups = await getAccessibleGroupEntitiesForGroups(db, groupIds, userId);
      if (groups[0]?.enterpriseAccountId !== input.enterpriseAccountId) {
        throw new BusinessGroupAccessError("The selected Business Groups are unavailable");
      }

      const source = portfolioReportSource(input.enterpriseAccountId);
      if (source === "projection") {
        return computeProjectedPortfolioProfitLoss(db, groups, input);
      }

      return computeLivePortfolioProfitLoss(groups, {
        userId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        compare: input.compare,
        warnings: source === "shadow" ? [PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING] : undefined,
      });
    }),
  );

export const getCashFlow = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("report", "view", async ({ orgId, db }) => {
      const { dateFrom, dateTo } = reportPeriodSchema.parse(rawData ?? {});
      return computeCashFlow(orgId, dateFrom, dateTo, db);
    });
  },
);

export const getTrialBalance = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("report", "view", async ({ orgId, db }) => {
      const { dateTo } = reportPeriodSchema.parse(rawData ?? {});
      return computeTrialBalance(orgId, dateTo, db);
    });
  },
);

export const getApAging = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("report", "view", async ({ orgId, db }) => {
      const { asOf, buckets } = agingSchema.parse(rawData ?? {});

      // Match the configured A/P account AND everything under it, UNIONed with
      // the subtype predicate. Narrowing to the single mapped account would
      // silently understate payables, since sub-accounts of A/P are payables too.
      const apFamily = await mappedAccountFamilyIds(db, orgId, "bill", "accounts_payable");
      const apAccountPredicate = or(
        eq(accounts.subtype, "accounts_payable"),
        apFamily.length > 0 ? inArray(accounts.id, apFamily) : sql`false`,
      );

      const openBills = await db
        .select({
          id: bills.id,
          vendorId: bills.vendorId,
          vendorName: parties.name,
          billNumber: bills.billNumber,
          dueDate: bills.dueDate,
          balanceDue: sql<string>`
            (COALESCE(SUM(${journalLines.credit}), 0) -
             COALESCE(SUM(${journalLines.debit}), 0))::text
          `,
        })
        .from(bills)
        .leftJoin(parties, eq(bills.vendorId, parties.id))
        .innerJoin(
          journalHeaders,
          and(
            eq(journalHeaders.sourceDocumentId, bills.id),
            eq(journalHeaders.sourceDocumentType, "bill"),
          ),
        )
        .innerJoin(journalLines, eq(journalLines.journalHeaderId, journalHeaders.id))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(
          and(
            eq(bills.organizationId, orgId),
            effectiveJournalPredicate(),
            lte(bills.billDate, asOf),
            lte(journalHeaders.transactionDate, asOf),
            eq(accounts.organizationId, orgId),
            apAccountPredicate,
            sql`(
              ${journalHeaders.status} = 'posted'
              OR (
                ${journalHeaders.status} = 'voided'
                AND ${journalHeaders.voidedAt}::date > ${asOf}::date
              )
            )`,
          ),
        )
        .groupBy(bills.id, parties.name)
        .having(sql`
          ABS(
            COALESCE(SUM(${journalLines.credit}), 0) -
            COALESCE(SUM(${journalLines.debit}), 0)
          ) >= 0.005
        `)
        .orderBy(asc(parties.name));

      const bucketCount = buckets.length + 2;
      const vendorMap = new Map<
        string,
        {
          vendorId: string | null;
          vendorName: string;
          buckets: number[];
          total: number;
        }
      >();

      for (const bill of openBills) {
        const key = bill.vendorId ?? "unknown";
        if (!vendorMap.has(key)) {
          vendorMap.set(key, {
            vendorId: bill.vendorId,
            vendorName: bill.vendorName ?? "Unknown Vendor",
            buckets: Array.from<number>({ length: bucketCount }).fill(0),
            total: 0,
          });
        }

        const vendor = vendorMap.get(key)!;
        // Integer cents (audit PR-15) — the buckets accumulate exactly and
        // are converted to display numbers once, after all sums are done.
        const balanceCents = moneyToCents(bill.balanceDue ?? "0", "balanceDue");
        const days = daysPastDue(bill.dueDate, asOf);
        const idx = getBucketIndex(days, buckets);

        vendor.buckets[idx] += balanceCents;
        vendor.total += balanceCents;
      }

      const vendors = [...vendorMap.values()].sort((a, b) => b.total - a.total);

      const bucketTotals = Array.from<number>({ length: bucketCount }).fill(0);
      let grandTotalCents = 0;
      for (const vendor of vendors) {
        for (let i = 0; i < bucketCount; i++) {
          bucketTotals[i] += vendor.buckets[i];
        }
        grandTotalCents += vendor.total;
        vendor.buckets = vendor.buckets.map((cents) => cents / 100);
        vendor.total /= 100;
      }
      for (let i = 0; i < bucketCount; i++) {
        bucketTotals[i] /= 100;
      }
      const grandTotal = grandTotalCents / 100;

      return {
        asOf,
        type: "ap" as const,
        buckets,
        vendors,
        bucketTotals,
        grandTotal,
        // Without this, an org with no A/P account renders an empty aging
        // report that is indistinguishable from "you owe nobody".
        warnings:
          apFamily.length === 0
            ? ["No Accounts Payable account is configured, so this report may be incomplete."]
            : [],
      };
    });
  },
);

export const getArAging = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("report", "view", async ({ orgId, db }) => {
      const { asOf, buckets } = agingSchema.parse(rawData ?? {});

      // See the A/P note above: union, never narrow.
      const arFamily = await mappedAccountFamilyIds(db, orgId, "invoice", "accounts_receivable");
      const arAccountPredicate = or(
        eq(accounts.subtype, "account_receivable"),
        arFamily.length > 0 ? inArray(accounts.id, arFamily) : sql`false`,
      );

      const openInvoices = await db
        .select({
          id: invoices.id,
          customerId: invoices.customerId,
          customerName: parties.name,
          invoiceNumber: invoices.invoiceNumber,
          dueDate: invoices.dueDate,
          balanceDue: sql<string>`
            (COALESCE(SUM(${journalLines.debit}), 0) -
             COALESCE(SUM(${journalLines.credit}), 0))::text
          `,
        })
        .from(invoices)
        .leftJoin(parties, eq(invoices.customerId, parties.id))
        .innerJoin(
          journalHeaders,
          and(
            eq(journalHeaders.sourceDocumentId, invoices.id),
            eq(journalHeaders.sourceDocumentType, "invoice"),
          ),
        )
        .innerJoin(journalLines, eq(journalLines.journalHeaderId, journalHeaders.id))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(
          and(
            eq(invoices.organizationId, orgId),
            effectiveJournalPredicate(),
            lte(invoices.issueDate, asOf),
            lte(journalHeaders.transactionDate, asOf),
            eq(accounts.organizationId, orgId),
            arAccountPredicate,
            sql`(
              ${journalHeaders.status} = 'posted'
              OR (
                ${journalHeaders.status} = 'voided'
                AND ${journalHeaders.voidedAt}::date > ${asOf}::date
              )
            )`,
          ),
        )
        .groupBy(invoices.id, parties.name)
        .having(sql`
          ABS(
            COALESCE(SUM(${journalLines.debit}), 0) -
            COALESCE(SUM(${journalLines.credit}), 0)
          ) >= 0.005
        `)
        .orderBy(asc(parties.name));

      const bucketCount = buckets.length + 2;
      const customerMap = new Map<
        string,
        {
          customerId: string;
          customerName: string;
          buckets: number[];
          total: number;
        }
      >();

      for (const invoice of openInvoices) {
        const key = invoice.customerId;
        if (!customerMap.has(key)) {
          customerMap.set(key, {
            customerId: invoice.customerId,
            customerName: invoice.customerName ?? "Unknown Customer",
            buckets: Array.from<number>({ length: bucketCount }).fill(0),
            total: 0,
          });
        }

        const customer = customerMap.get(key)!;
        // Integer cents (audit PR-15) — the buckets accumulate exactly and
        // are converted to display numbers once, after all sums are done.
        const balanceCents = moneyToCents(invoice.balanceDue ?? "0", "balanceDue");
        const days = daysPastDue(invoice.dueDate, asOf);
        const idx = getBucketIndex(days, buckets);

        customer.buckets[idx] += balanceCents;
        customer.total += balanceCents;
      }

      const customers = [...customerMap.values()].sort((a, b) => b.total - a.total);

      const bucketTotals = Array.from<number>({ length: bucketCount }).fill(0);
      let grandTotalCents = 0;
      for (const customer of customers) {
        for (let i = 0; i < bucketCount; i++) {
          bucketTotals[i] += customer.buckets[i];
        }
        grandTotalCents += customer.total;
        customer.buckets = customer.buckets.map((cents) => cents / 100);
        customer.total /= 100;
      }
      for (let i = 0; i < bucketCount; i++) {
        bucketTotals[i] /= 100;
      }
      const grandTotal = grandTotalCents / 100;

      // C1 tie-line: credits sitting on the A/R family from NON-invoice
      // journals (prepayments, credit memos, overpayments posted manually).
      // The balance sheet's A/R control includes them; the invoice-driven
      // buckets above cannot. Reporting them per party is what lets
      // aging + unapplied credits tie to the control account at any as-of.
      const unappliedRows = await db
        .select({
          customerId: journalHeaders.partyId,
          customerName: parties.name,
          amount: sql<string>`
            (COALESCE(SUM(${journalLines.credit}), 0) -
             COALESCE(SUM(${journalLines.debit}), 0))::text
          `,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            effectiveJournalPredicate(),
            lte(journalHeaders.transactionDate, asOf),
            eq(accounts.organizationId, orgId),
            arAccountPredicate,
            sql`${journalHeaders.sourceDocumentType} IS DISTINCT FROM 'invoice'`,
            sql`(
              ${journalHeaders.status} = 'posted'
              OR (
                ${journalHeaders.status} = 'voided'
                AND ${journalHeaders.voidedAt}::date > ${asOf}::date
              )
            )`,
          ),
        )
        .groupBy(journalHeaders.partyId, parties.name).having(sql`
          (COALESCE(SUM(${journalLines.credit}), 0) -
           COALESCE(SUM(${journalLines.debit}), 0)) >= 0.005
        `);

      let unappliedCreditsTotalCents = 0;
      const unappliedCredits = unappliedRows.map((row) => {
        const cents = moneyToCents(row.amount ?? "0", "unapplied credit");
        unappliedCreditsTotalCents += cents;
        return {
          customerId: row.customerId,
          customerName: row.customerName ?? "Unassigned",
          amount: cents / 100,
        };
      });

      return {
        asOf,
        type: "ar" as const,
        buckets,
        customers,
        bucketTotals,
        grandTotal,
        unappliedCredits,
        unappliedCreditsTotal: unappliedCreditsTotalCents / 100,
        /** grandTotal − unappliedCreditsTotal ties to the A/R control balance. */
        netReceivable: (grandTotalCents - unappliedCreditsTotalCents) / 100,
        warnings:
          arFamily.length === 0
            ? ["No Accounts Receivable account is configured, so this report may be incomplete."]
            : [],
      };
    });
  },
);
