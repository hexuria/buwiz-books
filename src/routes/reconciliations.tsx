/**
 * Reconciliation Page — reconciliation overview
 * Green gradient header with SmartDateFilter, summary stat tiles,
 * List view: collapsible table grouped by bank account with 12-month columns
 * Timeline view: interactive timeline with hover-to-add context menu
 */
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState, useMemo, useRef, useEffect } from "react";
import { useSession } from "../lib/auth-client";
import { useSidebar } from "../components/SidebarContext";
import SmartDateFilter from "../components/smart-date-filter/SmartDateFilter";
import {
  computePrevRange,
  computeNextRange,
  isPrevDisabled,
  isNextDisabled,
} from "../components/smart-date-filter/presets";
import {
  listReconciliations,
  getReconciliationTimeline,
  createReconciliation,
  getReconciliationReportData,
} from "./api/-reconciliations";
import type { TimelineEntry } from "./api/-reconciliations";
import { Modal } from "../components/ui/Modal";
import { generateReconciliationPDF } from "../lib/generate-reconciliation-pdf";
import type { ReconciliationReportData } from "../lib/generate-reconciliation-pdf";
import { createLogger } from "../lib/logger";
const logger = createLogger("ui.reconciliations");

// ── Server function caller type ──
type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

// ── Modal state type ──
interface StartManuallyModalData {
  bankAccountId: string;
  bankAccountName: string;
  bankAccountNumber: string | null;
  month: number;
  year: number;
}

// ============================================================================
// Route
// ============================================================================

interface ReconciliationsSearch {
  dateFrom?: string;
  dateTo?: string;
}

export const Route = createFileRoute("/reconciliations")({
  component: ReconciliationsPage,
  validateSearch: (search: Record<string, unknown>): ReconciliationsSearch => ({
    dateFrom: (search.dateFrom as string) || undefined,
    dateTo: (search.dateTo as string) || undefined,
  }),
});

// ============================================================================
// Constants
// ============================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const STATUS_DOT: Record<string, { bg: string; ring: string; fill: string }> = {
  finalized: {
    bg: "bg-emerald-500",
    ring: "ring-emerald-500/30",
    fill: "#10b981",
  },
  in_progress: {
    bg: "bg-amber-500",
    ring: "ring-amber-500/30",
    fill: "#f59e0b",
  },
  draft: { bg: "bg-blue-500", ring: "ring-blue-500/30", fill: "#3b82f6" },
  not_started: {
    bg: "bg-gray-300 dark:bg-white/20",
    ring: "ring-gray-300/30 dark:ring-white/10",
    fill: "#9ca3af",
  },
  no_activity: {
    bg: "bg-gray-200 dark:bg-white/10",
    ring: "",
    fill: "#d1d5db",
  },
};

const SUMMARY_TILES = [
  {
    key: "no_activity",
    label: "No Activity",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
    color: "#94a3b8",
  },
  {
    key: "not_started",
    label: "Not Started",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    getLabelFn: (period: string) => `Not Started for ${period}`,
    color: "#6366f1",
  },
  {
    key: "draft",
    label: "Drafts",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
    getLabelFn: (period: string) => `Drafts for ${period}`,
    color: "#f59e0b",
  },
  {
    key: "finalized",
    label: "Finalized",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    getLabelFn: (period: string) => `Finalized for ${period}`,
    color: "#10b981",
  },
];

type TileFilterKey = "no_activity" | "not_started" | "draft" | "finalized";
type SortByKey = "category_name" | "category_number" | "category_subtype" | "last_reconciled";

const SORT_OPTIONS: { key: SortByKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "category_name",
    label: "Category Name",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
        <path d="M17.5 2.5a2.121 2.121 0 0 1 3 3L12 14l-4 1 1-4 8.5-8.5z" />
      </svg>
    ),
  },
  {
    key: "category_number",
    label: "Category Number",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M5 9h4M5 15h4M12 3l-1 18M19 3l-1 18" />
      </svg>
    ),
  },
  {
    key: "category_subtype",
    label: "Category Subtype",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
  },
  {
    key: "last_reconciled",
    label: "Last Reconciled",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
];

// ============================================================================
// Helpers
// ============================================================================

