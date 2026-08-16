/**
 * Entity Detail Page
 * entity page with area chart, year-grouped transactions, and sidebar.
 * Route: /entities/$entityType/$partyId
 * Layout mirrors CategoryManagerLayout: navbar → two-panel (main card + sidebar).
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { getParty, getPartyTransactionSummary, getPartyCategories } from "./api/-parties";
import { listTransactions } from "./api/-transactions";
import SmartDateFilter from "../components/smart-date-filter/SmartDateFilter";
import {
  computePrevRange,
  computeNextRange,
  isPrevDisabled,
  isNextDisabled,
} from "../components/smart-date-filter/presets";

import { ICON_PATHS } from "../components/accounts/icons";

import MultiAvatar from "../components/transactions/shared/MultiAvatar";
import { CommentThread } from "../components/comments/CommentThread";
import { formatCurrency } from "@/utils/format";
import {
  EntityDetailLayout,
  EntityDetailLoading,
  EntityDetailNotFound,
  type EntityDetailBack,
} from "../components/layouts/EntityDetailLayout";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/entities/$entityType/$partyId")({
  component: EntityDetailPage,
});

// Entity type → listing route plural
const ENTITY_PLURAL: Record<string, string> = {
  customer: "customers",
  vendor: "vendors",
  employee: "employees",
  bank: "banks",
  shareholder: "shareholders",
  lender: "lenders",
  government: "government",
};

// ============================================================================
// Helpers
// ============================================================================

const formatShortDate = (date: string): string =>
  new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function defaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const yr = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(yr, now.getMonth() + 1, 0).getDate();
  return {
    from: `${yr}-01-01`,
    to: `${yr}-${m}-${lastDay}`,
  };
}

// ============================================================================
// Area Chart Component — adaptive yearly / monthly view
// ============================================================================

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

interface ChartDataPoint {
  index: number;
  label: string;
  value: number;
}

function EntityAreaChart({
  yearlyData,
  monthlyData,
  startYear,
  endYear,
}: {
  yearlyData: ChartDataPoint[];
  monthlyData: ChartDataPoint[];
  startYear: number;
  endYear: number;
}) {
  const isMultiYear = endYear > startYear;
  const data = isMultiYear ? yearlyData : monthlyData;

  if (data.length === 0) return null;

  const chartW = 800;
  const chartH = 180;
  const padL = 42;
  const padR = 12;
  const padT = 8;
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const numSlots = data.length - 1;
  const max = Math.max(...data.map((d) => d.value), 1);

  // Smart Y-axis ticks — ensure yMax always covers the actual data max
  const yTicks: number[] = [];
  const rawStep = max > 0 ? Math.pow(10, Math.floor(Math.log10(max))) : 1000;
  // Choose a nice step: if max/rawStep > 5, double the step
  const niceStep = max / rawStep > 5 ? rawStep * 2 : rawStep;
  // Compute the ceiling tick that fully contains the max value
  const ceilTick = Math.ceil(max / niceStep) * niceStep;
  // Add 10% padding above the highest data point for visual breathing room
  const yMax = Math.max(ceilTick, max) + niceStep * 0.1;
  for (let v = 0; v <= yMax; v += niceStep) yTicks.push(v);
  // Ensure we have at least 2 ticks
  if (yTicks.length < 2) yTicks.push(yMax);

  const toX = (i: number) => padL + (numSlots > 0 ? (i / numSlots) * plotW : plotW / 2);
  const toY = (val: number) => padT + plotH - (val / yMax) * plotH;

  // X-axis labels — skip if too many
  const labelStep = data.length > 14 ? 3 : data.length > 8 ? 2 : 1;
  const xLabels = data.filter((_, i) => i === 0 || i === data.length - 1 || i % labelStep === 0);

  // Build line points
  const pts = data.map((d, i) => ({ x: toX(i), y: toY(d.value) }));

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1].x},${toY(0)} L${pts[0].x},${toY(0)} Z`;

  return (
    <svg
      viewBox={`0 0 ${chartW} ${chartH}`}
      className="w-full"
      preserveAspectRatio="none"
      style={{ height: 180, display: "block", overflow: "visible" }}
    >
      {/* Grid lines */}
      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={padL}
            y1={toY(v)}
            x2={chartW - padR}
            y2={toY(v)}
            stroke="#e2e8f0"
            strokeWidth="0.5"
            strokeDasharray={v === 0 ? "0" : "3,3"}
          />
          <text
            x={padL - 6}
            y={toY(v) + 3}
            textAnchor="end"
            fontSize="9"
            fill="#94a3b8"
            fontWeight="500"
          >
            {v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`}
          </text>
        </g>
      ))}

      {/* X-axis labels */}
      {xLabels.map((d) => (
        <text
          key={d.index}
          x={toX(data.indexOf(d))}
          y={chartH - 4}
          textAnchor="middle"
          fontSize="9"
          fill="#94a3b8"
          fontWeight="500"
        >
          {d.label}
        </text>
      ))}

      {/* Area fill */}
      <path d={areaPath} fill="url(#areaGrad)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="#27ae60" strokeWidth="2" strokeLinejoin="round" />

      {/* Data points */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="#27ae60" stroke="white" strokeWidth="1.5" />
      ))}

      {/* Gradient definition */}
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(39,174,96,0.25)" />
          <stop offset="100%" stopColor="rgba(39,174,96,0.02)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ============================================================================
// Category Tree Component
// ============================================================================

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

function CategoryTree({
  nodes,
  depth = 0,
  maxAmount,
}: {
  nodes: CategoryNode[];
  depth?: number;
  maxAmount: number;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(nodes.map((n) => n.id)),
  );

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const amount = Number.parseFloat(node.totalAmount);
        const barPct = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;
        const isExpanded = expandedIds.has(node.id);
        const hasChildren = node.children.length > 0;

        return (
          <div key={node.id}>
            <button
              type="button"
              onClick={() => hasChildren && toggle(node.id)}
              className="w-full group"
              style={{ paddingLeft: depth * 20 }}
            >
              <div className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors">
                <span className="w-4 text-[#94a3b8] shrink-0">
                  {hasChildren ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    >
                      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#cbd5e1] dark:bg-slate-600" />
                  )}
                </span>
                {node.icon && ICON_PATHS[node.icon] ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="w-4 h-4 text-slate-400 shrink-0"
                    dangerouslySetInnerHTML={{ __html: ICON_PATHS[node.icon] }}
                  />
                ) : (
                  <span className="text-sm">📁</span>
                )}
                <span className="text-sm font-medium text-[#1e293b] dark:text-white flex-1 text-left truncate">
                  {node.name}
                </span>
                <div className="w-24 h-2 bg-[#f1f5f9] dark:bg-slate-700 rounded-full overflow-hidden shrink-0">
                  <div
                    className="h-full bg-[#14b8a6] rounded-full transition-all"
                    style={{ width: `${Math.max(barPct, 2)}%` }}
                  />
                </div>
                <span className="text-sm font-semibold text-[#1e293b] dark:text-white w-28 text-right shrink-0">
                  {formatCurrency(amount)}
                </span>
                <span className="text-[10px] font-medium text-[#94a3b8] bg-[#f1f5f9] dark:bg-slate-700 px-1.5 py-0.5 rounded-full shrink-0">
                  {node.transactionCount}
                </span>
              </div>
            </button>
            {hasChildren && isExpanded && (
              <CategoryTree nodes={node.children} depth={depth + 1} maxAmount={maxAmount} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Sidebar (3-tab: Details / Comments / People)
// ============================================================================

type SidebarTab = "details" | "comments" | "people";

function EntitySidebar({
  party,
}: {
  party: { id: string; name: string; partyType: string; logoUrl?: string | null };
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("details");
  const [copied, setCopied] = useState(false);

  const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/entities/${party.partyType}/${party.id}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tabs: { key: SidebarTab; icon: React.ReactNode }[] = [
    {
      key: "details",
      icon: (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <line x1="8" y1="6" x2="16" y2="6" />
          <line x1="8" y1="10" x2="16" y2="10" />
          <line x1="8" y1="14" x2="12" y2="14" />
        </svg>
      ),
    },
    {
      key: "comments",
      icon: (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
    {
      key: "people",
      icon: (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" y1="8" x2="19" y2="14" />
          <line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      ),
    },
  ];

  return (
    <div className="w-full bg-white dark:bg-[#1e293b] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] flex flex-col h-full overflow-hidden">
      {/* Tab bar — gradient matches main card header */}
      <div className="flex justify-evenly bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] shrink-0 px-4 py-3 gap-2">
        {tabs.map(({ key, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors ${
              activeTab === key
                ? "bg-white/20 text-white"
                : "text-white/50 hover:text-white hover:bg-white/10"
            }`}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-5">
        {activeTab === "details" && (
          <div className="flex flex-col items-center pt-4">
            {party.logoUrl ? (
              <img
                src={party.logoUrl}
                alt={party.name}
                className="w-16 h-16 rounded-full object-cover mb-4"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-[#d35400] text-white flex items-center justify-center text-2xl font-bold mb-4">
                {party.name.charAt(0).toUpperCase()}
              </div>
            )}
            <a
              href={`/entities/${ENTITY_PLURAL[party.partyType] || `${party.partyType}s`}?selected=${party.id}`}
              className="text-base font-semibold text-[#1e293b] dark:text-white hover:text-[var(--color-app-header-teal)] transition-colors cursor-pointer"
            >
              {party.name}
            </a>
          </div>
        )}

        {activeTab === "comments" && (
          <CommentThread entityType={party.partyType} entityId={party.id} />
        )}

        {activeTab === "people" && (
          <div className="space-y-4">
            <div className="relative">
              <input
                type="text"
                placeholder="Enter name or email..."
                className="w-full rounded-lg border border-[#e2e8f0] dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-base sm:text-sm text-[#1e293b] dark:text-white placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[var(--color-app-header-teal)] focus:border-transparent"
              />
            </div>

            <div>
              <p className="text-[11px] font-semibold text-[#475569] dark:text-slate-400 uppercase tracking-wide mb-2">
                Shared with
              </p>
              <div className="flex items-center gap-3 py-2">
                <div className="w-8 h-8 rounded-full bg-[#64748b] flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none">
                    <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z" />
                  </svg>
                </div>
                <span className="text-sm text-[#1e293b] dark:text-white flex-1 truncate">
                  Organization admins
                </span>
                <span className="text-xs text-[#94a3b8]">Full access</span>
              </div>
            </div>

            <div className="border-t border-[#e2e8f0] dark:border-slate-700 pt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#94a3b8"
                    strokeWidth="2"
                  >
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <span className="text-sm font-medium text-[#1e293b] dark:text-white">
                    Get link
                  </span>
                </div>
                <span className="text-xs text-[#94a3b8]">Disabled</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  className="flex-1 text-base sm:text-xs bg-[#f8fafc] dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded px-2 py-1.5 text-[#94a3b8] truncate"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="shrink-0 p-1.5 text-[#94a3b8] hover:text-[#475569] transition-colors"
                >
                  {copied ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

function EntityDetailPage() {
  const { entityType, partyId } = Route.useParams();
  const navigate = useNavigate();

  // Date range state — driven by SmartDateFilter
  const { from: defaultFrom, to: defaultTo } = defaultDateRange();
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);
  const [activeTab, setActiveTab] = useState<"transactions" | "categories">("transactions");
  const [isMaximized, setIsMaximized] = useState(false);

  const backNav: EntityDetailBack = {
    label: "Back to Ledger",
    to: "/",
    hoverClassName: "hover:text-teal-700 dark:hover:text-teal-400",
  };

  const handleDateChange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  };

  // Derive year values from the date range
  const startYear = new Date(dateFrom).getFullYear();
  const endYear = new Date(dateTo).getFullYear();
  const selectedYear = endYear; // Use end-year for summary queries

  // ── Data Fetching ──
  const { data: party, isLoading: partyLoading } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => getParty({ data: { id: partyId } }),
    enabled: !!partyId,
  });

  const { data: summary } = useQuery({
    queryKey: ["partyTransactionSummary", partyId, selectedYear],
    queryFn: () => getPartyTransactionSummary({ data: { partyId, year: selectedYear } }),
    enabled: !!partyId,
  });

  const { data: categories } = useQuery({
    queryKey: ["partyCategories", partyId, selectedYear],
    queryFn: () => getPartyCategories({ data: { partyId, year: selectedYear } }),
    enabled: !!partyId && activeTab === "categories",
  });

  const { data: transactionsData } = useQuery({
    queryKey: ["partyTransactions", partyId, dateFrom, dateTo],
    queryFn: () => listTransactions({ data: { partyId, dateFrom, dateTo, limit: 250 } }),
    enabled: !!partyId && activeTab === "transactions",
  });

  const transactions = useMemo(() => {
    return Array.isArray(transactionsData) ? transactionsData : [];
  }, [transactionsData]);

  // ── Combo Data Fetching (Removed) ──

  // ── Derived Data ──

  const totalAmount = useMemo(() => {
    if (summary) return Number.parseFloat(summary.totalAmount || "0");
    return transactions.reduce(
      (sum: number, tx: any) => sum + Math.abs(Number.parseFloat(tx.totalAmount || "0")),
      0,
    );
  }, [summary, transactions]);

  // Cumulative yearly totals for area chart
  const yearlyChartData = useMemo((): ChartDataPoint[] => {
    const yearTotals: Record<number, number> = {};
    for (const tx of transactions) {
      const txDate = tx.transactionDate || tx.createdAt;
      const yr = new Date(txDate).getFullYear();
      yearTotals[yr] = (yearTotals[yr] || 0) + Math.abs(Number.parseFloat(tx.totalAmount || "0"));
    }

    let cumulative = 0;
    const data: ChartDataPoint[] = [];
    for (let yr = startYear; yr <= endYear; yr++) {
      cumulative += yearTotals[yr] || 0;
      data.push({ index: yr, label: String(yr), value: cumulative });
    }
    return data;
  }, [transactions, startYear, endYear]);

  // Monthly totals for single-year view
  const monthlyChartData = useMemo((): ChartDataPoint[] => {
    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);
    const startMonth = fromDate.getMonth();
    const endMonth = toDate.getMonth();

    const monthTotals: Record<number, number> = {};
    for (const tx of transactions) {
      const txDate = tx.transactionDate || tx.createdAt;
      const d = new Date(txDate);
      if (d.getFullYear() >= startYear && d.getFullYear() <= endYear) {
        const m = d.getMonth();
        monthTotals[m] = (monthTotals[m] || 0) + Math.abs(Number.parseFloat(tx.totalAmount || "0"));
      }
    }

    let cumulative = 0;
    const data: ChartDataPoint[] = [];
    for (let m = startMonth; m <= endMonth; m++) {
      cumulative += monthTotals[m] || 0;
      data.push({ index: m, label: MONTH_SHORT[m], value: cumulative });
    }
    return data;
  }, [transactions, dateFrom, dateTo, startYear, endYear]);

  // Group transactions by year (descending)
  const transactionsByYear = useMemo(() => {
    const groups: Record<number, { transactions: any[]; total: number }> = {};
    for (const tx of transactions) {
      const txDate = tx.transactionDate || tx.createdAt;
      const yr = new Date(txDate).getFullYear();
      if (!groups[yr]) groups[yr] = { transactions: [], total: 0 };
      groups[yr].transactions.push(tx);
      groups[yr].total += Math.abs(Number.parseFloat(tx.totalAmount || "0"));
    }
    return Object.entries(groups)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([year, data]) => ({
        year: Number(year),
        ...data,
      }));
  }, [transactions]);

  // Find "no activity" year ranges between groups
  const noActivityRanges = useMemo(() => {
    const activeYears = new Set(transactionsByYear.map((g) => g.year));
    const ranges: { from: number; to: number; count: number }[] = [];
    let rangeStart: number | null = null;
    for (let yr = endYear; yr >= startYear; yr--) {
      if (!activeYears.has(yr)) {
        if (rangeStart === null) rangeStart = yr;
      } else {
        if (rangeStart !== null) {
          ranges.push({
            from: yr + 1,
            to: rangeStart,
            count: rangeStart - yr,
          });
          rangeStart = null;
        }
      }
    }
    if (rangeStart !== null) {
      ranges.push({
        from: startYear,
        to: rangeStart,
        count: rangeStart - startYear + 1,
      });
    }
    return ranges;
  }, [transactionsByYear, startYear, endYear]);

  const maxCategoryAmount = useMemo(() => {
    if (!categories) return 0;
    return Math.max(
      ...(categories as CategoryNode[]).map((c) => Number.parseFloat(c.totalAmount)),
      1,
    );
  }, [categories]);

  // ── Loading state ──
  if (partyLoading) {
    return <EntityDetailLoading back={backNav} message="Loading entity…" />;
  }

  if (!party) {
    return (
      <EntityDetailNotFound
        back={backNav}
        title="Entity not found"
        action={{
          label: `← Back to ${entityType}`,
          onClick: () => navigate({ to: `/entities/${entityType}` as string & {} }),
          className: "text-[var(--color-app-header-teal)]",
        }}
      />
    );
  }

  // ── Build interleaved list of year groups + no-activity bars ──
  const renderTransactionContent = () => {
    if (transactionsByYear.length === 0) {
      return (
        <div className="text-center py-12">
          <p className="text-sm text-[#94a3b8] dark:text-slate-500">
            No transactions found for this entity.
          </p>
        </div>
      );
    }

    type ListItem =
      | { type: "group"; year: number; transactions: any[]; total: number }
      | { type: "noActivity"; from: number; to: number; count: number };

    const items: ListItem[] = [
      ...transactionsByYear.map((g) => ({ type: "group" as const, ...g })),
      ...noActivityRanges.map((r) => ({ type: "noActivity" as const, ...r })),
    ];
    items.sort((a, b) => {
      const aYear = a.type === "group" ? a.year : a.to;
      const bYear = b.type === "group" ? b.year : b.to;
      return bYear - aYear;
    });

    return (
      <div>
        {items.map((item, idx) => {
          if (item.type === "noActivity") {
            return (
              <div
                key={`na-${item.from}-${item.to}`}
                className="flex items-center justify-between px-5 py-3 bg-[#f1f5f9] dark:bg-slate-800/50"
              >
                <span className="text-sm font-bold text-[#475569] dark:text-slate-400">
                  {item.from === item.to ? item.from : `${item.to} - ${item.from}`}
                </span>
                <span className="text-xs font-medium text-[#94a3b8] uppercase tracking-wide">
                  No activity for {item.count} year{item.count !== 1 ? "s" : ""}
                </span>
              </div>
            );
          }

          return (
            <div key={item.year}>
              {/* Year header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-[#f1f5f9] dark:border-slate-800">
                <span className="text-base font-bold text-[#1e293b] dark:text-white">
                  {item.year}
                </span>
                <div className="text-right">
                  <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                    {formatCurrency(item.total)}
                  </span>
                  <p className="text-[11px] text-[#94a3b8]">
                    {item.transactions.length} Transaction
                    {item.transactions.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>

              {/* Column headers */}
              {idx === 0 || items[idx - 1]?.type === "noActivity" ? (
                <div className="grid grid-cols-12 gap-2 px-5 py-2 text-[11px] font-medium text-[#94a3b8] uppercase tracking-wide border-b border-[#f1f5f9] dark:border-slate-800">
                  <span className="col-span-1">Date</span>
                  <span className="col-span-3">Party</span>
                  <span className="col-span-1">Source</span>
                  <span className="col-span-3">Category</span>
                  <span className="col-span-2">Department</span>
                  <span className="text-right col-span-2">Amount</span>
                </div>
              ) : null}

              {/* Transaction rows */}
              {item.transactions.map((tx: any) => {
                const displayParty = tx.partyName ?? party.name;
                const displayCategory = tx.categoryName ?? "Uncategorized";

                return (
                  <Link
                    key={tx.id}
                    to={`/transactions/${tx.id}` as string & {}}
                    className="grid grid-cols-12 gap-2 items-center px-5 py-3 hover:bg-[#f8fafc] dark:hover:bg-slate-800/50 transition-colors no-underline border-b border-[#f8fafc] dark:border-slate-800/30 group"
                  >
                    {/* Date */}
                    <span className="col-span-1 text-xs text-[#64748b] dark:text-slate-400">
                      {formatShortDate(tx.transactionDate || tx.createdAt)}
                    </span>
                    {/* Party */}
                    <div className="col-span-3 flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-full bg-[#d35400] text-white flex items-center justify-center text-xs font-bold shrink-0">
                        {displayParty.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                          {displayParty}
                        </p>
                        <p className="text-[10px] text-[#94a3b8] truncate">
                          {tx.description || tx.memo || ""}
                        </p>
                      </div>
                    </div>
                    {/* Source */}
                    <div className="col-span-1 flex items-center">
                      <div className="w-6 h-6 rounded-full bg-[var(--color-app-header-teal)] text-white flex items-center justify-center text-[10px] font-bold">
                        {(tx.createdByName || "U").charAt(0).toUpperCase()}
                      </div>
                    </div>
                    {/* Category */}
                    <div className="col-span-3 flex items-center gap-1.5 min-w-0">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth="1.5"
                        className="shrink-0"
                      >
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
                        <line x1="7" y1="7" x2="7.01" y2="7" />
                      </svg>
                      <span className="text-sm text-[#475569] dark:text-slate-300 truncate">
                        {displayCategory}
                      </span>
                    </div>
                    {/* Department */}
                    <span className="col-span-2 text-xs text-[#94a3b8] truncate">
                      {tx.departmentName || ""}
                    </span>
                    {/* Amount */}
                    <div className="col-span-2 flex items-center justify-end gap-1">
                      <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                        {formatCurrency(Math.abs(Number.parseFloat(tx.totalAmount || "0")))}
                      </span>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#cbd5e1"
                        strokeWidth="2"
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <EntityDetailLayout
      back={backNav}
      isMaximized={isMaximized}
      side={
        <EntitySidebar
          party={{
            id: party.id,
            name: party.name,
            partyType: party.partyType,
            logoUrl: party.logoUrl,
          }}
        />
      }
      sideTitle="Entity details"
    >
      {/* Blue Gradient Header */}
      <div className="bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] px-5 pt-4 pb-4 shrink-0">
        {/* Row 1: Avatar + Name */}
        <div className="flex items-center gap-3 mb-3">
          <MultiAvatar
            size="sm"
            items={
              party.name
                ? [
                    {
                      initials: (() => {
                        const words = party.name.trim().split(/\s+/);
                        if (words.length === 0) return null;
                        if (words.length === 1) return words[0].charAt(0).toUpperCase();
                        return (
                          words[0].charAt(0) + words[words.length - 1].charAt(0)
                        ).toUpperCase();
                      })(),
                    },
                  ]
                : []
            }
          />
          <h1 className="text-lg font-bold text-white">{party.name}</h1>
        </div>

        {/* Row 2: Controls — 3 sections: left (date), spacer, right (maximize) */}
        <div className="flex items-center gap-3">
          {/* LEFT: Date picker with < > arrows — rounded rectangle */}
          <div className="flex items-center gap-0 bg-white/10 rounded-lg">
            {/* Prev arrow */}
            <button
              type="button"
              disabled={isPrevDisabled(dateFrom, dateTo)}
              onClick={() => {
                if (!isPrevDisabled(dateFrom, dateTo)) {
                  const prev = computePrevRange(dateFrom, dateTo);
                  handleDateChange(prev.from, prev.to);
                }
              }}
              className={`touch-target w-8 h-8 flex items-center justify-center rounded-l-lg transition-colors shrink-0 ${isPrevDisabled(dateFrom, dateTo) ? "text-white/20 cursor-not-allowed" : "text-white/70 hover:text-white hover:bg-white/10"}`}
              title="Previous period"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>

            {/* SmartDateFilter — flat style, white text + icons */}
            <SmartDateFilter
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChange={handleDateChange}
              className="h-8 rounded-none border-none bg-transparent text-white/70 hover:text-white hover:bg-white/10 px-2 text-xs font-medium"
            />

            {/* Next arrow */}
            <button
              type="button"
              disabled={isNextDisabled(dateFrom, dateTo)}
              onClick={() => {
                if (!isNextDisabled(dateFrom, dateTo)) {
                  const next = computeNextRange(dateFrom, dateTo);
                  handleDateChange(next.from, next.to);
                }
              }}
              className={`touch-target w-8 h-8 flex items-center justify-center rounded-r-lg transition-colors shrink-0 ${isNextDisabled(dateFrom, dateTo) ? "text-white/20 cursor-not-allowed" : "text-white/70 hover:text-white hover:bg-white/10"}`}
              title="Next period"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>

          {/* SPACER */}
          <div className="flex-1" />

          {/* RIGHT: Maximize/Minimize */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Maximize / Minimize toggle */}
            <button
              type="button"
              onClick={() => setIsMaximized((p) => !p)}
              className="touch-target w-8 h-8 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              title={isMaximized ? "Minimize" : "Maximize"}
            >
              {isMaximized ? (
                /* Minimize icon — inward-pointing arrows */
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 14h6v6" />
                  <path d="M20 10h-6V4" />
                  <path d="M14 10l7-7" />
                  <path d="M3 21l7-7" />
                </svg>
              ) : (
                /* Maximize icon — same as LedgerHeader */
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Summary + Area Chart (hidden in Edit mode) */}
      <div className="bg-white dark:bg-[#1e293b] border-b border-[#e2e8f0] dark:border-slate-700 transition-all duration-300 overflow-hidden max-h-[500px] px-5 py-4">
        {/* Summary row */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-[#1e293b] dark:text-white">{party.name}</h2>
            <p className="text-xs text-[#94a3b8]">{selectedYear}</p>
          </div>
          <span className="text-xl font-bold text-[#1e293b] dark:text-white">
            {formatCurrency(totalAmount)}
          </span>
        </div>

        {/* Area chart */}
        <EntityAreaChart
          yearlyData={yearlyChartData}
          monthlyData={monthlyChartData}
          startYear={startYear}
          endYear={endYear}
        />
      </div>

      {/* Tab content — scrollable */}
      <div className="overflow-y-auto flex-1">
        {activeTab === "transactions" && renderTransactionContent()}

        {activeTab === "categories" && (
          <div className="p-5">
            {!categories || (categories as CategoryNode[]).length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-[#94a3b8] dark:text-slate-500">
                  No category data for this entity in {selectedYear}.
                </p>
              </div>
            ) : (
              <CategoryTree nodes={categories as CategoryNode[]} maxAmount={maxCategoryAmount} />
            )}
          </div>
        )}
      </div>

      {/* Tab bar — bottom, pill-shaped active indicator, evenly justified */}
      <div className="flex items-center px-4 py-2.5 border-t border-[#e2e8f0] dark:border-slate-700 bg-white dark:bg-[#1e293b] shrink-0">
        <div className="flex flex-1 items-center justify-evenly">
          {(["transactions", "categories"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={activeTab === tab ? { backgroundColor: "rgba(13,148,136,0.12)" } : undefined}
              className={`flex items-center gap-2 py-2 px-6 text-sm font-semibold capitalize transition-all rounded-full ${
                activeTab === tab
                  ? "text-[#0d9488]"
                  : "text-[#94a3b8] hover:text-[#475569] dark:hover:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-800"
              }`}
            >
              {tab === "transactions" ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
                  <line x1="7" y1="7" x2="7.01" y2="7" />
                </svg>
              )}
              {tab}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            className="text-[#94a3b8] hover:text-[#475569] transition-colors p-1.5 rounded-md hover:bg-[#f1f5f9]"
            title="Filter"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
          </button>
          <button
            type="button"
            className="text-[#94a3b8] hover:text-[#475569] transition-colors p-1.5 rounded-md hover:bg-[#f1f5f9]"
            title="Sort"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
          </button>
        </div>
      </div>
    </EntityDetailLayout>
  );
}
