/**
 * DateRangeNavigator — Period selector with context-aware tabs
 *
 * Detects the selected period type and renders appropriate tabs:
 * - Month selected → month tabs (Jan, Feb, Mar…)
 * - Quarter selected → quarter tabs (Q1, Q2, Q3, Q4)
 * - Year selected → year tabs (2023, 2024, 2025…)
 * - Other ranges → month tabs (default)
 *
 * Uses SmartDateFilter for an enhanced combo box date picker.
 * Month tabs show lock/pencil icons based on close state.
 * Future periods are never shown.
 */

import { useState, useMemo, useRef, useEffect } from "react";
import SmartDateFilter from "../smart-date-filter/SmartDateFilter";
import {
  computePrevRange,
  computeNextRange,
  isPrevDisabled,
  isNextDisabled,
} from "../smart-date-filter/presets";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const SHORT_MONTHS = [
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

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isMonthClosed(year: number, month: number, closedDate: string | null): boolean {
  if (!closedDate) return false;
  const cd = new Date(closedDate + "T00:00:00");
  const lastDayOfMonth = new Date(year, month + 1, 0);
  return lastDayOfMonth <= cd;
}

function formatCloseDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Period type detection ───────────────────────────────────────────────────

type PeriodType = "month" | "quarter" | "year" | "none";

function detectPeriodType(dateFrom: string, dateTo: string): PeriodType {
  const f = new Date(dateFrom + "T00:00:00");
  const t = new Date(dateTo + "T00:00:00");

  // Year: Jan 1 – Dec 31
  if (
    f.getFullYear() === t.getFullYear() &&
    f.getMonth() === 0 &&
    f.getDate() === 1 &&
    t.getMonth() === 11 &&
    t.getDate() === 31
  ) {
    return "year";
  }

  // Quarter: 1st of quarter-start-month → last day of quarter-end-month
  if (f.getFullYear() === t.getFullYear() && f.getDate() === 1) {
    const qStart = Math.floor(f.getMonth() / 3) * 3;
    if (f.getMonth() === qStart) {
      const qEnd = qStart + 2;
      const qEndLastDay = new Date(f.getFullYear(), qEnd + 1, 0).getDate();
      if (t.getMonth() === qEnd && t.getDate() === qEndLastDay) {
        return "quarter";
      }
    }
  }

  // Month: 1st of month → last day of same month
  if (
    f.getFullYear() === t.getFullYear() &&
    f.getMonth() === t.getMonth() &&
    f.getDate() === 1 &&
    t.getDate() === new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()
  ) {
    return "month";
  }

  // Anything else (Today, Yesterday, Last 7 Days, Custom, etc.) → no tabs
  return "none";
}

// ─── Month helpers ───────────────────────────────────────────────────────────

interface MonthEntry {
  year: number;
  month: number;
  label: string;
  key: string;
  isToday: boolean;
}

function buildMonthList(centerYear: number, centerMonth: number, radius: number): MonthEntry[] {
  const entries: MonthEntry[] = [];
  const now = new Date();
  const maxYear = now.getFullYear();
  const maxMonth = now.getMonth();

  for (let i = -radius; i <= radius; i++) {
    const d = new Date(centerYear, centerMonth + i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    if (y > maxYear || (y === maxYear && m > maxMonth)) continue;
    entries.push({
      year: y,
      month: m,
      label: SHORT_MONTHS[m],
      key: `${y}-${String(m + 1).padStart(2, "0")}`,
      isToday: y === maxYear && m === maxMonth,
    });
  }
  return entries;
}

function monthKeyFromDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(year: number, month: number): { from: string; to: string } {
  return {
    from: formatLocalDate(new Date(year, month, 1)),
    to: formatLocalDate(new Date(year, month + 1, 0)),
  };
}

// ─── Quarter helpers ─────────────────────────────────────────────────────────

interface QuarterEntry {
  year: number;
  quarter: number; // 1-4
  label: string;
  key: string;
  isToday: boolean;
}

function buildQuarterList(
  centerYear: number,
  centerQuarter: number,
  radius: number,
): QuarterEntry[] {
  const entries: QuarterEntry[] = [];
  const now = new Date();
  const maxYear = now.getFullYear();
  const maxQuarter = Math.floor(now.getMonth() / 3) + 1;

  for (let i = -radius; i <= radius; i++) {
    let q = centerQuarter + i;
    let y = centerYear;
    while (q < 1) {
      q += 4;
      y -= 1;
    }
    while (q > 4) {
      q -= 4;
      y += 1;
    }
    if (y > maxYear || (y === maxYear && q > maxQuarter)) continue;
    // Avoid duplicate entries
    const key = `${y}-Q${q}`;
    if (!entries.some((e) => e.key === key)) {
      entries.push({
        year: y,
        quarter: q,
        label: `Q${q}`,
        key,
        isToday: y === maxYear && q === maxQuarter,
      });
    }
  }
  return entries.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.quarter - b.quarter;
  });
}

function quarterKeyFromDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const startMonth = (quarter - 1) * 3;
  return {
    from: formatLocalDate(new Date(year, startMonth, 1)),
    to: formatLocalDate(new Date(year, startMonth + 3, 0)),
  };
}

// ─── Year helpers ────────────────────────────────────────────────────────────

interface YearEntry {
  year: number;
  label: string;
  key: string;
  isToday: boolean;
}

function buildYearList(centerYear: number, radius: number): YearEntry[] {
  const entries: YearEntry[] = [];
  const maxYear = new Date().getFullYear();

  for (let i = -radius; i <= radius; i++) {
    const y = centerYear + i;
    if (y > maxYear) continue;
    entries.push({
      year: y,
      label: String(y),
      key: String(y),
      isToday: y === maxYear,
    });
  }
  return entries;
}

function yearKeyFromDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return String(d.getFullYear());
}

function yearRange(year: number): { from: string; to: string } {
  return {
    from: formatLocalDate(new Date(year, 0, 1)),
    to: formatLocalDate(new Date(year, 11, 31)),
  };
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface DateRangeNavigatorProps {
  dateFrom: string;
  dateTo: string;
  onAddTransaction: () => void;
  onDateChange?: (from: string, to: string) => void;
  onManageClose?: () => void;
  onImportBankTransactions?: () => void;
  onImportJournalEntries?: () => void;
  onDownloadCSV?: () => void;
  onExportCSVToDocuments?: () => void;
  onDownloadFinancialPackage?: () => void;
  closedDate?: string | null;
  closedBy?: string | null;
  exportLoading?: "csv" | "csvDoc" | "package" | null;
}

export default function DateRangeNavigator({
  dateFrom,
  dateTo,
  onAddTransaction,
  onDateChange,
  onManageClose,
  onImportBankTransactions,
  onImportJournalEntries,
  onDownloadCSV,
  onExportCSVToDocuments,
  onDownloadFinancialPackage,
  closedDate = null,
  closedBy = null,
  exportLoading = null,
}: DateRangeNavigatorProps) {
  const periodType = detectPeriodType(dateFrom, dateTo);
  const fromDate = new Date(dateFrom + "T00:00:00");

  // ── Split-button dropdown (click-based, not hover) ────────────────────
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const splitBtnRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!splitMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (splitBtnRef.current && !splitBtnRef.current.contains(e.target as Node)) {
        setSplitMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [splitMenuOpen]);

  // ── Build tab list based on period type ─────────────────────────────────
  const RADIUS = 12;

  const { allEntries, selectedKey } = useMemo(() => {
    if (periodType === "year") {
      const entries = buildYearList(fromDate.getFullYear(), RADIUS);
      return { allEntries: entries, selectedKey: yearKeyFromDate(dateFrom) };
    }
    if (periodType === "quarter") {
      const q = Math.floor(fromDate.getMonth() / 3) + 1;
      const entries = buildQuarterList(fromDate.getFullYear(), q, RADIUS);
      return { allEntries: entries, selectedKey: quarterKeyFromDate(dateFrom) };
    }
    // Default: month
    const entries = buildMonthList(fromDate.getFullYear(), fromDate.getMonth(), RADIUS);
    return { allEntries: entries, selectedKey: monthKeyFromDate(dateFrom) };
  }, [dateFrom, dateTo, periodType]);

  // ── Scrollable tabs with overflow detection ─────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };

  useEffect(() => {
    // Scroll selected tab into view on mount and when selection changes
    const el = scrollRef.current;
    if (!el) return;
    const selectedEl = el.querySelector(`[data-tab-key="${selectedKey}"]`) as HTMLElement | null;
    if (selectedEl) {
      selectedEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
    // Wait for scroll to settle, then update overflow indicators
    const t = setTimeout(updateScrollState, 100);
    return () => clearTimeout(t);
  }, [selectedKey, allEntries]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState, { passive: true });
    // Also check on resize
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    updateScrollState();
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, []);

  const scrollLeft = () => scrollRef.current?.scrollBy({ left: -120, behavior: "smooth" });
  const scrollRight = () => scrollRef.current?.scrollBy({ left: 120, behavior: "smooth" });

  // ── Handle tab click ────────────────────────────────────────────────────
  const handleTabClick = (entry: (typeof allEntries)[number]) => {
    if (periodType === "year") {
      const range = yearRange((entry as YearEntry).year);
      onDateChange?.(range.from, range.to);
    } else if (periodType === "quarter") {
      const qe = entry as QuarterEntry;
      const range = quarterRange(qe.year, qe.quarter);
      onDateChange?.(range.from, range.to);
    } else {
      const me = entry as MonthEntry;
      const range = monthRange(me.year, me.month);
      onDateChange?.(range.from, range.to);
    }
  };

  // ── Hover popover ────────────────────────────────────────────────────────
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [hoveredCoords, setHoveredCoords] = useState<{ top: number; left: number } | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = (key: string, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredKey(key);
      setHoveredCoords({ top: rect.bottom, left: rect.left + rect.width / 2 });
    }, 400);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => setHoveredKey(null), 200);
  };

  // ── Shared styles ────────────────────────────────────────────────────────
  const smallChevronClass =
    "w-6 h-6 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors shrink-0";

  // ── Is the entry for the "current" period (month/quarter/year containing today)? ──
  const isCurrentPeriod = (entry: (typeof allEntries)[number]) => entry.isToday;

  // ── Is a month closed? Only applicable for month view ──
  const getIsClosed = (entry: (typeof allEntries)[number]) => {
    if (periodType !== "month") return false;
    const me = entry as MonthEntry;
    return isMonthClosed(me.year, me.month, closedDate);
  };

  return (
    <div className="flex min-w-0 items-center gap-2 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] px-2 py-2.5 sm:px-5 dark:from-[#145a30] dark:to-[#1e8c4c]">
      {/* Smart date filter with prev/next arrows.
          Not `shrink-0`: the arrows are 44px touch targets on mobile and the range label can read
          "Aug 1, 2025 – Jul 31, 2026", which together overflow a 375px row. Letting the group
          compress (and the label truncate) keeps the Add Transaction button on screen — it used
          to be clipped off the right edge with no way to reach it. */}
      <div className="flex min-w-0 shrink items-center gap-0 rounded-lg bg-white/10 sm:shrink-0">
        {/* Prev arrow */}
        <button
          type="button"
          disabled={isPrevDisabled(dateFrom, dateTo)}
          data-testid="date-prev"
          onClick={() => {
            if (onDateChange && !isPrevDisabled(dateFrom, dateTo)) {
              const prev = computePrevRange(dateFrom, dateTo);
              onDateChange(prev.from, prev.to);
            }
          }}
          className={`w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-l-lg transition-colors shrink-0 ${isPrevDisabled(dateFrom, dateTo) ? "text-white/20 cursor-not-allowed" : "text-white/70 hover:text-white hover:bg-white/10"}`}
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

        {/* SmartDateFilter — flat style, white text + icons (same wrapper as entity page) */}
        <SmartDateFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          onChange={onDateChange ?? (() => {})}
          hideChevron
          className="h-8 min-w-0 truncate rounded-none border-none bg-transparent px-2 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white"
        />

        {/* Next arrow */}
        <button
          type="button"
          disabled={isNextDisabled(dateFrom, dateTo)}
          data-testid="date-next"
          onClick={() => {
            if (onDateChange && !isNextDisabled(dateFrom, dateTo)) {
              const next = computeNextRange(dateFrom, dateTo);
              onDateChange(next.from, next.to);
            }
          }}
          className={`w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-r-lg transition-colors shrink-0 ${isNextDisabled(dateFrom, dateTo) ? "text-white/20 cursor-not-allowed" : "text-white/70 hover:text-white hover:bg-white/10"}`}
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

      {/* ── Context-aware tabs (fills remaining space) ── */}
      {periodType !== "none" ? (
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {/* Left scroll chevron */}
          {canScrollLeft && (
            <button
              type="button"
              onClick={scrollLeft}
              className={smallChevronClass}
              title="Earlier"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}

          {/* Tab buttons — naturally fills available space */}
          <div
            ref={scrollRef}
            className="flex items-center gap-1 overflow-x-auto scrollbar-hide p-1 pr-[100px]"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {allEntries.map((entry) => {
              const isSelected = entry.key === selectedKey;
              const isClosed = getIsClosed(entry);
              const isCurrent = isCurrentPeriod(entry);

              return (
                <div
                  key={entry.key}
                  data-tab-key={entry.key}
                  className="relative shrink-0"
                  onMouseEnter={(e) => isSelected && handleMouseEnter(entry.key, e)}
                  onMouseLeave={isSelected ? handleMouseLeave : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleTabClick(entry)}
                    className={`flex items-center gap-1 px-3 py-1 rounded-md text-[13px] font-medium transition-all whitespace-nowrap ${
                      isSelected
                        ? "bg-white/20 text-white shadow-sm border border-white/20"
                        : "text-white/50 hover:text-white hover:bg-white/10 border border-transparent"
                    }`}
                  >
                    {entry.label}
                    {/* "Today" badge for current period */}
                    {isCurrent && (
                      <span className="text-[9px] text-white/60 font-normal italic">Today</span>
                    )}
                    {/* Lock/pencil icon (month view only) */}
                    {periodType === "month" &&
                      (isClosed ? (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={isSelected ? "text-white" : "text-white/40"}
                        >
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      ) : (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={isSelected ? "text-white" : "text-white/30"}
                        >
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      ))}
                  </button>

                  {/* Hover popover — selected tab only. Uses fixed positioning to avoid being clipped by scroll container. */}
                  {isSelected && hoveredKey === entry.key && hoveredCoords && (
                    <div
                      className="fixed top-0 left-0 mt-2 w-52 bg-white dark:bg-slate-800 border border-[#e5e7eb] dark:border-slate-700 rounded-lg shadow-lg z-[9999] py-3 px-4 pointer-events-auto"
                      style={{
                        transform: "translateX(-50%)",
                        top: hoveredCoords.top,
                        left: hoveredCoords.left,
                      }}
                      onMouseEnter={() => {
                        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                      }}
                      onMouseLeave={handleMouseLeave}
                    >
                      <p className="text-[13px] font-semibold text-[#0f172a] dark:text-white mb-1.5">
                        Manage Close
                      </p>
                      {isClosed && closedDate ? (
                        <>
                          <p className="text-[11px] text-[#64748b] dark:text-slate-400 leading-relaxed">
                            Last Close Date:
                            <br />
                            <span className="font-medium text-[#0f172a] dark:text-slate-200">
                              {formatCloseDate(closedDate)}
                            </span>
                          </p>
                          {closedBy && (
                            <div className="flex items-center gap-1.5 mt-2">
                              <div className="w-5 h-5 rounded-full bg-[#6366f1] flex items-center justify-center text-white text-[9px] font-bold shrink-0">
                                {closedBy.charAt(0).toUpperCase()}
                              </div>
                              <span className="text-[11px] text-[#64748b] dark:text-slate-400">
                                {closedBy}
                              </span>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-[#64748b] dark:text-slate-400 leading-relaxed">
                          Close books to prevent any unwanted changes to your transactions.
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onManageClose?.();
                          setHoveredKey(null);
                        }}
                        className="w-full mt-3 text-center px-3 py-1.5 text-[12px] font-medium bg-[var(--color-app-header-teal)] text-white rounded-md hover:opacity-90 transition-opacity"
                      >
                        Manage Close
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right scroll chevron */}
          {/* Right scroll chevron — hide if current period is selected OR no more to scroll */}
          {canScrollRight &&
            !isCurrentPeriod(
              allEntries.find((e) => e.key === selectedKey) || allEntries[allEntries.length - 1],
            ) && (
              <button
                type="button"
                onClick={scrollRight}
                className={smallChevronClass}
                title="Later"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* ── Add Transaction split button ── */}
      <div
        className="relative flex items-stretch shrink-0 bg-white/10 rounded-lg h-8"
        ref={splitBtnRef}
      >
        {/* Main button — navigates to /transactions/new */}
        <button
          type="button"
          onClick={onAddTransaction}
          data-testid="add-transaction-btn"
          className="flex items-center gap-1.5 px-2.5 sm:px-3 hover:bg-white/10 text-white text-xs font-medium transition-colors whitespace-nowrap rounded-l-lg"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="hidden sm:inline">Add Transaction</span>
        </button>
        {/* Chevron — click to toggle dropdown */}
        <button
          type="button"
          onClick={() => setSplitMenuOpen((v) => !v)}
          className="flex items-center justify-center w-7 hover:bg-white/10 text-white transition-colors border-l border-white/20 rounded-r-lg"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {splitMenuOpen && (
          <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-slate-900 border border-[#e5e7eb] dark:border-slate-700 rounded-lg shadow-lg z-50 py-1">
            <button
              type="button"
              onClick={() => {
                setSplitMenuOpen(false);
                onImportBankTransactions?.();
              }}
              data-testid="import-bank-btn"
              className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 rounded-t-lg transition-colors flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#94a3b8] dark:text-slate-500"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import Bank Transactions…
            </button>
            <button
              type="button"
              onClick={() => {
                setSplitMenuOpen(false);
                onImportJournalEntries?.();
              }}
              data-testid="import-journal-btn"
              className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 rounded-b-lg transition-colors flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#94a3b8] dark:text-slate-500"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              Import Journal Entries…
            </button>
          </div>
        )}
      </div>

      {/* ── More menu ── */}
      <div className="relative group/more">
        <button
          type="button"
          data-testid="more-menu"
          className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          title="More options"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
          </svg>
        </button>
        <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-slate-900 border border-[#e5e7eb] dark:border-slate-700 rounded-lg shadow-lg opacity-0 invisible group-hover/more:opacity-100 group-hover/more:visible transition-all duration-150 z-50 py-1">
          <button
            type="button"
            onClick={onDownloadCSV}
            disabled={exportLoading === "csv"}
            data-testid="download-csv-btn"
            className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 transition-colors flex items-center gap-2.5 disabled:opacity-50"
          >
            {exportLoading === "csv" ? (
              <svg
                className="animate-spin w-3.5 h-3.5 text-[#94a3b8]"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeDasharray="31.42"
                  strokeDashoffset="10"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#94a3b8] dark:text-slate-500"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
            {exportLoading === "csv" ? "Downloading…" : "Download CSV"}
          </button>
          <button
            type="button"
            onClick={onExportCSVToDocuments}
            disabled={exportLoading === "csvDoc"}
            data-testid="export-csv-docs-btn"
            className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 transition-colors flex items-center gap-2.5 disabled:opacity-50"
          >
            {exportLoading === "csvDoc" ? (
              <svg
                className="animate-spin w-3.5 h-3.5 text-[#94a3b8]"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeDasharray="31.42"
                  strokeDashoffset="10"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#94a3b8] dark:text-slate-500"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            )}
            {exportLoading === "csvDoc" ? "Exporting…" : "Export CSV to Documents"}
          </button>
          <div className="border-t border-[#f1f5f9] dark:border-slate-700 my-1" />
          <button
            type="button"
            onClick={onDownloadFinancialPackage}
            data-testid="download-financial-pkg-btn"
            className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 transition-colors flex items-center gap-2.5"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[#94a3b8] dark:text-slate-500"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Download Financial Package…
          </button>
        </div>
      </div>
    </div>
  );
}
