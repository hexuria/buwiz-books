/**
 * LedgerSearchBar — Filter input with chip tags, List/Balances toggle and filter funnel icon
 * search toolbar with expandable filter chips
 */
import { useState, useRef, useEffect, useCallback } from "react";

// ============================================================================
// Types
// ============================================================================

export interface FilterChip {
  id: string;
  label: string;
  group?: string; // e.g. "category", "type", "status", "source"
}

interface LedgerSearchBarProps {
  transactionCount: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  allCollapsed: boolean;
  onToggleCollapse: () => void;
  onToggleFilters: () => void;
  hasActiveFilters: boolean;
  /** Active filter chips to display */
  filterChips?: FilterChip[];
  /** Callback to remove a chip by ID */
  onRemoveChip?: (chipId: string) => void;
  /** Callback to clear all filters */
  onClearAll?: () => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of visible lines before scrolling */
const MAX_VISIBLE_LINES = 4;
/** Approximate height of one line of chips (px) */
const LINE_HEIGHT = 32;

// ============================================================================
// Component
// ============================================================================

export default function LedgerSearchBar({
  transactionCount,
  searchQuery,
  onSearchChange,
  allCollapsed,
  onToggleCollapse,
  onToggleFilters,
  hasActiveFilters,
  filterChips = [],
  onRemoveChip,
  onClearAll,
}: LedgerSearchBarProps) {
  const [expanded, setExpanded] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const hasChips = filterChips.length > 0;

  // Detect if chips overflow one line
  useEffect(() => {
    if (!chipsRef.current) return;
    const el = chipsRef.current;
    // If the scroll height exceeds one line, we have overflow
    setIsOverflowing(el.scrollHeight > LINE_HEIGHT + 4);
  }, [filterChips]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Compute the max height for the chips container
  const chipsMaxHeight = expanded ? MAX_VISIBLE_LINES * LINE_HEIGHT : LINE_HEIGHT;

  if (!hasChips) {
    // Simple single-line search bar (original layout)
    return (
      <div className="flex items-center gap-2 px-5 py-2 border-b border-[#e5e7eb] dark:border-slate-700">
        {/* Search input */}
        <div className="relative flex-1 transition-all">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-slate-500"
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
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            data-testid="search-input"
            placeholder={`Filter ${transactionCount} transaction${transactionCount !== 1 ? "s" : ""}...`}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-[#f8fafc] dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[13px] text-[#1e293b] dark:text-slate-100 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:border-[var(--color-app-header-teal)] dark:focus:border-teal-500 focus:ring-1 focus:ring-[var(--color-app-header-teal)] dark:focus:ring-teal-500 transition-all"
          />
        </div>

        {/* View toggle + Filter button */}
        <ViewToggle allCollapsed={allCollapsed} onToggleCollapse={onToggleCollapse} />
        <FilterButton onToggle={onToggleFilters} active={hasActiveFilters} />
      </div>
    );
  }

  // With chips: multi-line expandable search bar
  return (
    <div className="border-b border-[#e5e7eb] dark:border-slate-700">
      {/* Top row: Panel toggle + search icon + chips + controls */}
      <div className="flex items-start gap-2 px-5 py-2">
        {/* Search icon */}
        <div className="h-8 flex items-center shrink-0">
          <svg
            className="text-[#94a3b8] dark:text-slate-500"
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
        </div>

        {/* Chips + inline search */}
        <div className="flex-1 min-w-0">
          <div
            ref={chipsRef}
            className="flex flex-wrap items-center gap-1.5 overflow-hidden transition-all duration-200"
            style={{ maxHeight: chipsMaxHeight, overflowY: expanded ? "auto" : "hidden" }}
          >
            {filterChips.map((chip) => (
              <span
                key={chip.id}
                data-testid={`filter-chip-${chip.id}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#e6f7f5] dark:bg-teal-950/60 text-[var(--color-app-header-teal)] dark:text-teal-400 border border-[#b2e0db] dark:border-teal-800 whitespace-nowrap"
              >
                {chip.label}
                {onRemoveChip && (
                  <button
                    type="button"
                    onClick={() => onRemoveChip(chip.id)}
                    className="flex items-center justify-center w-3.5 h-3.5 rounded-full text-[#7cc8bf] dark:text-teal-500 hover:text-[var(--color-app-header-teal)] dark:hover:text-teal-300 hover:bg-[#ccece8] dark:hover:bg-teal-900/40 transition-colors"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </span>
            ))}

            {/* Inline text search input at end of chips */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              data-testid="search-input"
              placeholder={`Filter ${transactionCount} transaction${transactionCount !== 1 ? "s" : ""}...`}
              className="flex-1 min-w-[120px] py-0.5 bg-transparent text-base sm:text-[13px] text-[#1e293b] dark:text-slate-100 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Expand chevron (when overflowing) */}
        {isOverflowing && (
          <button
            type="button"
            onClick={toggleExpanded}
            className="h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 w-6 flex items-center justify-center text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300 transition-colors"
            title={expanded ? "Collapse filters" : "Expand filters"}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={`transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}

        {/* Clear button */}
        {onClearAll && (
          <div className="h-8 flex items-center shrink-0">
            <button
              type="button"
              onClick={onClearAll}
              className="px-2.5 text-[11px] font-semibold text-[var(--color-app-header-teal)] hover:text-[#248f82] dark:text-teal-400 dark:hover:text-teal-300 transition-colors whitespace-nowrap"
            >
              Clear
            </button>
          </div>
        )}

        {/* View toggle + Filter button */}
        <div className="h-8 flex items-center gap-1.5 shrink-0">
          <ViewToggle allCollapsed={allCollapsed} onToggleCollapse={onToggleCollapse} />
          <FilterButton onToggle={onToggleFilters} active={hasActiveFilters} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function ViewToggle({
  allCollapsed,
  onToggleCollapse,
}: {
  allCollapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div className="flex items-center bg-[#f1f5f9] dark:bg-slate-800 rounded-lg p-0.5">
      <button
        type="button"
        onClick={() => {
          if (allCollapsed) onToggleCollapse();
        }}
        className={`w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-md flex items-center justify-center transition-all duration-150 ${
          !allCollapsed
            ? "bg-white dark:bg-slate-700 text-[#1e293b] dark:text-slate-100 shadow-sm"
            : "text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300"
        }`}
        title="Expand all"
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
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => {
          if (!allCollapsed) onToggleCollapse();
        }}
        className={`w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-md flex items-center justify-center transition-all duration-150 ${
          allCollapsed
            ? "bg-white dark:bg-slate-700 text-[#1e293b] dark:text-slate-100 shadow-sm"
            : "text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300"
        }`}
        title="Collapse all (balances only)"
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
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>
    </div>
  );
}

function FilterButton({ onToggle, active }: { onToggle: () => void; active: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-ignore-click-outside
      data-testid="filter-toggle"
      className={`w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-[#ccece8] dark:bg-teal-900/40 text-[var(--color-app-header-teal)] dark:text-teal-400"
          : "text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-800"
      }`}
      title="Filters"
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
      >
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
      </svg>
    </button>
  );
}
