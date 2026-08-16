import React, { useState, useRef, useEffect, useCallback } from "react";

export interface FilterChip {
  id: string;
  label: string;
  group?: string;
}

interface ReconciliationSearchBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  matchedCount: number;
  unmatchedCount: number;
  onToggleFilters: () => void;
  onAddTransaction?: () => void;
  hasActiveFilters?: boolean;
  filterChips?: FilterChip[];
  onRemoveChip?: (chipId: string) => void;
  onClearAll?: () => void;
  /** Active status filter: 'all' | 'reconciled' | 'unsettled' */
  statusFilter?: string;
  /** Called when user clicks a counter to toggle status filter */
  onToggleStatusFilter?: (status: string) => void;
}

/** Maximum number of visible lines before scrolling */
const MAX_VISIBLE_LINES = 4;
/** Approximate height of one line of chips (px) */
const LINE_HEIGHT = 28;

export default function ReconciliationSearchBar({
  searchQuery,
  onSearchChange,
  matchedCount,
  unmatchedCount,
  onToggleFilters,
  onAddTransaction,
  hasActiveFilters = false,
  filterChips = [],
  onRemoveChip,
  onClearAll,
  statusFilter = "all",
  onToggleStatusFilter,
}: ReconciliationSearchBarProps) {
  const [expanded, setExpanded] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const hasChips = filterChips.length > 0;

  // Detect if chips overflow one line
  useEffect(() => {
    if (!chipsRef.current) return;
    const el = chipsRef.current;
    setIsOverflowing(el.scrollHeight > LINE_HEIGHT + 4);
  }, [filterChips]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const chipsMaxHeight = expanded ? MAX_VISIBLE_LINES * LINE_HEIGHT : LINE_HEIGHT;

  return (
    <div className="px-4 py-2.5 border-b border-gray-100 dark:border-white/5 shrink-0 bg-white dark:bg-[#111820]">
      <div className="flex items-start gap-2">
        {/* Search Icon */}
        <div className="h-8 flex items-center shrink-0">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-gray-300 dark:text-white/20"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        {/* Chips + Buttons container — float lets inline chips wrap around buttons */}
        <div className="flex-1 min-w-0">
          <div
            ref={chipsRef}
            className="overflow-hidden transition-all duration-200"
            style={{
              maxHeight: chipsMaxHeight,
              overflowY: expanded ? "auto" : "hidden",
            }}
          >
            {/* Action buttons — floated right so chips wrap around them */}
            <div className="float-right flex items-center gap-1.5 h-6 ml-2 pl-1">
              {/* Expand chevron (when overflowing) */}
              {isOverflowing && (
                <button
                  type="button"
                  onClick={toggleExpanded}
                  className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50 transition-colors"
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
              {onClearAll && (hasActiveFilters || searchQuery) && (
                <button
                  type="button"
                  onClick={onClearAll}
                  className="px-2 text-[11px] font-semibold text-[var(--color-app-header-teal)] hover:text-[#248f82] dark:text-teal-400 dark:hover:text-teal-300 transition-colors whitespace-nowrap"
                >
                  Clear
                </button>
              )}

              {/* Status Counters */}
              {/* Matched (Shield Tick) */}
              <button
                type="button"
                title="Filter reconciled"
                onClick={() =>
                  onToggleStatusFilter?.(statusFilter === "reconciled" ? "all" : "reconciled")
                }
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-[#e6f4ea] dark:bg-emerald-500/10 border select-none h-full transition-all cursor-pointer ${
                  statusFilter === "reconciled"
                    ? "border-emerald-500 dark:border-emerald-400 ring-1 ring-emerald-500/30"
                    : "border-transparent hover:border-emerald-300 dark:hover:border-emerald-600"
                }`}
              >
                <span className="text-[12px] font-semibold text-[#1e8e3e] dark:text-emerald-400">
                  {matchedCount}
                </span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  fill="none"
                  viewBox="0 0 24 24"
                  className="text-[#1e8e3e] dark:text-emerald-400"
                >
                  <path
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="m9 11.5 2 2L15.5 9m4.5 3c0 4.909-5.354 8.479-7.302 9.615-.221.13-.332.194-.488.227a1.1 1.1 0 0 1-.42 0c-.156-.033-.267-.098-.488-.227C9.354 20.479 4 16.909 4 12V7.218c0-.8 0-1.2.13-1.543a2 2 0 0 1 .548-.79c.276-.242.65-.383 1.398-.664l5.362-2.01c.208-.078.312-.117.419-.133a1 1 0 0 1 .286 0c.107.016.21.055.419.133l5.362 2.01c.748.281 1.122.422 1.398.665a2 2 0 0 1 .547.789c.131.343.131.743.131 1.543z"
                  />
                </svg>
              </button>

              {/* Unmatched/Pending (Clock) */}
              <button
                type="button"
                title="Filter unsettled"
                onClick={() =>
                  onToggleStatusFilter?.(statusFilter === "unsettled" ? "all" : "unsettled")
                }
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-[#fef7e0] dark:bg-amber-500/10 border select-none h-full transition-all cursor-pointer ${
                  statusFilter === "unsettled"
                    ? "border-amber-500 dark:border-amber-400 ring-1 ring-amber-500/30"
                    : "border-transparent hover:border-amber-300 dark:hover:border-amber-600"
                }`}
              >
                <span className="text-[12px] font-semibold text-[#f9ab00] dark:text-amber-400">
                  {unmatchedCount}
                </span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  fill="none"
                  viewBox="0 0 24 24"
                  className="text-[#f9ab00] dark:text-amber-400"
                >
                  <path
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 6v6l4 2m6-2c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10"
                  />
                </svg>
              </button>

              {/* Filter Button */}
              <button
                type="button"
                data-ignore-click-outside
                onClick={onToggleFilters}
                className={`w-8 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-sm flex items-center justify-center transition-colors ${
                  hasActiveFilters
                    ? "bg-[#ccece8] dark:bg-teal-900/40 text-[var(--color-app-header-teal)] dark:text-teal-400"
                    : "text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50 hover:bg-gray-100 dark:hover:bg-white/5"
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
                >
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
              </button>

              {/* Add Button */}
              {onAddTransaction && (
                <button
                  type="button"
                  onClick={onAddTransaction}
                  className="w-8 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-sm flex items-center justify-center text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  title="Add transaction"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Inline chips — wrap around the floated buttons */}
            {filterChips.map((chip) => (
              <span
                key={chip.id}
                className="inline-flex items-center gap-1 align-middle mr-1.5 mb-0 px-2 rounded-full text-[11px] font-medium bg-[#e6f7f5] dark:bg-teal-950/60 text-[var(--color-app-header-teal)] dark:text-teal-400 border border-[#b2e0db] dark:border-teal-800 whitespace-nowrap"
              >
                {chip.label}
                {onRemoveChip && (
                  <button
                    type="button"
                    onClick={() => onRemoveChip(chip.id)}
                    className="flex items-center justify-center w-4 h-4 rounded-full text-[#7cc8bf] dark:text-teal-500 hover:text-[var(--color-app-header-teal)] dark:hover:text-teal-300 hover:bg-[#ccece8] dark:hover:bg-teal-900/40 transition-colors"
                  >
                    <svg
                      width="10"
                      height="10"
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

            {/* Inline search input at end of chips */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Backspace" &&
                  searchQuery === "" &&
                  filterChips.length > 0 &&
                  onRemoveChip
                ) {
                  e.preventDefault();
                  onRemoveChip(filterChips[filterChips.length - 1].id);
                }
              }}
              placeholder={hasChips ? "" : "Filter transactions…"}
              className="inline-block align-middle min-w-[120px] h-7 bg-transparent text-base sm:text-[13px] text-gray-700 dark:text-white/70 placeholder:text-gray-400 dark:placeholder:text-white/20 focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
