/**
 * Location Detail Page
 * High-fidelity page mirroring `entities.$entityType.$partyId.tsx`.
 * Route: /locations/$locationId
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import {
  getLocation,
  getLocationTransactionSummary,
  // getLocationCategories,
} from "./api/-dimensions";
import { listTransactions } from "./api/-transactions";
import SmartDateFilter from "../components/smart-date-filter/SmartDateFilter";
import {
  computePrevRange,
  computeNextRange,
  isPrevDisabled,
  isNextDisabled,
} from "../components/smart-date-filter/presets";

import MultiAvatar from "../components/transactions/shared/MultiAvatar";
import { CommentThread } from "../components/comments/CommentThread";
import {
  EntityDetailLayout,
  EntityDetailLoading,
  EntityDetailNotFound,
  type EntityDetailBack,
} from "../components/layouts/EntityDetailLayout";
import { formatCurrency } from "@/utils/format";
// immport { listParties, createParty } from "./api/-parties";
// import { updateTransactionsBatch } from "./api/-transactions";
// import CategoryTree, { type CategoryNode } from "../components/accounts/CategoryTree";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/locations_/$locationId")({
  component: LocationDetailPage,
});

// ============================================================================
// Helpers & Components (Redefined for stability / parity)
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

// ── Area Chart (Red Theme for Locations) ──
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

function LocationAreaChart({
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

  const max = Math.max(...data.map((d) => d.value), 1);

  // Smart Y-axis ticks
  const yTicks: number[] = [];
  const rawStep = max > 0 ? Math.pow(10, Math.floor(Math.log10(max))) : 1000;
  const niceStep = max / rawStep > 5 ? rawStep * 2 : rawStep;
  const ceilTick = Math.ceil(max / niceStep) * niceStep;
  const yMax = Math.max(ceilTick, max) + niceStep * 0.1;
  for (let v = 0; v <= yMax; v += niceStep) yTicks.push(v);
  if (yTicks.length < 2) yTicks.push(yMax);

  const toX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
  const toY = (val: number) => padT + plotH - (val / yMax) * plotH;

  const labelStep = data.length > 14 ? 3 : data.length > 8 ? 2 : 1;
  const xLabels = data.filter((_, i) => i === 0 || i === data.length - 1 || i % labelStep === 0);

  const pts = data.map((d, i) => ({ x: toX(i), y: toY(d.value) }));
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1].x},${toY(0)} L${pts[0].x},${toY(0)} Z`;

  // THEME: Red for Locations (#dcb262 ?? No, Red: #ef4444)
  // Let's use a nice map-marker Red (#ef4444 / #dc2626)
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
            {v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`}
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
        <linearGradient id="locAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(239, 68, 68, 0.25)" />
          <stop offset="100%" stopColor="rgba(239, 68, 68, 0.02)" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#locAreaGrad)" />
      <path d={linePath} fill="none" stroke="#ef4444" strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="#ef4444" stroke="white" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

// ── Sidebar ──

type SidebarTab = "details" | "comments" | "people";

function LocationSidebar({
  location,
}: {
  location: {
    id: string;
    name: string;
    code?: string | null;
    description?: string | null;
    isActive?: boolean | null;
  };
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("details");
  const [copied, setCopied] = useState(false);

  const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/locations/${location.id}`;

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
      <div className="flex justify-evenly bg-gradient-to-r from-[#b91c1c] to-[#ef4444] dark:from-[#991b1b] dark:to-[#dc2626] shrink-0 px-4 py-3 gap-2">
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
            <div className="w-16 h-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center text-2xl font-bold mb-4">
              {location.name.substring(0, 2).toUpperCase()}
            </div>
            <h2 className="text-base font-semibold text-[#1e293b] dark:text-white text-center">
              {location.name}
            </h2>
            <div className="mt-6 w-full space-y-4 text-left">
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">Code</label>
                <div className="text-sm text-[#1e293b] font-mono bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded inline-block">
                  {location.code || "—"}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">Description</label>
                <div className="text-sm text-[#1e293b] dark:text-slate-300 leading-relaxed">
                  {location.description || "No description provided."}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#64748b] font-medium block mb-1">Status</label>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      location.isActive ? "bg-emerald-500" : "bg-slate-300"
                    }`}
                  />
                  <span className="text-sm text-[#1e293b] dark:text-white">
                    {location.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        {activeTab === "comments" && <CommentThread entityType="location" entityId={location.id} />}
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

function LocationDetailPage() {
  const { locationId } = Route.useParams();

  const { from: defaultFrom, to: defaultTo } = defaultDateRangeLocal();
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);
  const [activeTab, setActiveTab] = useState<"transactions" | "categories">("transactions");
  const [isMaximized, setIsMaximized] = useState(false);

  const backNav: EntityDetailBack = {
    label: "Back to Locations",
    to: "/locations",
    hoverClassName: "hover:text-red-700 dark:hover:text-red-400",
  };

  const handleDateChange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  };

  const startYear = new Date(dateFrom).getFullYear();
  const endYear = new Date(dateTo).getFullYear();
  const selectedYear = endYear;

  // ── Data Fetching ──

  const { data: location, isLoading: locLoading } = useQuery({
    queryKey: ["location", locationId],
    queryFn: () => getLocation({ data: { id: locationId } }),
    enabled: !!locationId,
  });

  const { data: summary } = useQuery({
    queryKey: ["locationTransactionSummary", locationId, selectedYear],
    queryFn: () => getLocationTransactionSummary({ data: { id: locationId, year: selectedYear } }),
    enabled: !!locationId,
  });

  const { data: transactionsData } = useQuery({
    queryKey: ["locationTransactions", locationId, dateFrom, dateTo],
    queryFn: () =>
      listTransactions({ data: { locationIds: [locationId], dateFrom, dateTo, limit: 250 } }),
    enabled: !!locationId && activeTab === "transactions",
  });

  const transactions = useMemo(() => {
    return Array.isArray(transactionsData) ? transactionsData : [];
  }, [transactionsData]);

  // ── Derived Data ──
  const totalAmount = useMemo(() => {
    if (summary) return Number.parseFloat(summary.totalAmount || "0");
    return transactions.reduce(
      (sum: number, tx: any) => sum + Math.abs(Number.parseFloat(tx.totalAmount || "0")),
      0,
    );
  }, [summary, transactions]);

  // Chart Data
  // Chart Data
  const monthlyData = useMemo(() => {
    if (!summary?.months) return [];

    // Filter months based on the selected date range
    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);
    const startMonth = fromDate.getMonth() + 1;
    const endMonth = toDate.getMonth() + 1;

    return summary.months
      .filter((m: any) => m.month >= startMonth && m.month <= endMonth)
      .map((m: any) => ({
        index: m.month,
        label: MONTH_SHORT[m.month - 1],
        value: Number.parseFloat(m.totalAmount),
      }));
  }, [summary, dateFrom, dateTo]);

  const yearlyData = useMemo(() => [], []); // Placeholder

  // Group transactions
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

  /* Removed allTxIds */

  // No activity ranges
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

  if (locLoading) {
    return <EntityDetailLoading back={backNav} message="Loading location..." />;
  }

  if (!location) {
    return (
      <EntityDetailNotFound
        back={backNav}
        title="Location not found"
        action={{
          label: "← Back",
          onClick: () => window.history.back(),
          className: "text-red-600",
        }}
      />
    );
  }

  // ── Render Transaction List ──
  const renderTransactionContent = () => {
    if (transactionsByYear.length === 0) {
      return (
        <div className="text-center py-12">
          <p className="text-sm text-[#94a3b8] dark:text-slate-500">
            No transactions found for this location.
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
                  <span className="col-span-2">Location</span>
                  <span className="text-right col-span-2">Amount</span>
                </div>
              ) : null}

              {/* Transaction rows */}
              {item.transactions.map((tx: any) => {
                const displayParty = tx.partyName || "Unknown Party";

                /* Removed edit block */

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
                      <div className="w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] font-bold">
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
                    {/* Location */}
                    <span className="col-span-2 text-xs text-[#94a3b8] truncate">
                      {tx.locationName || location.name}
                    </span>
                    {/* Amount */}
                    <div className="col-span-2 flex items-center justify-end gap-1">
                      <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                        {formatCurrency(Math.abs(Number.parseFloat(tx.totalAmount || "0")))}
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
      side={<LocationSidebar location={location} />}
      sideTitle="Location details"
    >
      {/* Red Gradient Header */}
      <div className="bg-gradient-to-r from-[#b91c1c] to-[#ef4444] dark:from-[#991b1b] dark:to-[#dc2626] px-5 pt-4 pb-4 shrink-0">
        {/* Row 1: Avatar + Name */}
        <div className="flex items-center gap-3 mb-3">
          <MultiAvatar
            size="sm"
            items={[{ initials: location.name.substring(0, 2).toUpperCase() }]}
          />
          <h1 className="text-lg font-bold text-white">{location.name}</h1>
        </div>

        {/* Row 2: Controls — 3 sections: left (date), center (View/Edit), right (actions) */}
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

          {/* View / Edit toggle removed */}

          {/* RIGHT: Action Buttons + Maximize */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Add Transaction link removed */}
            {/* Save Changes button removed (now in floating bar) */}
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
              {location.name}
            </h2>
            <p className="text-xs text-[#94a3b8]">{selectedYear}</p>
          </div>
          <span className="text-xl font-bold text-[#1e293b] dark:text-white">
            {formatCurrency(totalAmount)}
          </span>
        </div>
        <LocationAreaChart
          yearlyData={yearlyData}
          monthlyData={monthlyData}
          startYear={startYear}
          endYear={endYear}
        />
      </div>

      {/* Tab Content */}
      <div className="overflow-y-auto flex-1">
        {activeTab === "transactions" && renderTransactionContent()}
        {activeTab === "categories" && (
          <div className="p-5">
            <div className="text-center py-12">
              <p className="text-sm text-[#94a3b8] dark:text-slate-500">
                Category breakdown coming soon.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <div className="flex items-center px-4 py-2.5 border-t border-[#e2e8f0] dark:border-slate-700 bg-white dark:bg-[#1e293b] shrink-0">
        <div className="flex flex-1 items-center justify-evenly">
          {(["transactions", "categories"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={activeTab === tab ? { backgroundColor: "rgba(239, 68, 68, 0.12)" } : undefined}
              className={`flex items-center gap-2 py-2 px-6 text-sm font-semibold capitalize transition-all rounded-full ${
                activeTab === tab
                  ? "text-red-600"
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
      </div>
    </EntityDetailLayout>
  );
}