function getDefaultDateRange(): { from: string; to: string } {
  const year = new Date().getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function getPeriodLabel(from: string, to: string): string {
  const dFrom = new Date(`${from}T00:00:00`);
  const dTo = new Date(`${to}T00:00:00`);
  // Full year check: Jan 1 to Dec 31 of same year
  if (
    dFrom.getMonth() === 0 &&
    dFrom.getDate() === 1 &&
    dTo.getMonth() === 11 &&
    dTo.getDate() === 31 &&
    dFrom.getFullYear() === dTo.getFullYear()
  ) {
    return String(dFrom.getFullYear());
  }
  return dFrom.toLocaleDateString("en-US", { month: "long" });
}

// ============================================================================
// Page
// ============================================================================

function ReconciliationsPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const { collapsed } = useSidebar();
  const search = Route.useSearch() as ReconciliationsSearch;

  const defaults = getDefaultDateRange();
  const dateFrom = search.dateFrom || defaults.from;
  const dateTo = search.dateTo || defaults.to;

  // ── Start Manually modal state ──
  const [startManuallyModal, setStartManuallyModal] = useState<StartManuallyModalData | null>(null);
  const [activeFilter, setActiveFilter] = useState<TileFilterKey | null>(null);
  const [sortBy, setSortBy] = useState<SortByKey>("category_name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [kebabMenuOpen, setKebabMenuOpen] = useState(false);
  const [startReconModalOpen, setStartReconModalOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLDivElement>(null);

  // Close sort menu on outside click
  useEffect(() => {
    if (!sortMenuOpen) return;
    function handle(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [sortMenuOpen]);

  // Close kebab menu on outside click
  useEffect(() => {
    if (!kebabMenuOpen) return;
    function handle(e: MouseEvent) {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setKebabMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [kebabMenuOpen]);

  const handleStartManually = useCallback(
    (
      bankAccountId: string,
      bankAccountName: string,
      bankAccountNumber: string | null,
      month: number,
      year: number,
    ) => {
      setStartManuallyModal({ bankAccountId, bankAccountName, bankAccountNumber, month, year });
    },
    [],
  );

  // ── Date navigation ──
  const handleDateChange = useCallback(
    (from: string, to: string) => {
      navigate({
        to: "/reconciliations" as string & {},
        search: { dateFrom: from, dateTo: to },
      });
    },
    [navigate],
  );

  const handlePrev = useCallback(() => {
    const r = computePrevRange(dateFrom, dateTo);
    handleDateChange(r.from, r.to);
  }, [dateFrom, dateTo, handleDateChange]);

  const handleNext = useCallback(() => {
    const r = computeNextRange(dateFrom, dateTo);
    handleDateChange(r.from, r.to);
  }, [dateFrom, dateTo, handleDateChange]);

  // ── Data ──
  const reconsQuery = useQuery({
    queryKey: ["reconciliations", "list", dateFrom, dateTo],
    queryFn: () =>
      (listReconciliations as ServerFnCaller)({
        data: { dateFrom, dateTo },
      }),
    enabled: !!session?.user,
  });

  const timelineQuery = useQuery({
    queryKey: ["reconciliations", "timeline", dateFrom],
    queryFn: () =>
      (getReconciliationTimeline as ServerFnCaller)({
        data: { year: new Date(`${dateFrom}T00:00:00`).getFullYear() },
      }),
    enabled: !!session?.user,
  });

  const timeline = (timelineQuery.data ?? []) as TimelineEntry[];

  const periodLabel = getPeriodLabel(dateFrom, dateTo);

  // Summary stats: count per-account (how many accounts have at least one month with this status)
  const summaryStats = useMemo(() => {
    const stats = { no_activity: 0, not_started: 0, draft: 0, finalized: 0 };
    for (const entry of timeline) {
      const allNoActivity = entry.months.every((m) => m.status === "no_activity");
      if (allNoActivity) {
        stats.no_activity++;
        // Also count as not_started — no reconciliation has been started for this account
        stats.not_started++;
      } else {
        const hasNotStarted = entry.months.some(
          (m) => m.status === "not_started" || m.status === "no_activity",
        );
        const hasDraft = entry.months.some(
          (m) => m.status === "draft" || m.status === "in_progress",
        );
        const hasFinalized = entry.months.some((m) => m.status === "finalized");
        if (hasNotStarted) stats.not_started++;
        if (hasDraft) stats.draft++;
        if (hasFinalized) stats.finalized++;
      }
    }
    return stats;
  }, [timeline]);

  // Filter and sort timeline entries
  const filteredTimeline = useMemo(() => {
    let entries = [...timeline];
    if (activeFilter) {
      entries = entries.filter((entry) => {
        if (activeFilter === "no_activity")
          return entry.months.every((m) => m.status === "no_activity");
        if (activeFilter === "not_started")
          return entry.months.some((m) => m.status === "not_started" || m.status === "no_activity");
        if (activeFilter === "draft")
          return entry.months.some((m) => m.status === "draft" || m.status === "in_progress");
        if (activeFilter === "finalized") return entry.months.some((m) => m.status === "finalized");
        return true;
      });
    }
    // Helper: COA category order for sorting
    const categoryOrder = (type: string | null): number => {
      switch (type?.toLowerCase()) {
        case "checking":
        case "savings":
        case "bank_account":
          return 1; // Assets
        case "credit_card":
          return 2; // Liabilities
        default:
          return 9; // Other
      }
    };

    const dir = sortDir === "asc" ? 1 : -1;
    entries.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "category_name") {
        cmp = categoryOrder(a.accountType) - categoryOrder(b.accountType);
        if (cmp === 0) cmp = a.bankAccountName.localeCompare(b.bankAccountName);
      } else if (sortBy === "category_number") {
        cmp = categoryOrder(a.accountType) - categoryOrder(b.accountType);
        if (cmp === 0)
          cmp = (a.bankAccountNumber ?? "").localeCompare(b.bankAccountNumber ?? "", undefined, {
            numeric: true,
          });
      } else if (sortBy === "category_subtype") {
        cmp = (a.accountType ?? "").localeCompare(b.accountType ?? "");
        if (cmp === 0) cmp = a.bankAccountName.localeCompare(b.bankAccountName);
      } else if (sortBy === "last_reconciled") {
        const lastA = [...a.months]
          .reverse()
          .find((m) => m.status === "finalized" || m.status === "draft");
        const lastB = [...b.months]
          .reverse()
          .find((m) => m.status === "finalized" || m.status === "draft");
        cmp =
          (lastB ? lastB.year * 100 + lastB.month : 0) -
          (lastA ? lastA.year * 100 + lastA.month : 0);
      }
      return cmp * dir;
    });
    return entries;
  }, [timeline, activeFilter, sortBy, sortDir]);

  if (!session?.user) return null;

  const isLoading = reconsQuery.isLoading || timelineQuery.isLoading;

  return (
    <div
      className={`flex flex-col min-h-full bg-[#f0f4f5] dark:bg-[#0b1015] transition-all duration-300 ${
        collapsed ? "ml-0" : "ml-0"
      }`}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] px-3 sm:px-6 pt-5 pb-4 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="1.5"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <h1 className="text-[18px] font-semibold text-white">Reconciliations</h1>
          </div>
        </div>

        {/* Date Navigator */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0 bg-white/10 rounded-lg shrink-0">
            <button
              type="button"
              onClick={handlePrev}
              disabled={isPrevDisabled(dateFrom, dateTo)}
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
            <SmartDateFilter
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChange={handleDateChange}
              hideChevron
              className="h-8 rounded-none border-none bg-transparent text-white/70 hover:text-white hover:bg-white/10 px-2 text-xs font-medium"
            />
            <button
              type="button"
              onClick={handleNext}
              disabled={isNextDisabled(dateFrom, dateTo)}
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
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {/* Sort By Dropdown */}
            <div ref={sortRef} className="relative">
              <button
                type="button"
                onClick={() => setSortMenuOpen(!sortMenuOpen)}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white/15 text-white text-[12px] font-medium hover:bg-white/25 transition-colors cursor-pointer"
                title="Sort By"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M11 5h10M11 9h7M11 13h4" />
                  <path d="M3 4v16M3 4l3 3M3 4L0 7" />
                </svg>
              </button>
              {sortMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-[#1c2536] rounded-xl shadow-xl border border-[#e2e8f0] dark:border-white/10 py-1 z-50">
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 dark:text-white/30 uppercase tracking-wider">
                    Sort By
                  </div>
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        if (sortBy === opt.key) {
                          setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        } else {
                          setSortBy(opt.key);
                          setSortDir("asc");
                        }
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-left transition-colors cursor-pointer ${
                        sortBy === opt.key
                          ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 font-medium"
                          : "text-gray-700 dark:text-white/70 hover:bg-gray-50 dark:hover:bg-white/5"
                      }`}
                    >
                      <span className="shrink-0 opacity-70">{opt.icon}</span>
                      {opt.label}
                      {sortBy === opt.key && (
                        <svg
                          className="ml-auto shrink-0 transition-transform"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          style={{ transform: sortDir === "desc" ? "rotate(180deg)" : "none" }}
                        >
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 8v8M8 12l4-4 4 4" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* The label wraps to two lines at 375px and shoves the kebab off the right edge, so
                below `sm` this is the icon alone. `aria-label` keeps the accessible name. */}
            <button
              type="button"
              onClick={() => setStartReconModalOpen(true)}
              aria-label="Start Reconciliation"
              className="flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-white/15 px-3 text-[12px] font-medium whitespace-nowrap text-white transition-colors hover:bg-white/25 sm:px-4"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="hidden sm:inline">Start Reconciliation</span>
            </button>
            {/* Kebab menu */}
            <div ref={kebabRef} className="relative">
              <button
                type="button"
                onClick={() => setKebabMenuOpen(!kebabMenuOpen)}
                className="touch-target flex items-center justify-center w-8 h-8 rounded-lg bg-white/15 text-white hover:bg-white/25 transition-colors cursor-pointer"
                title="More actions"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
              {kebabMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-[#1c2536] rounded-xl shadow-xl border border-[#e2e8f0] dark:border-white/10 py-1 z-50">
                  <button
                    type="button"
                    onClick={() => {
                      setKebabMenuOpen(false);
                      setDownloadModalOpen(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-gray-700 dark:text-white/70 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download PDF...
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Summary Tiles ─────────────────────────────────────────────────────── */}
      <div className="-mt-0 px-3 sm:px-6">
        {/* Four tiles across a 375px screen leaves ~90px each, which wraps "Not Started for 2026"
            onto three lines and pushes the fourth tile off the edge. Two-up until `sm`. */}
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[#e2e8f0] bg-white sm:grid-cols-4 dark:border-white/10 dark:bg-[#111827]">
          {SUMMARY_TILES.map((tile, i) => {
            const tileKey = tile.key as TileFilterKey;
            const count = summaryStats[tileKey];
            const total = tile.key === "finalized" ? timeline.length : undefined;
            const label = tile.getLabelFn ? tile.getLabelFn(periodLabel) : tile.label;
            const isActive = activeFilter === tileKey;

            // Per-tile active bg colors (light / dark)
            const activeBgMap: Record<TileFilterKey, string> = {
              no_activity: "bg-slate-100 dark:bg-slate-800/40",
              not_started: "bg-indigo-50 dark:bg-indigo-900/25",
              draft: "bg-blue-50 dark:bg-blue-900/25",
              finalized: "bg-emerald-50 dark:bg-emerald-900/25",
            };

            return (
              <button
                type="button"
                key={tile.key}
                onClick={() => setActiveFilter(isActive ? null : tileKey)}
                className={`flex items-center gap-3 px-5 py-4 text-left cursor-pointer transition-colors ${
                  i < 3 ? "border-r border-[#e2e8f0] dark:border-white/10" : ""
                } ${isActive ? activeBgMap[tileKey] : "hover:bg-gray-50 dark:hover:bg-white/5"}`}
              >
                <div
                  className={`shrink-0 ${isActive ? "opacity-100" : "opacity-50"}`}
                  style={{ color: isActive ? tile.color : undefined }}
                >
                  {tile.icon}
                </div>
                <div>
                  <div
                    className="text-[24px] font-bold tabular-nums"
                    style={{ color: isActive ? tile.color : tile.color }}
                  >
                    {count}
                    {total !== undefined && (
                      <span className="text-[14px] font-normal text-gray-400 dark:text-white/30">
                        {" "}
                        / {total}
                      </span>
                    )}
                  </div>
                  <div
                    className={`text-[11px] leading-tight ${isActive ? "font-medium" : ""}`}
                    style={{ color: isActive ? tile.color : undefined }}
                  >
                    {label}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────── */}
      <div className="flex-1 px-3 sm:px-6 pb-6 mt-4">
        {isLoading ? (
          <LoadingSkeleton />
        ) : activeFilter && filteredTimeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-gray-500 dark:text-white/40 text-[15px] mb-3">No Reconciliations</p>
            <button
              type="button"
              onClick={() => setActiveFilter(null)}
              className="flex items-center gap-1.5 text-[13px] text-gray-500 dark:text-white/40 hover:text-gray-700 dark:hover:text-white/60 cursor-pointer"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M1 4v6h6" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              Reset Filters
            </button>
          </div>
        ) : (
          <ListView timeline={filteredTimeline} onStartManually={handleStartManually} />
        )}
      </div>

      {/* ── Start Manually Modal ── */}
      {startManuallyModal && (
        <StartManuallyModal
          data={startManuallyModal}
          onClose={() => setStartManuallyModal(null)}
          onCreated={(reconId) => {
            setStartManuallyModal(null);
            navigate({
              to: `/reconciliations/${reconId}` as string & {},
            });
          }}
        />
      )}

      {/* ── Start Reconciliation Modal (header button) ── */}
      {startReconModalOpen && (
        <StartReconciliationModal
          timeline={timeline}
          onClose={() => setStartReconModalOpen(false)}
          onCreated={(reconId: string) => {
            setStartReconModalOpen(false);
            navigate({
              to: `/reconciliations/${reconId}` as string & {},
            });
          }}
        />
      )}

      {/* ── Download Reconciliation Report Modal ── */}
      {downloadModalOpen && <DownloadReportModal onClose={() => setDownloadModalOpen(false)} />}
    </div>
  );
}

// ============================================================================
// Download Reconciliation Report Modal
// ============================================================================

function DownloadReportModal({ onClose }: { onClose: () => void }) {
  // Default to current year
  const now = new Date();
  const currentYear = now.getFullYear();
  const [dateFrom, setDateFrom] = useState(`${currentYear}-01-01`);
  const [dateTo, setDateTo] = useState(`${currentYear}-12-31`);

  const handleDateChange = useCallback((from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  }, []);

  // Query timeline based on the year extracted from dateFrom
  const queryYear = new Date(`${dateFrom}T00:00:00`).getFullYear();
  const timelineQuery = useQuery({
    queryKey: ["reconciliations", "timeline", "download", queryYear],
    queryFn: () =>
      (getReconciliationTimeline as ServerFnCaller)({
        data: { year: queryYear },
      }),
  });

  const timeline = (timelineQuery.data ?? []) as TimelineEntry[];

  // Filter finalized accounts to only include months within the selected date range
  const finalizedAccounts = useMemo(() => {
    const fromDate = new Date(`${dateFrom}T00:00:00`);
    const toDate = new Date(`${dateTo}T00:00:00`);
    const fromMonth = fromDate.getMonth() + 1;
    const fromYear = fromDate.getFullYear();
    const toMonth = toDate.getMonth() + 1;
    const toYear = toDate.getFullYear();

    return timeline
      .map((entry) => {
        const finalizedMonths = entry.months.filter((m) => {
          if (m.status !== "finalized" || !m.reconciliationId) return false;
          // Check if this month falls within the selected date range
          if (m.year < fromYear || m.year > toYear) return false;
          if (m.year === fromYear && m.month < fromMonth) return false;
          if (m.year === toYear && m.month > toMonth) return false;
          return true;
        });
        if (finalizedMonths.length === 0) return null;
        return {
          id: entry.bankAccountId,
          name: entry.bankAccountName,
          lastFour: entry.bankAccountNumber,
          accountType: entry.accountType,
          reconciliationIds: finalizedMonths.map((m) => m.reconciliationId!),
          monthCount: finalizedMonths.length,
        };
      })
      .filter(Boolean) as {
      id: string;
      name: string;
      lastFour: string | null;
      accountType: string;
      reconciliationIds: string[];
      monthCount: number;
    }[];
  }, [timeline, dateFrom, dateTo]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set<string>());

  // Auto-select all finalized accounts when the list changes
  useEffect(() => {
    setSelectedIds(new Set(finalizedAccounts.map((a) => a.id)));
  }, [finalizedAccounts]);

  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDownload = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    setProgress(0);

    // Collect all reconciliation IDs for selected accounts
    const reconIds: string[] = [];
    for (const acct of finalizedAccounts) {
      if (selectedIds.has(acct.id)) {
        reconIds.push(...acct.reconciliationIds);
      }
    }

    let completed = 0;
    const total = reconIds.length;

    for (const reconId of reconIds) {
      try {
        const reportData = (await (getReconciliationReportData as ServerFnCaller)({
          data: { id: reconId },
        })) as ReconciliationReportData;

        // Generate PDF
        const pdfBlob = generateReconciliationPDF(reportData);

        // Trigger browser download
        const url = URL.createObjectURL(pdfBlob);
        const a = document.createElement("a");
        a.href = url;
        const safeName = reportData.accountName.replace(/[^a-zA-Z0-9 ]/g, "");
        a.download = `${safeName} - ${reportData.periodEnd} - Reconciliation Report.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        logger.error("Failed to generate PDF", { reconId, error: err });
      }

      completed++;
      setProgress((completed / total) * 100);
    }

    // Brief delay to show 100%
    setTimeout(() => {
      setExporting(false);
      onClose();
    }, 500);
  };

  const exportTitle = `Exporting ${selectedIds.size} Reconciliation Report${selectedIds.size > 1 ? "s" : ""}`;

  return (
    <Modal
      open
      // The export loop triggers one browser download per reconciliation and closes itself when
      // done; Escape mid-run would strand the remaining files, so dismissal is disabled while it
      // is in flight. The overlay this replaced was never backdrop-dismissable either.
      onClose={exporting ? () => {} : onClose}
      title={exporting ? exportTitle : "Download Reconciliation Report"}
      mobile="sheet"
      size="md"
      closeOnBackdrop={false}
      hideHeader={exporting}
      footer={
        exporting ? undefined : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-lg px-4 text-[13px] text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={selectedIds.size === 0}
              className={`flex min-h-11 items-center justify-center gap-1.5 rounded-full px-5 text-[13px] font-medium transition-colors ${
                selectedIds.size > 0
                  ? "bg-emerald-500 text-white hover:bg-emerald-600 cursor-pointer"
                  : "bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-white/30 cursor-not-allowed"
              }`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
          </>
        )
      }
    >
      {exporting ? (
        <div className="py-2">
          <div className="flex items-center gap-3 mb-3">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="shrink-0 text-emerald-500"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <div>
              <div className="text-[14px] font-semibold text-gray-800 dark:text-white">
                {exportTitle}
              </div>
              <div className="text-[12px] text-gray-500 dark:text-white/50">
                Hang tight! This may take a moment...
              </div>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : (
        <>
          {/* Smart Date Filter */}
          <div className="flex justify-center pb-3">
            <div className="[&>div>button]:rounded-full [&>div>button]:border [&>div>button]:border-[#e2e8f0] [&>div>button]:dark:border-white/10 [&>div>button]:text-[12px] [&>div>button]:font-medium [&>div>button]:text-gray-600 [&>div>button]:dark:text-white/60 [&>div>button]:hover:bg-gray-50 [&>div>button]:dark:hover:bg-white/5 [&>div>button]:hover:border-gray-300 [&>div>button_svg]:stroke-gray-400 [&>div>button_svg]:dark:stroke-white/30">
              <SmartDateFilter dateFrom={dateFrom} dateTo={dateTo} onChange={handleDateChange} />
            </div>
          </div>

          {/* Deselect/Select All */}
          {finalizedAccounts.length > 0 && (
            <div className="flex justify-end mb-1">
              <button
                type="button"
                onClick={() => {
                  if (selectedIds.size === finalizedAccounts.length) setSelectedIds(new Set());
                  else setSelectedIds(new Set(finalizedAccounts.map((a) => a.id)));
                }}
                className="touch-target text-[12px] text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/60 cursor-pointer"
              >
                {selectedIds.size === finalizedAccounts.length ? "Deselect All" : "Select All"}
              </button>
            </div>
          )}

          {/* Account list */}
          {timelineQuery.isLoading ? (
            <div className="text-center py-12 text-gray-400 dark:text-white/30 text-[13px]">
              Loading reconciliations…
            </div>
          ) : finalizedAccounts.length === 0 ? (
            <div className="text-center py-12 text-gray-400 dark:text-white/30 text-[13px] italic">
              No finalized reconciliations found in the selected period.
            </div>
          ) : (
            finalizedAccounts.map((acct) => (
              <button
                key={acct.id}
                type="button"
                onClick={() => toggleId(acct.id)}
                className={`w-full flex min-h-11 items-center gap-3 px-3 py-2.5 rounded-lg mb-1 transition-colors cursor-pointer ${
                  selectedIds.has(acct.id)
                    ? "bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/30"
                    : "border border-[#e2e8f0] dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-white text-[10px] font-bold shrink-0 ${
                    acct.accountType === "credit_card" ? "bg-amber-500" : "bg-emerald-600"
                  }`}
                >
                  {acct.accountType === "credit_card" ? "CC" : "BA"}
                </div>
                <span className="text-[13px] text-gray-800 dark:text-white/80 font-medium flex-1 text-left">
                  {acct.name}
                  {acct.lastFour ? ` ${acct.lastFour}` : ""}
                </span>
                {selectedIds.has(acct.id) && (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="2.5"
                    className="shrink-0"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="3" fill="#10b981" stroke="none" />
                    <polyline points="9 12 11 14 15 10" stroke="white" />
                  </svg>
                )}
              </button>
            ))
          )}
        </>
      )}
    </Modal>
  );
}

// ============================================================================
// List View — Collapsible table grouped by bank account type, 1 row per month
// ============================================================================

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Assets",
  savings: "Assets",
  bank_account: "Assets",
  credit_card: "Liabilities",
};

function ListView({
  timeline,
  onStartManually,
}: {
  timeline: TimelineEntry[];
  onStartManually: (
    bankAccountId: string,
    bankAccountName: string,
    bankAccountNumber: string | null,
    month: number,
    year: number,
  ) => void;
}) {
  // Group by display category (Bank Accounts, Credit Cards, etc.)
  const groups = useMemo(() => {
    const map = new Map<string, TimelineEntry[]>();
    for (const entry of timeline) {
      const displayName =
        ACCOUNT_TYPE_LABELS[entry.accountType?.toLowerCase() ?? ""] ?? entry.accountType ?? "Other";
      const list = map.get(displayName) ?? [];
      list.push(entry);
      map.set(displayName, list);
    }
    return Array.from(map.entries()).map(([category, entries]) => ({
      category,
      entries,
    }));
  }, [timeline]);

  // Track expanded bank accounts (by bankAccountId)
  const [expandedAccounts, setExpandedAccounts] = useState<string[]>([]);

  const toggleAccount = (id: string) => {
    setExpandedAccounts((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  if (timeline.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div
          key={group.category}
          className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden bg-white dark:bg-[#111827]"
        >
          {/* Category header */}
          <div className="px-4 py-2.5 border-b border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-white/[0.02]">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/15 flex items-center justify-center shrink-0">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="1.5"
                >
                  {group.category === "Credit Cards" ? (
                    <>
                      <rect x="1" y="4" width="22" height="16" rx="2" />
                      <path d="M1 10h22" />
                    </>
                  ) : (
                    <>
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <path d="M2 10h20" />
                    </>
                  )}
                </svg>
              </div>
              <span className="text-[13px] font-semibold text-gray-700 dark:text-white/80">
                {group.category}
              </span>
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[#e2e8f0] dark:bg-white/10 text-[#64748b] dark:text-white/50">
                {group.entries.length}
              </span>
            </div>
          </div>

          {/* Bank accounts under this category */}
          {group.entries.map((entry) => {
            const isExpanded = expandedAccounts.includes(entry.bankAccountId);
            const activeMonths = entry.months.filter((m) => m.status !== "no_activity");
            const finalizedCount = entry.months.filter((m) => m.status === "finalized").length;
            const draftCount = entry.months.filter(
              (m) => m.status === "draft" || m.status === "in_progress",
            ).length;

            return (
              <div key={entry.bankAccountId}>
                {/* Bank account header row */}
                <button
                  type="button"
                  onClick={() => toggleAccount(entry.bankAccountId)}
                  className="w-full flex items-center gap-3 px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10 hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  {/* Chevron */}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className={`text-gray-400 dark:text-white/30 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>

                  {/* Account info */}
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="w-7 h-7 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/15 flex items-center justify-center shrink-0">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="1.5"
                      >
                        <rect x="2" y="5" width="20" height="14" rx="2" />
                        <path d="M2 10h20" />
                      </svg>
                    </div>
                    <div className="min-w-0 text-left">
                      <div className="text-[13px] font-semibold text-gray-800 dark:text-white truncate">
                        {entry.bankAccountName}
                      </div>
                    </div>
                  </div>

                  {/* Summary badges */}
                  <div className="flex items-center gap-2 shrink-0">
                    {finalizedCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        {finalizedCount} Finalized
                      </span>
                    )}
                    {draftCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                        {draftCount} In Progress
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400 dark:text-white/30">
                      {activeMonths.length} of {entry.months.length} months
                    </span>
                  </div>
                </button>

                {/* Expanded month rows */}
                {isExpanded && (
                  <div className="bg-[#fafbfc] dark:bg-white/[0.01]">
                    {entry.months.map((m) => {
                      const dot = STATUS_DOT[m.status] ?? STATUS_DOT.no_activity;
                      const monthName = MONTHS[(m.month - 1) % 12];
                      const statusLabel = m.status.replace(/_/g, " ");
                      const isClickable = !!m.reconciliationId;
                      const isEmpty = m.status === "not_started" || m.status === "no_activity";

                      return (
                        <div
                          key={`${m.year}-${m.month}`}
                          className="flex items-center gap-3 px-4 py-2.5 pl-14 border-b border-[#f0f3f6] dark:border-white/5 last:border-b-0 hover:bg-white dark:hover:bg-white/[0.03] transition-colors"
                        >
                          {/* Status dot */}
                          {isEmpty ? (
                            <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
                              <circle
                                cx="6"
                                cy="6"
                                r="5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeDasharray="3 2"
                                className="text-gray-300 dark:text-white/20"
                              />
                            </svg>
                          ) : (
                            <div className={`w-3 h-3 rounded-full shrink-0 ${dot.bg}`} />
                          )}

                          {/* Month name */}
                          <div className="w-[100px] shrink-0">
                            <span className="text-[13px] font-medium text-gray-700 dark:text-white/80">
                              {monthName} {m.year}
                            </span>
                          </div>

                          {/* Status label */}
                          <div className="flex-1">
                            <span
                              className={`text-[11px] font-medium capitalize px-2 py-0.5 rounded-full ${
                                m.status === "finalized"
                                  ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : m.status === "in_progress" || m.status === "draft"
                                    ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                    : m.status === "not_started"
                                      ? "bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                      : "bg-gray-100 dark:bg-white/5 text-gray-400 dark:text-white/30"
                              }`}
                            >
                              {statusLabel}
                            </span>
                          </div>

                          {/* Action */}
                          <div className="shrink-0">
                            {isClickable ? (
                              <Link
                                to={`/reconciliations/${m.reconciliationId}` as string & {}}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-medium transition-colors"
                              >
                                {m.status === "finalized" ? (
                                  <>
                                    <svg
                                      width="10"
                                      height="10"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                    >
                                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                      <circle cx="12" cy="12" r="3" />
                                    </svg>
                                    View
                                  </>
                                ) : (
                                  <>
                                    <svg
                                      width="10"
                                      height="10"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                    </svg>
                                    Continue
                                  </>
                                )}
                              </Link>
                            ) : isEmpty ? (
                              <button
                                type="button"
                                onClick={() =>
                                  onStartManually(
                                    entry.bankAccountId,
                                    entry.bankAccountName,
                                    entry.bankAccountNumber,
                                    m.month,
                                    m.year,
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-white/50 text-[10px] font-medium transition-colors"
                              >
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <line x1="12" y1="5" x2="12" y2="19" />
                                  <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                Start
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// InlineCalendar — mini month-grid calendar dropdown
// ============================================================================

const CAL_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const CAL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function InlineCalendar({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (dateStr: string) => void;
  onClose: () => void;
}) {
  const parsed = value ? new Date(value + "T00:00:00") : new Date();
  const [viewYear, setViewYear] = useState(parsed.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed.getMonth()); // 0-indexed
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const startDay = new Date(viewYear, viewMonth, 1).getDay();

  const todayStr = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);

  const handlePrev = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };
  const handleNext = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelect = (day: number) => {
    const str = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    onChange(str);
  };

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div
      ref={wrapRef}
      className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-[#1e293b] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl p-3 animate-in fade-in slide-in-from-top-1 duration-150"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={handlePrev}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-white/50 cursor-pointer"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="text-[13px] font-semibold text-gray-800 dark:text-white">
          {CAL_MONTHS[viewMonth]} {viewYear}
        </span>
        <button
          type="button"
          onClick={handleNext}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-white/50 cursor-pointer"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0 mb-1">
        {CAL_DAYS.map((d) => (
          <div
            key={d}
            className="text-center text-[10px] font-medium text-gray-400 dark:text-white/30 py-1"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0">
        {cells.map((day, i) => {
          if (day === null) {
            return <div key={`empty-${String(i)}`} className="h-7" />;
          }
          const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const isSelected = dateStr === value;
          const isToday = dateStr === todayStr;
          return (
            <button
              key={dateStr}
              type="button"
              onClick={() => handleSelect(day)}
              className={`h-7 w-full rounded-md text-[12px] font-medium transition-colors cursor-pointer ${
                isSelected
                  ? "bg-emerald-500 text-white"
                  : isToday
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                    : "text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10"
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Start Reconciliation Modal — two-step: 1) pick account, 2) statement details
// ============================================================================

function StartReconciliationModal({
  timeline,
  onClose,
  onCreated,
}: {
  timeline: TimelineEntry[];
  onClose: () => void;
  onCreated: (reconId: string) => void;
}) {
  const [step, setStep] = useState<"account" | "details">("account");
  const [search, setSearch] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<TimelineEntry | null>(null);

  // Statement details state (step 2)
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const endOfMonth = useMemo(() => {
    const lastDay = new Date(currentYear, currentMonth, 0).getDate();
    return `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }, [currentYear, currentMonth]);

  const [statementDate, setStatementDate] = useState(endOfMonth);
  const [endingBalance, setEndingBalance] = useState("");
  const [charges, setCharges] = useState("");
  const [payments, setPayments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  const isValidNumber = (val: string) => val === "" || /^-?\d*\.?\d*$/.test(val.replace(/,/g, ""));
  const balanceInvalid = endingBalance !== "" && !isValidNumber(endingBalance);
  const chargesInvalid = charges !== "" && !isValidNumber(charges);
  const paymentsInvalid = payments !== "" && !isValidNumber(payments);
  const canSubmit =
    endingBalance !== "" && !balanceInvalid && !chargesInvalid && !paymentsInvalid && !submitting;

  // Group accounts by type (Assets / Liabilities)
  const groupedAccounts = useMemo(() => {
    const groups: Record<string, TimelineEntry[]> = {};
    for (const entry of timeline) {
      const q = search.toLowerCase();
      if (
        q &&
        !entry.bankAccountName.toLowerCase().includes(q) &&
        !(entry.bankAccountNumber ?? "").toLowerCase().includes(q) &&
        !(entry.accountType ?? "").toLowerCase().includes(q)
      ) {
        continue;
      }
      const type = entry.accountType ?? "Other";
      // Map to display label
      const label =
        type === "checking" || type === "savings"
          ? "Assets"
          : type === "credit_card"
            ? "Liabilities"
            : type.charAt(0).toUpperCase() + type.slice(1);
      if (!groups[label]) groups[label] = [];
      groups[label].push(entry);
    }
    // Sort: Assets first, then Liabilities, then rest
    const order: Record<string, number> = { Assets: 0, Liabilities: 1 };
    return Object.entries(groups).sort(([a], [b]) => (order[a] ?? 99) - (order[b] ?? 99));
  }, [timeline, search]);

  const handleBuild = async () => {
    if (!canSubmit || !selectedAccount) return;
    setSubmitting(true);
    setError(null);
    try {
      const periodStart = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;
      const recon = await createReconciliation({
        data: {
          bankAccountId: selectedAccount.bankAccountId,
          periodStart,
          periodEnd: statementDate,
          statementEndingBalance: endingBalance.replace(/,/g, ""),
          statementBeginningBalance: "0.00",
        },
      });
      onCreated(recon.id);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setError(errMessage || "Failed to create reconciliation");
      setSubmitting(false);
    }
  };

  // Step 2 → step 1. Clearing the amounts is deliberate: they belong to the account being left.
  const backToAccountStep = () => {
    setStep("account");
    setEndingBalance("");
    setCharges("");
    setPayments("");
    setError(null);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        step === "account" ? "Select Account" : (selectedAccount?.bankAccountName ?? "Account")
      }
      mobile="fullscreen"
      size="sm"
      footer={
        step === "account" ? (
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg px-4 text-[13px] font-medium text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={backToAccountStep}
              className="min-h-11 rounded-lg px-4 text-[13px] font-medium text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleBuild}
              disabled={!canSubmit}
              className={`min-h-11 rounded-lg px-5 text-[13px] font-semibold transition-all cursor-pointer ${
                canSubmit
                  ? "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-md hover:shadow-lg hover:from-emerald-600 hover:to-teal-600"
                  : "bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-white/30 cursor-not-allowed"
              }`}
            >
              {submitting ? "Building…" : "Build Reconciliation"}
            </button>
          </>
        )
      }
    >
      {step === "account" ? (
        /* ── Step 1: Account Picker ── */
        <div>
          {/* Search input */}
          <div className="relative mb-4">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-white/30"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Select or Create New"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-[13px] text-gray-800 dark:text-white placeholder-gray-400 dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-colors"
              autoFocus
            />
          </div>

          {/* Account list */}
          <div className="-mx-2">
            {groupedAccounts.length === 0 ? (
              <div className="text-center text-[13px] text-gray-400 dark:text-white/30 py-8">
                No bank accounts found
              </div>
            ) : (
              groupedAccounts.map(([groupLabel, entries]) => (
                <div key={groupLabel}>
                  {/* Group header */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="text-gray-400 dark:text-white/30"
                    >
                      {groupLabel === "Assets" ? (
                        <>
                          <rect x="2" y="6" width="20" height="12" rx="2" />
                          <path d="M2 10h20" />
                        </>
                      ) : (
                        <>
                          <rect x="2" y="5" width="20" height="14" rx="2" />
                          <line x1="2" y1="10" x2="22" y2="10" />
                        </>
                      )}
                    </svg>
                    <span className="text-[11px] font-semibold text-gray-400 dark:text-white/30 uppercase tracking-wider">
                      {groupLabel}
                    </span>
                  </div>

                  {/* Account entries */}
                  {entries.map((entry) => (
                    <button
                      key={entry.bankAccountId}
                      type="button"
                      onClick={() => {
                        setSelectedAccount(entry);
                        setStep("details");
                      }}
                      className="w-full flex min-h-11 items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-white/5 transition-colors rounded-lg cursor-pointer"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="text-gray-500 dark:text-white/50 shrink-0"
                      >
                        <rect x="2" y="5" width="20" height="14" rx="2" />
                        <line x1="2" y1="10" x2="22" y2="10" />
                      </svg>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-gray-800 dark:text-white truncate">
                          {entry.bankAccountName}
                        </div>
                        <div className="text-[11px] text-gray-400 dark:text-white/30">
                          {groupLabel}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* ── Step 2: Statement Details ── */
        <div>
          {/* The gradient header this replaced carried the step-back chevron. Modal's own close
              affordance exits the whole flow, so the back-to-account-picker path lives here. */}
          <button
            type="button"
            onClick={backToAccountStep}
            className="mb-3 -ml-2 flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 transition-colors cursor-pointer"
          >
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
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
            Choose a different account
          </button>

          <div className="border border-gray-200 dark:border-white/10 rounded-xl p-5">
            <h3 className="text-[14px] font-semibold text-gray-800 dark:text-white mb-4">
              Enter Statement Details
            </h3>

            {/* Statement Date */}
            <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
              Statement Date
            </label>
            <div className="relative mb-4" ref={calendarRef}>
              <button
                type="button"
                onClick={() => setCalendarOpen((o) => !o)}
                className="w-full flex min-h-11 items-center justify-between px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111827] text-[13px] text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-colors cursor-pointer"
              >
                <span>
                  {statementDate
                    ? new Date(statementDate + "T00:00:00").toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "Select date"}
                </span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-gray-400 dark:text-white/30"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </button>
              {calendarOpen && (
                <InlineCalendar
                  value={statementDate}
                  onChange={(d) => {
                    setStatementDate(d);
                    setCalendarOpen(false);
                  }}
                  onClose={() => setCalendarOpen(false)}
                />
              )}
            </div>

            {/* Statement Ending Balance */}
            <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
              Statement Ending Balance
            </label>
            <input
              type="text"
              value={endingBalance}
              onChange={(e) => setEndingBalance(e.target.value)}
              placeholder="$0.00"
              className={`w-full px-3 py-2 rounded-lg border text-right text-base sm:text-[13px] text-gray-800 dark:text-white bg-white dark:bg-[#111827] focus:outline-none focus:ring-2 transition-colors mb-4 ${
                balanceInvalid
                  ? "border-red-500 ring-2 ring-red-500/20 focus:border-red-500 focus:ring-red-500/30"
                  : "border-gray-200 dark:border-white/10 focus:ring-emerald-500/30 focus:border-emerald-500"
              }`}
            />

            {/* Charges (Optional) */}
            <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
              Charges <span className="text-[10px] opacity-60">(Optional)</span>
            </label>
            <input
              type="text"
              value={charges}
              onChange={(e) => setCharges(e.target.value)}
              placeholder=""
              className={`w-full px-3 py-2 rounded-lg border text-right text-base sm:text-[13px] text-gray-800 dark:text-white bg-white dark:bg-[#111827] focus:outline-none focus:ring-2 transition-colors mb-4 ${
                chargesInvalid
                  ? "border-red-500 ring-2 ring-red-500/20 focus:border-red-500 focus:ring-red-500/30"
                  : "border-gray-200 dark:border-white/10 focus:ring-emerald-500/30 focus:border-emerald-500"
              }`}
            />

            {/* Payments (Optional) */}
            <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
              Payments <span className="text-[10px] opacity-60">(Optional)</span>
            </label>
            <input
              type="text"
              value={payments}
              onChange={(e) => setPayments(e.target.value)}
              placeholder=""
              className={`w-full px-3 py-2 rounded-lg border text-right text-base sm:text-[13px] text-gray-800 dark:text-white bg-white dark:bg-[#111827] focus:outline-none focus:ring-2 transition-colors mb-4 ${
                paymentsInvalid
                  ? "border-red-500 ring-2 ring-red-500/20 focus:border-red-500 focus:ring-red-500/30"
                  : "border-gray-200 dark:border-white/10 focus:ring-emerald-500/30 focus:border-emerald-500"
              }`}
            />

            {error && (
              <div className="text-[12px] text-red-500 dark:text-red-400 mb-3">{error}</div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ============================================================================
// Start Manually Modal — statement details modal
// ============================================================================

function StartManuallyModal({
  data,
  onClose,
  onCreated,
}: {
  data: StartManuallyModalData;
  onClose: () => void;
  onCreated: (reconId: string) => void;
}) {
  // Pre-fill with end of month
  const endOfMonth = useMemo(() => {
    const lastDay = new Date(data.year, data.month, 0).getDate();
    return `${data.year}-${String(data.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }, [data.year, data.month]);

  const formattedDate = useMemo(() => {
    const d = new Date(`${endOfMonth}T00:00:00`);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }, [endOfMonth]);

  const [statementDate, setStatementDate] = useState(endOfMonth);
  const [endingBalance, setEndingBalance] = useState("");
  const [charges, setCharges] = useState("");
  const [payments, setPayments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValidNumber = (val: string) => val === "" || /^-?\d*\.?\d*$/.test(val.replace(/,/g, ""));
  const balanceInvalid = endingBalance !== "" && !isValidNumber(endingBalance);
  const chargesInvalid = charges !== "" && !isValidNumber(charges);
  const paymentsInvalid = payments !== "" && !isValidNumber(payments);

  const canSubmit =
    endingBalance !== "" && !balanceInvalid && !chargesInvalid && !paymentsInvalid && !submitting;

  const handleBuild = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const periodStart = `${data.year}-${String(data.month).padStart(2, "0")}-01`;
      const recon = await createReconciliation({
        data: {
          bankAccountId: data.bankAccountId,
          periodStart,
          periodEnd: statementDate,
          statementEndingBalance: endingBalance.replace(/,/g, ""),
          statementBeginningBalance: "0.00",
        },
      });
      onCreated(recon.id);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setError(errMessage || "Failed to create reconciliation");
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={data.bankAccountName}
      description={formattedDate}
      mobile="fullscreen"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg px-5 text-[13px] font-medium text-gray-600 dark:text-white/60 hover:text-gray-800 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleBuild}
            disabled={!canSubmit}
            className={`flex min-h-11 items-center justify-center rounded-full px-6 text-[13px] font-semibold transition-all ${
              canSubmit
                ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-md hover:shadow-lg cursor-pointer"
                : "bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-white/30 cursor-not-allowed"
            }`}
          >
            {submitting ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="opacity-25"
                  />
                  <path
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    fill="currentColor"
                    className="opacity-75"
                  />
                </svg>
                Building...
              </span>
            ) : (
              "Build Reconciliation"
            )}
          </button>
        </>
      }
    >
      <div>
        <div className="border border-gray-200 dark:border-white/10 rounded-xl p-5">
          <h3 className="text-[14px] font-semibold text-gray-800 dark:text-white mb-4">
            Enter Statement Details
          </h3>

          {/* Statement Date */}
          <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
            Statement Date
          </label>
          <input
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
            className="w-full min-h-11 px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-[13px] text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-colors mb-4"
            title={formattedDate}
          />

          {/* Statement Ending Balance */}
          <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
            Statement Ending Balance
          </label>
          <input
            type="text"
            value={endingBalance}
            onChange={(e) => setEndingBalance(e.target.value)}
            placeholder="$0.00"
            className={`w-full px-3 py-2 rounded-lg border text-right text-base sm:text-[13px] text-gray-800 dark:text-white bg-white dark:bg-[#111827] focus:outline-none focus:ring-2 transition-colors mb-4 ${
              balanceInvalid
                ? "border-red-500 ring-2 ring-red-500/20 focus:border-red-500 focus:ring-red-500/30"
                : "border-gray-200 dark:border-white/10 focus:ring-emerald-500/30 focus:border-emerald-500"
            }`}
          />

          {/* Charges (Optional) */}
          <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
            Charges <span className="text-[10px] opacity-60">(Optional)</span>
          </label>
          <input
            type="text"
            value={charges}
            onChange={(e) => setCharges(e.target.value)}
            placeholder=""
            className={`w-full px-3 py-2 rounded-lg border text-right text-base sm:text-[13px] text-gray-800 dark:text-white bg-white dark:bg-[#111827] focus:outline-none focus:ring-2 transition-colors mb-4 ${
              chargesInvalid
                ? "border-red-500 ring-2 ring-red-500/20 focus:border-red-500 focus:ring-red-500/30"
                : "border-gray-200 dark:border-white/10 focus:ring-emerald-500/30 focus:border-emerald-500"
            }`}
          />

          {/* Payments (Optional) */}
          <label className="block text-[11px] font-medium text-gray-500 dark:text-white/40 mb-1">
            Payments <span className="text-[10px] opacity-60">(Optional)</span>
          </label>
          <input
            type="text"
            value={payments}
            onChange={(e) => setPayments(e.target.value)}
            placeholder=""
            className={`w-full px-3 py-2 rounded-lg border text-right text-base sm:text-[13px] text-gray-800 dark:text-white bg-white dark:bg-[#111827] focus:outline-none focus:ring-2 transition-colors ${
              paymentsInvalid
                ? "border-red-500 ring-2 ring-red-500/20 focus:border-red-500 focus:ring-red-500/30"
                : "border-gray-200 dark:border-white/10 focus:ring-emerald-500/30 focus:border-emerald-500"
            }`}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mt-3 text-[12px] text-red-500 bg-red-50 dark:bg-red-500/10 px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 w-full">
      <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#10b981"
          strokeWidth="1.5"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <h3 className="text-[15px] font-semibold text-gray-800 dark:text-white mb-1">
        No Reconciliations
      </h3>
      <p
        className="text-[13px] text-gray-500 dark:text-white/40 leading-relaxed text-center"
        style={{ maxWidth: "24rem" }}
      >
        No bank accounts with reconciliation data found for this period. AI will automatically
        create reconciliations when bank statements are imported.
      </p>
    </div>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden bg-white dark:bg-[#111827]">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="px-4 py-4 border-b border-[#e2e8f0] dark:border-white/10 last:border-b-0"
        >
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-white/5 animate-pulse" />
            <div className="flex-1">
              <div className="w-40 h-4 rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
              <div className="w-24 h-3 rounded bg-gray-100 dark:bg-white/5 animate-pulse mt-1" />
            </div>
            <div className="flex gap-2">
              {Array.from({ length: 12 }, (_, j) => (
                <div
                  key={j}
                  className="w-5 h-5 rounded-full bg-gray-100 dark:bg-white/5 animate-pulse"
                />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
