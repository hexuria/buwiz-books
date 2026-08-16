/**
 * Dashboard summary — KPIs for the home page (cash, A/R, A/P, month-to-date P&L,
 * open counts, recent activity). Read-only, posted-only figures consistent with the
 * financial statements.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withSessionOrgContext } from "../../lib/server-context";
import { aggregateBalances } from "../../services/reports";
import { invoices } from "../../db/schema/invoices";
import { bills } from "../../db/schema/bills";
import { effectiveJournalPredicate, journalHeaders } from "../../db/schema/journals";

export interface DashboardSummary {
  cash: number;
  mtdRevenue: number;
  mtdExpenses: number;
  mtdNetIncome: number;
  arOutstanding: number;
  apOutstanding: number;
  openInvoiceCount: number;
  openBillCount: number;
  recentTransactions: Array<{
    id: string;
    date: string;
    memo: string | null;
    amount: string | null;
    type: string;
  }>;
}

const OPEN_INVOICE_STATUSES = ["sent", "viewed", "overdue", "partial"] as const;
const OPEN_BILL_STATUSES = ["awaiting_payment", "approved", "scheduled", "partial"] as const;

export const getDashboardSummary = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }): Promise<DashboardSummary> => {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    // Cash — sum of bank-account balances as of today (asset normal = debit - credit).
    const asOfRows = await aggregateBalances(orgId, null, today, db);
    let cash = 0;
    for (const r of asOfRows) {
      if (r.subtype === "bank_accounts") {
        cash += Number.parseFloat(r.totalDebit) - Number.parseFloat(r.totalCredit);
      }
    }

    // Month-to-date P&L.
    const mtdRows = await aggregateBalances(orgId, monthStart, today, db);
    let mtdRevenue = 0;
    let mtdExpenses = 0;
    for (const r of mtdRows) {
      const debit = Number.parseFloat(r.totalDebit);
      const credit = Number.parseFloat(r.totalCredit);
      if (r.accountType === "revenue" || r.accountType === "other_income") {
        mtdRevenue += credit - debit;
      } else if (["expense", "cost_of_revenue", "other_expense"].includes(r.accountType)) {
        mtdExpenses += debit - credit;
      }
    }

    // A/R and A/P outstanding (subledger balances due, open statuses only).
    const [ar] = await db
      .select({ total: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)::text` })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, orgId),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
        ),
      );
    const [ap] = await db
      .select({ total: sql<string>`coalesce(sum(${bills.balanceDue}), 0)::text` })
      .from(bills)
      .where(and(eq(bills.organizationId, orgId), inArray(bills.status, [...OPEN_BILL_STATUSES])));

    const [openInv] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, orgId),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
        ),
      );
    const [openBill] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bills)
      .where(and(eq(bills.organizationId, orgId), inArray(bills.status, [...OPEN_BILL_STATUSES])));

    const recent = await db
      .select({
        id: journalHeaders.id,
        date: journalHeaders.transactionDate,
        memo: journalHeaders.memo,
        amount: journalHeaders.totalAmount,
        type: journalHeaders.transactionType,
      })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, orgId),
          eq(journalHeaders.status, "posted"),
          effectiveJournalPredicate(),
        ),
      )
      .orderBy(desc(journalHeaders.transactionDate), desc(journalHeaders.createdAt))
      .limit(6);

    return {
      cash: Math.round(cash * 100) / 100,
      mtdRevenue: Math.round(mtdRevenue * 100) / 100,
      mtdExpenses: Math.round(mtdExpenses * 100) / 100,
      mtdNetIncome: Math.round((mtdRevenue - mtdExpenses) * 100) / 100,
      arOutstanding: Number.parseFloat(ar?.total ?? "0"),
      apOutstanding: Number.parseFloat(ap?.total ?? "0"),
      openInvoiceCount: openInv?.count ?? 0,
      openBillCount: openBill?.count ?? 0,
      recentTransactions: recent.map((r) => ({
        id: r.id,
        date: r.date,
        memo: r.memo,
        amount: r.amount,
        type: r.type,
      })),
    };
  });
});
