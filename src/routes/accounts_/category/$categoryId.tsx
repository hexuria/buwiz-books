/**
 * Category Detail Page (Transactions View)
 * Parity with `departments_.$departmentId.tsx` and `entities.banks_.$bankId.tsx`
 * Route: /accounts/category/$categoryId
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";

import { getAccount } from "../../api/-accounts";
import { getAccountTransactionSummary } from "../../api/-accounts";
import { getChildCategoryStats } from "../../api/-accounts";
import { getChildCategoryTimeSeries } from "../../api/-accounts";
import { getCategoryTransactions } from "../../api/-accounts";

import SmartDateFilter from "../../../components/smart-date-filter/SmartDateFilter";
import {
  computePrevRange,
  computeNextRange,
  isPrevDisabled,
  isNextDisabled,
} from "../../../components/smart-date-filter/presets";
import MultiAvatar from "../../../components/transactions/shared/MultiAvatar";
import { CommentThread } from "../../../components/comments/CommentThread";
import { ICON_PATHS } from "../../../components/accounts/icons";
import { formatCurrency } from "@/utils/format";
import {
  EntityDetailLayout,
  EntityDetailLoading,
  EntityDetailNotFound,
  type EntityDetailBack,
} from "../../../components/layouts/EntityDetailLayout";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/accounts_/category/$categoryId")({
  component: CategoryDetailPage,
});

// ============================================================================
// Helpers & Components
// ============================================================================

const formatShortDate = (date: string): string =>
  new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function defaultDateRangeLocal(): { from: string; to: string } {
  const now = new Date();
  const yr = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(yr, now.getMonth() + 1, 0).getDate();
  return {
    from: `${yr}-01-01`,
    to: `${yr}-${m}-${lastDay}`,
  };
}

// ── Area Chart (Indigo Theme for Categories) ──

function CategoryAreaChart({
  monthlyData,
  yearlyData,
  startYear,
  endYear,
}: {
  monthlyData: any[];
  yearlyData: any[];
  startYear: number;
  endYear: number;
}) {
  const [hoveredPoint, setHoveredPoint] = useState<{
    x: number;
    y: number;
    value: number;
    label: string;
  } | null>(null);

  const isMultiYear = endYear > startYear;
  const data = isMultiYear ? yearlyData : monthlyData;

  if (data.length === 0) return null;

  const chartW = 800;
  const chartH = 180;
  const padL = 42;
  const padR = 12;
  const padT = 24; // Increased top padding for tooltip clearance
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const actualMax = Math.max(...data.map((d) => d.value));
  const actualMin = Math.min(...data.map((d) => d.value));
  const range = actualMax - actualMin || 1;

  // Smart Y-axis ticks strictly per user spec: [min, 0, max, 1 bar higher than highest amount]
  const rawStep = range > 0 ? Math.pow(10, Math.floor(Math.log10(range))) : 1000;
  const niceStep = range / rawStep > 5 ? rawStep * 2 : Math.max(rawStep, 100);

  const yTicksArray = [actualMin, 0, actualMax, actualMax + niceStep];
  const yTicks = Array.from(new Set(yTicksArray)).sort((a, b) => a - b);

  const renderMax = yTicks[yTicks.length - 1];
  const renderMin = yTicks[0];
  const renderRange = renderMax - renderMin || 1;
  const renderPadding = renderRange * 0.1;

  const yMax = renderMax + renderPadding;
  const yMin = renderMin < 0 ? renderMin - renderPadding : 0;
  const yRange = yMax - yMin;

  const toX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
  const toY = (val: number) => padT + plotH - ((val - yMin) / yRange) * plotH;

  const labelStep = data.length > 14 ? 3 : data.length > 8 ? 2 : 1;
  const xLabels = data.filter((_, i) => i === 0 || i === data.length - 1 || i % labelStep === 0);

  // Isolate active interactions (skip flat 0 buckets lacking activity)
  const activeData = data.filter((d) => d.value !== 0);
  const pts = activeData.map((d) => ({
    x: toX(data.indexOf(d)),
    y: toY(d.value),
    value: d.value,
    label: d.label,
  }));

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  // The bottom of the chart is padT + plotH. We must anchor the area shading here.
  const chartBottom = padT + plotH;
  const areaPath =
    pts.length > 0
      ? `${linePath} L${pts[pts.length - 1].x},${chartBottom} L${pts[0].x},${chartBottom} Z`
      : "";

  // THEME: Indigo/Purple for Categories (#6366f1 / #4f46e5)
  return (
    <svg
      viewBox={`0 0 ${chartW} ${chartH}`}
      className="w-full"
      preserveAspectRatio="none"
      style={{ height: 180, display: "block", overflow: "visible" }}
    >
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
            {v === 0
              ? "$0"
              : Math.abs(v) >= 1000
                ? `${v < 0 ? "-" : ""}$${(Math.abs(v) / 1000).toFixed(1).replace(/\.0$/, "")}k`
                : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}`}
          </text>
        </g>
      ))}
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
      <defs>
        <linearGradient id="catAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(99, 102, 241, 0.25)" />
          <stop offset="100%" stopColor="rgba(99, 102, 241, 0.02)" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#catAreaGrad)" />
      <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="4"
          fill="#6366f1"
          stroke="white"
          strokeWidth="1.5"
          className="cursor-pointer transition-all hover:r-[6]"
          onMouseEnter={() => setHoveredPoint(p)}
          onMouseLeave={() => setHoveredPoint(null)}
        />
      ))}

      {/* Tooltip Overlay */}
      {hoveredPoint && (
        <g>
          {/* Tooltip Background */}
          <rect
            x={Math.min(Math.max(hoveredPoint.x - 40, 0), chartW - 80)} // keep bounded
            y={hoveredPoint.y - 30}
            width="80"
            height="22"
            fill="#1e293b"
            rx="4"
          />
          {/* Tooltip Text */}
          <text
            x={Math.min(Math.max(hoveredPoint.x, 40), chartW - 40)}
            y={hoveredPoint.y - 15}
            textAnchor="middle"
            fill="white"
            fontSize="10"
            fontWeight="600"
          >
            {`${hoveredPoint.value < 0 ? "-" : ""}$${Math.abs(hoveredPoint.value).toLocaleString()}`}
          </text>
        </g>
      )}
    </svg>
  );
}

