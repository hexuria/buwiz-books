/**
 * Home dashboard — cash, month-to-date P&L, A/R, A/P, and recent activity.
 * Replaces the old bare redirect to /transactions so the first-run impression is a
 * business overview rather than a raw ledger.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDashboardSummary, type DashboardSummary } from "./api/-dashboard";
import { keys } from "../lib/query-keys";
import { useActiveOrganization } from "../hooks/useActiveOrganization";
import { formatCurrency } from "../utils/format";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { data: activeOrg } = useActiveOrganization();
  const cur = activeOrg?.currency ?? "USD";

  const { data, isLoading } = useQuery({
    queryKey: keys.reports.one("dashboard"),
    queryFn: () => (getDashboardSummary as () => Promise<DashboardSummary>)(),
  });

  return (
    <div className="min-h-full p-6 md:p-8 bg-[#f8fafc] dark:bg-[#0b0e17]">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold text-[#1e293b] dark:text-white mb-1">Overview</h1>
        <p className="text-sm text-[#64748b] dark:text-white/40 mb-6">Your business at a glance</p>

        {isLoading || !data ? (
          <DashboardSkeleton />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <StatCard
                label="Cash on hand"
                value={formatCurrency(data.cash, cur)}
                tone="neutral"
              />
              <StatCard
                label="Net income (MTD)"
                value={formatCurrency(data.mtdNetIncome, cur)}
                tone={data.mtdNetIncome >= 0 ? "positive" : "negative"}
                sub={`${formatCurrency(data.mtdRevenue, cur)} rev · ${formatCurrency(
                  data.mtdExpenses,
                  cur,
                )} exp`}
              />
              <StatCard
                label="Accounts receivable"
                value={formatCurrency(data.arOutstanding, cur)}
                tone="neutral"
                sub={`${data.openInvoiceCount} open invoice${data.openInvoiceCount === 1 ? "" : "s"}`}
                href="/invoices"
              />
              <StatCard
                label="Accounts payable"
                value={formatCurrency(data.apOutstanding, cur)}
                tone="neutral"
                sub={`${data.openBillCount} open bill${data.openBillCount === 1 ? "" : "s"}`}
                href="/bills"
              />
            </div>

            <div className="bg-white dark:bg-[#131826] rounded-xl border border-[#e2e8f0] dark:border-white/8 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#e2e8f0] dark:border-white/8">
                <h2 className="text-sm font-semibold text-[#1e293b] dark:text-white">
                  Recent transactions
                </h2>
                <Link
                  to="/transactions"
                  className="text-xs text-[#10b981] hover:underline font-medium"
                >
                  View all
                </Link>
              </div>
              {data.recentTransactions.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-[#94a3b8] dark:text-white/40">
                  No posted transactions yet.
                </div>
              ) : (
                <ul className="divide-y divide-[#e2e8f0] dark:divide-white/5">
                  {data.recentTransactions.map((t) => (
                    <li key={t.id} className="flex items-center justify-between px-5 py-3">
                      <div className="min-w-0">
                        <p className="text-sm text-[#1e293b] dark:text-white truncate">
                          {t.memo || "—"}
                        </p>
                        <p className="text-xs text-[#94a3b8] dark:text-white/40">
                          {t.date} · {t.type}
                        </p>
                      </div>
                      <span className="text-sm font-medium text-[#1e293b] dark:text-white tabular-nums">
                        {formatCurrency(t.amount, cur)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "neutral" | "positive" | "negative";
  href?: string;
}) {
  const valueColor =
    tone === "positive"
      ? "text-[#10b981]"
      : tone === "negative"
        ? "text-[#ef4444]"
        : "text-[#1e293b] dark:text-white";

  const card = (
    <div className="bg-white dark:bg-[#131826] rounded-xl border border-[#e2e8f0] dark:border-white/8 p-5 h-full transition-shadow hover:shadow-sm">
      <p className="text-xs font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wide">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-[#64748b] dark:text-white/40">{sub}</p>}
    </div>
  );

  return href ? (
    <Link to={href} className="block">
      {card}
    </Link>
  ) : (
    card
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="bg-white dark:bg-[#131826] rounded-xl border border-[#e2e8f0] dark:border-white/8 p-5 animate-pulse"
        >
          <div className="h-3 w-24 rounded bg-[#e2e8f0] dark:bg-white/10 mb-3" />
          <div className="h-7 w-32 rounded bg-[#e2e8f0] dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}