// ── Sparkline Component ──

function Sparkline({
  data,
}: {
  data: Array<{ month: number; year: number; value: number; count?: number }>;
}) {
  if (!data || data.length === 0) {
    return (
      <div className="w-24 h-8 flex items-center justify-center">
        <div className="w-full h-0.5 bg-gray-200 dark:bg-slate-700 rounded-full" />
      </div>
    );
  }

  const values = data.map((d) => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;

  // If all values are the same, show a flat line
  if (range === 0) {
    return (
      <div className="w-24 h-8 flex items-center justify-center">
        <div className="w-full h-0.5 bg-gray-300 dark:bg-slate-600 rounded-full" />
      </div>
    );
  }

  const width = 96; // w-24
  const height = 32; // h-8
  const padding = 4;

  const points = data
    .map((d, i) => {
      const x = padding + (i / Math.max(data.length - 1, 1)) * (width - padding * 2);
      const normalizedY = (d.value - min) / range;
      const y = height - padding - normalizedY * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  // Determine color based on overall trend
  const firstValue = values[0];
  const lastValue = values[values.length - 1];
  const isPositiveTrend = lastValue >= firstValue;
  const color = isPositiveTrend ? "#14b8a6" : "#ef4444"; // teal for up, red for down

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-24 h-8">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Nested Category Tree Component ──

type CategoryTreeNode = {
  id: string;
  name: string;
  accountNumber: string | null;
  icon: string | null;
  balance: number;
  transactionCount: number;
  children?: CategoryTreeNode[];
};

function NestedCategoryTree({
  nodes,
  depth = 0,
  timeSeriesData,
}: {
  nodes: CategoryTreeNode[];
  depth?: number;
  timeSeriesData: Record<
    string,
    Array<{ month: number; year: number; value: number; count?: number }>
  >;
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
        const amount = node.balance;
        const isExpanded = expandedIds.has(node.id);
        const hasChildren = (node.children?.length ?? 0) > 0;
        const sparklineData = timeSeriesData[node.id] || [];

        return (
          <div key={node.id}>
            <div className="w-full group flex items-center" style={{ paddingLeft: depth * 20 }}>
              <button
                type="button"
                onClick={() => hasChildren && toggle(node.id)}
                className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors flex-1 min-w-0"
              >
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
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="w-4 h-4 text-slate-400 shrink-0"
                    dangerouslySetInnerHTML={{ __html: ICON_PATHS[node.icon] }}
                  />
                ) : (
                  <div className="w-4 h-4 rounded bg-indigo-100 text-indigo-600 flex items-center justify-center text-[8px] font-bold shrink-0">
                    {node.name.substring(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                    {node.name}
                  </div>
                  {node.accountNumber && (
                    <div className="text-[10px] text-[#94a3b8] font-mono">{node.accountNumber}</div>
                  )}
                </div>
                <Sparkline data={sparklineData} />
                <span className="text-sm font-semibold text-[#1e293b] dark:text-white w-28 text-right shrink-0">
                  {formatCurrency(Math.abs(amount))}
                </span>
                <span className="text-[10px] font-medium text-[#94a3b8] bg-[#f1f5f9] dark:bg-slate-700 px-1.5 py-0.5 rounded-full shrink-0">
                  {node.transactionCount}
                </span>
              </button>
              <Link
                to={`/accounts/category/${node.id}` as string & {}}
                className="p-2 text-[#cbd5e1] hover:text-indigo-400 shrink-0"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </Link>
            </div>
            {hasChildren && isExpanded && (
              <NestedCategoryTree
                nodes={node.children!}
                depth={depth + 1}
                timeSeriesData={timeSeriesData}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Sidebar ──

type SidebarTab = "details" | "comments" | "people";

function CategorySidebar({
  account,
  navigate,
}: {
  account: {
    id: string;
    name: string;
    accountNumber: string | null;
    description: string | null;
    accountType: string;
    isActive?: boolean;
    parent?: { id: string; name: string } | null;
  };
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("details");
  const [copied, setCopied] = useState(false);

  const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/accounts/category/${account.id}`;

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
      {/* Tab bar — Indigo gradient for Categories */}
      <div className="flex justify-evenly bg-gradient-to-r from-[#4338ca] to-[#6366f1] dark:from-[#312e81] dark:to-[#4f46e5] shrink-0 px-4 py-3 gap-2">
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

      <div className="flex-1 overflow-y-auto p-5">
        {activeTab === "details" && (
          <div className="flex flex-col items-center pt-4">
            <div className="w-16 h-16 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-2xl font-bold mb-4">
              {account.name.substring(0, 2).toUpperCase()}
            </div>
            <h2 className="text-base font-semibold text-[#1e293b] dark:text-white text-center">
              {account.name}
            </h2>
            <div className="mt-6 w-full space-y-4 text-left">
              {account.parent && (
                <div>
                  <label className="text-xs text-[#64748b] font-medium block mb-1">
                    Parent Category
                  </label>
                  <button
                    onClick={() => navigate({ to: `/accounts/category/${account.parent!.id}` })}
                    className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                  >
                    {account.parent.name}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M7 17L17 7M17 7H7M17 7V17" />
                    </svg>
                  </button>
                </div>
              )}
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">Type</label>
                <div className="text-sm text-[#1e293b] dark:text-slate-300 capitalize">
                  {account.accountType?.replace("_", " ") || "—"}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">
                  Account Number
                </label>
                <div className="text-sm text-[#1e293b] font-mono bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded inline-block">
                  {account.accountNumber || "—"}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">Description</label>
                <div className="text-sm text-[#1e293b] dark:text-slate-300 leading-relaxed">
                  {account.description || "No description provided."}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">Status</label>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      account.isActive !== false ? "bg-emerald-500" : "bg-slate-300"
                    }`}
                  />
                  <span className="text-sm text-[#1e293b] dark:text-white">
                    {account.isActive !== false ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        {activeTab === "comments" && <CommentThread entityType="category" entityId={account.id} />}
        {activeTab === "people" && (
          <div className="space-y-4">
            <input
              type="text"
              placeholder="Share with..."
              className="w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-base sm:text-sm bg-white dark:bg-slate-800"
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="flex-1 text-base sm:text-xs bg-[#f8fafc] border border-[#e2e8f0] rounded px-2 py-1.5 text-[#94a3b8] truncate"
              />
              <button onClick={handleCopy} className="p-1.5 text-[#94a3b8] hover:text-[#475569]">
                {copied ? "✓" : "Copy"}
              </button>
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

function CategoryDetailPage() {
  const { categoryId } = Route.useParams();
  const navigate = useNavigate();

  // Date range state
  const { from: defaultFrom, to: defaultTo } = defaultDateRangeLocal();
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);

  const [activeTab, setActiveTab] = useState<"transactions" | "subcategories">("transactions");
  const [isMaximized, setIsMaximized] = useState(false);

  const backNav: EntityDetailBack = {
    label: "Back to Categories",
    onClick: () => navigate({ to: `/accounts` as string & {} }),
    hoverClassName: "hover:text-indigo-700 dark:hover:text-indigo-400",
  };

  const handleDateChange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  };

  const startYear = new Date(dateFrom).getFullYear();
  const endYear = new Date(dateTo).getFullYear();
  const selectedYear = endYear;

  // ── Data Fetching ──
  const { data: account, isLoading: accountLoading } = useQuery({
    queryKey: ["category", categoryId],
    queryFn: () => getAccount({ data: { id: categoryId } }),
    enabled: !!categoryId,
  });

  // Reset tab when navigating to a category that has no subcategories
  useEffect(() => {
    if (account && activeTab === "subcategories" && (account.children?.length ?? 0) === 0) {
      setActiveTab("transactions");
    }
  }, [account, activeTab]);

  // Get all child category IDs for filtering (only if this is a root category with no parent)
  const childCategoryIds = useMemo(() => {
    if (account?.parent) return []; // Has a parent, so don't include children
    return account?.children?.map((child: any) => child.id) || [];
  }, [account]);

  const { data: summary } = useQuery({
    queryKey: [
      "accountTransactionSummary",
      categoryId,
      dateFrom,
      dateTo,
      childCategoryIds.length > 0 && !account?.parent,
    ],
    queryFn: () =>
      getAccountTransactionSummary({
        data: {
          id: categoryId,
          dateFrom,
          dateTo,
          includeChildren: childCategoryIds.length > 0 && !account?.parent,
        },
      }),
    enabled: !!categoryId && !!account,
  });

  // Fetch transactions with proper signed amounts
  const { data: transactionsData } = useQuery({
    queryKey: ["categoryTransactions", categoryId, childCategoryIds, dateFrom, dateTo],
    queryFn: async () => {
      return getCategoryTransactions({
        data: {
          categoryId,
          dateFrom,
          dateTo,
          includeChildren: childCategoryIds.length > 0 && !account?.parent,
        },
      });
    },
    enabled: !!categoryId && !!account && activeTab === "transactions",
  });

  // Fetch transaction stats for each child category (only if root category)
  const { data: childStats } = useQuery({
    queryKey: ["childCategoryStats", categoryId, dateFrom, dateTo],
    queryFn: () => getChildCategoryStats({ data: { parentId: categoryId, dateFrom, dateTo } }),
    enabled: childCategoryIds.length > 0 && activeTab === "subcategories" && !account?.parent,
  });

  // Fetch time-series data for sparklines
  const { data: childTimeSeries } = useQuery({
    queryKey: ["childCategoryTimeSeries", categoryId, dateFrom, dateTo],
    queryFn: () => getChildCategoryTimeSeries({ data: { parentId: categoryId, dateFrom, dateTo } }),
    enabled: childCategoryIds.length > 0 && !account?.parent,
  });

  const transactions = useMemo(() => {
    return Array.isArray(transactionsData) ? transactionsData : [];
  }, [transactionsData]);

  // ── Derived Data ──
  const totalAmount = useMemo(() => {
    // Calculate from transactions with proper signs
    return transactions.reduce(
      (sum: number, tx: any) => sum + Number.parseFloat(tx.totalAmount || "0"),
      0,
    );
  }, [transactions]);

  const monthlyData = useMemo(() => {
    if (!summary?.buckets) return [];

    return summary.buckets.map((b: any, index: number) => ({
      index,
      label: b.label,
      value: b.value,
    }));
  }, [summary]);

  const yearlyData = useMemo(() => [], []);

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

  // Build nested tree structure for subcategories
  const categoryTree = useMemo(() => {
    if (!account?.children || !childStats) return [];

    const buildTree = (children: any[]): CategoryTreeNode[] => {
      return children.map((child) => {
        const stats = childStats[child.id] || { count: 0, balance: 0 };
        const node: CategoryTreeNode = {
          id: child.id,
          name: child.name,
          accountNumber: child.accountNumber,
          icon: child.icon,
          balance: stats.balance,
          transactionCount: stats.count,
          children: child.children ? buildTree(child.children) : [],
        };
        return node;
      });
    };

    return buildTree(account.children);
  }, [account, childStats]);

  if (accountLoading) {
    return <EntityDetailLoading back={backNav} message="Loading category..." />;
  }

  if (!account) {
    return (
      <EntityDetailNotFound
        back={backNav}
        title="Category not found"
        action={{ label: "← Back to Accounts", onClick: () => navigate({ to: "/accounts" }) }}
      />
    );
  }

  // ── Render Transaction List ──
  const renderTransactionContent = () => {
    if (transactionsByYear.length === 0) {
      return (
        <div className="text-center py-12">
          <p className="text-sm text-[#94a3b8] dark:text-slate-500">
            No transactions found for this category during the selected period.
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
                const displayParty = tx.partyName || "Unknown Party";

                return (
                  <Link
                    key={tx.lineGroupId || tx.id}
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
                      <div className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-[10px] font-bold">
                        {(tx.createdByName || "U").charAt(0).toUpperCase()}
                      </div>
                    </div>
                    {/* Category */}
                    <div className="col-span-3 flex items-center gap-1.5 min-w-0">
                      <div className="w-1.5 h-1.5 rounded-full bg-[#cbd5e1] shrink-0" />
                      <span className="text-sm text-[#475569] dark:text-slate-300 truncate">
                        {tx.categoryName || "Uncategorized"}
                      </span>
                    </div>
                    {/* Department */}
                    <span className="col-span-2 text-xs text-[#94a3b8] truncate">
                      {tx.departmentName || "—"}
                    </span>
                    {/* Amount */}
                    <div className="col-span-2 flex items-center justify-end gap-1">
                      <span
                        className={`text-sm font-semibold ${
                          Number.parseFloat(tx.totalAmount || "0") < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-[#1e293b] dark:text-white"
                        }`}
                      >
                        {formatCurrency(Number.parseFloat(tx.totalAmount || "0"))}
                      </span>
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
      side={<CategorySidebar account={account} navigate={navigate} />}
      sideTitle="Category details"
    >
      {/* Indigo Gradient Header for Categories */}
      <div className="bg-gradient-to-r from-[#4338ca] to-[#6366f1] dark:from-[#312e81] dark:to-[#4f46e5] px-5 pt-4 pb-4 shrink-0">
        {/* Row 1: Avatar + Name */}
        <div className="flex items-center gap-3 mb-3">
          <MultiAvatar
            size="sm"
            items={[{ initials: account.name.substring(0, 2).toUpperCase() }]}
          />
          <h1 className="text-lg font-bold text-white">{account.name}</h1>
        </div>

        {/* Row 2: Controls */}
        <div className="flex items-center gap-3 h-8 relative">
          {/* LEFT: Date picker */}
          <div className="flex items-center gap-0 bg-white/10 rounded-lg shrink-0 z-10">
            <button
              type="button"
              disabled={isPrevDisabled(dateFrom, dateTo)}
              onClick={() => {
                const prev = computePrevRange(dateFrom, dateTo);
                handleDateChange(prev.from, prev.to);
              }}
              className={`touch-target w-8 h-8 flex items-center justify-center rounded-l-lg transition-colors shrink-0 ${
                isPrevDisabled(dateFrom, dateTo)
                  ? "text-white/20 cursor-not-allowed"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
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

            <SmartDateFilter
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChange={handleDateChange}
              className="h-8 rounded-none border-none bg-transparent text-white/70 hover:text-white hover:bg-white/10 px-2 text-xs font-medium"
            />

            <button
              type="button"
              disabled={isNextDisabled(dateFrom, dateTo)}
              onClick={() => {
                const next = computeNextRange(dateFrom, dateTo);
                handleDateChange(next.from, next.to);
              }}
              className={`touch-target w-8 h-8 flex items-center justify-center rounded-r-lg transition-colors shrink-0 ${
                isNextDisabled(dateFrom, dateTo)
                  ? "text-white/20 cursor-not-allowed"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
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

          {/* RIGHT: Action Buttons */}
          <div className="flex items-center gap-2 shrink-0 z-10 relative">
            <button
              type="button"
              onClick={() => setIsMaximized((p) => !p)}
              className="touch-target w-8 h-8 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            >
              {isMaximized ? (
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

      {/* Summary + Area Chart */}
      <div className="bg-white dark:bg-[#1e293b] border-b border-[#e2e8f0] dark:border-slate-700 transition-all duration-300 overflow-hidden px-5 py-4 max-h-[500px]">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-[#1e293b] dark:text-white">
              {account.name}
            </h2>
            <p className="text-xs text-[#94a3b8]">{selectedYear}</p>
          </div>
          <span className="text-xl font-bold text-[#1e293b] dark:text-white">
            {formatCurrency(totalAmount)}
          </span>
        </div>
        <CategoryAreaChart
          yearlyData={yearlyData}
          monthlyData={monthlyData}
          startYear={startYear}
          endYear={endYear}
        />
      </div>

      {/* Tab Content */}
      <div className="overflow-y-auto flex-1">
        {activeTab === "transactions" && renderTransactionContent()}
        {activeTab === "subcategories" && (account.children?.length ?? 0) > 0 && (
          <div className="p-3">
            <NestedCategoryTree nodes={categoryTree} timeSeriesData={childTimeSeries || {}} />
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <div className="flex items-center px-4 py-2.5 border-t border-[#e2e8f0] dark:border-slate-700 bg-white dark:bg-[#1e293b] shrink-0">
        <div className="flex flex-1 items-center justify-evenly">
          <button
            type="button"
            onClick={() => setActiveTab("transactions")}
            className={`flex items-center gap-2 py-2 px-6 text-sm font-semibold capitalize transition-all rounded-full ${
              activeTab === "transactions"
                ? "bg-indigo-500/10 text-indigo-600"
                : "text-[#94a3b8] hover:text-[#475569] dark:hover:text-slate-300"
            }`}
          >
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
            transactions
          </button>

          {(account.children?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab("subcategories")}
              className={`flex items-center gap-2 py-2 px-6 text-sm font-semibold capitalize transition-all rounded-full ${
                activeTab === "subcategories"
                  ? "bg-indigo-500/10 text-indigo-600"
                  : "text-[#94a3b8] hover:text-[#475569] dark:hover:text-slate-300"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              Sub-categories
            </button>
          )}
        </div>
      </div>
    </EntityDetailLayout>
  );
}
