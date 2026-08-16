import React, { useState, useRef, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import type { FilterState } from "./FilterPanel";
import { FilterChips, FilterDrawer } from "./FilterPanel";

// ============================================================================
// Types
// ============================================================================

interface CategoryManagerLayoutProps {
  children: React.ReactNode;
  sidePanel?: React.ReactNode;
  /** "empty" = Filter by Type (hidden on mobile), "view" = detail, "form" = create/edit */
  sidePanelMode?: "empty" | "view" | "form";
  onMobilePanelClose?: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showNewButton?: boolean;
  onNewClick?: () => void;
  onImportClick?: () => void;
  onUseTemplateClick?: () => void;
  onAiCustomizeClick?: () => void;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  onClearAll?: () => void;
  availableSubtypes: string[];
}

// ============================================================================
// New Category Dropdown
// ============================================================================

const NewCategoryDropdown: React.FC<{
  onNewClick?: () => void;
  onImportClick?: () => void;
  onUseTemplateClick?: () => void;
  onAiCustomizeClick?: () => void;
}> = ({ onNewClick, onImportClick, onUseTemplateClick, onAiCustomizeClick }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <div className="inline-flex shrink-0 items-stretch rounded-full bg-teal-600 shadow-md shadow-teal-600/25">
        {/* Main button. Below `sm` the label is dropped and this becomes a round icon button —
            the label cannot shrink, so at 375px it used to wrap to two lines and drag the whole
            header out of shape. `aria-label` keeps the accessible name intact either way. */}
        <button
          // Must match the visible label character for character. An `aria-label` REPLACES the
          // element's text content as the accessible name, so "New category" here would leave a
          // button reading "New Category" and announcing something else — which fails WCAG 2.5.3
          // (Label in Name) and breaks voice control, where the user says what they can see.
          aria-label="New Category"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-l-full px-3 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-teal-700 sm:pr-3 sm:pl-5"
          onClick={onNewClick}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="hidden sm:inline">New Category</span>
        </button>
        {/* Divider */}
        <div className="w-px bg-teal-500/50 my-1.5" />
        {/* Chevron button */}
        <button
          type="button"
          aria-label="More category options"
          aria-expanded={open}
          aria-haspopup="menu"
          className="inline-flex min-h-11 cursor-pointer items-center rounded-r-full px-3 text-white transition-colors hover:bg-teal-700"
          onClick={() => setOpen(!open)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="opacity-80"
          >
            <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
          </svg>
        </button>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 bg-white dark:bg-slate-800 rounded-xl shadow-lg shadow-black/10 border border-gray-100 dark:border-slate-700 overflow-hidden z-50 min-w-[200px]">
          <button
            className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer text-left"
            onClick={() => {
              setOpen(false);
              onImportClick?.();
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-slate-400"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Import Categories…
          </button>
          <button
            className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer text-left border-t border-gray-100 dark:border-slate-700"
            onClick={() => {
              setOpen(false);
              onUseTemplateClick?.();
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-slate-400"
            >
              <path d="M3 3h18v4H3zM3 10h18v4H3zM3 17h18v4H3z" />
            </svg>
            Apply a template…
          </button>
          <button
            className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer text-left"
            onClick={() => {
              setOpen(false);
              onAiCustomizeClick?.();
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-slate-400"
            >
              <path d="M12 3l1.9 5.8L20 10.7l-5 3.6 1.8 5.7L12 16.6 7.2 20l1.8-5.7-5-3.6 6.1-1.9z" />
            </svg>
            Customize with AI…
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const CategoryManagerLayout: React.FC<CategoryManagerLayoutProps> = ({
  children,
  sidePanel,
  sidePanelMode = "empty",
  onMobilePanelClose,
  searchValue,
  onSearchChange,
  showNewButton = true,
  onNewClick,
  onImportClick,
  onUseTemplateClick,
  onAiCustomizeClick,
  filters,
  onFiltersChange,
  onClearAll,
  availableSubtypes,
}) => {
  const showMobilePanel = sidePanelMode === "view" || sidePanelMode === "form";
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  // Show Clear whenever any filter chip is visible
  const hasActiveFilters =
    filters.status.length > 0 || filters.types.length > 0 || filters.subtypes.length > 0;

  const clearAll = () => {
    onFiltersChange({ status: ["active"], types: [], subtypes: [] });
    onClearAll?.();
  };

  return (
    <div className="app-page-bg h-full flex flex-col overflow-hidden">
      {/* Top Navigation — always visible */}
      <div className="mx-auto flex min-h-[56px] w-full max-w-[1132px] shrink-0 items-center justify-between gap-2 px-3 py-2 sm:min-h-[65px] sm:px-6 sm:py-3">
        <Link
          to="/"
          aria-label="Back to Dashboard"
          // Icon-only below `sm`, so the box has to be sized explicitly — otherwise it collapses
          // to the 14px height of the chevron and stops being tappable.
          className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg text-sm font-medium whitespace-nowrap text-slate-700 no-underline transition-colors hover:text-teal-700 sm:min-w-0 sm:justify-start"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {/* The drawer and bottom tab bar already carry navigation on mobile, so the label here
              is redundant weight competing with the primary action for 375px of header. */}
          <span className="hidden sm:inline">Back to Dashboard</span>
        </Link>

        {showNewButton && (
          <NewCategoryDropdown
            onNewClick={onNewClick}
            onImportClick={onImportClick}
            onUseTemplateClick={onUseTemplateClick}
            onAiCustomizeClick={onAiCustomizeClick}
          />
        )}
      </div>

      {/* Two-Panel Layout — fills remaining height */}
      <div className="mx-auto flex w-full max-w-[1132px] min-h-0 flex-1 items-stretch gap-6 px-3 pb-3 sm:px-6 sm:pb-6">
        {/* Main Panel — scrolls internally */}
        <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden flex-1 min-w-0 relative flex flex-col max-h-full">
          {/* Card Header */}
          <div className="bg-[var(--color-app-header-teal)] text-white px-5 py-4 flex items-center gap-3 font-semibold text-base shrink-0">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            <span>Category Manager</span>
          </div>

          {/* Search Bar with Filter Trigger + Chips */}
          <div className="flex flex-wrap items-center gap-1.5 py-3 px-4 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 shrink-0">
            {/* Filter toggle button */}
            <button
              ref={filterBtnRef}
              type="button"
              onClick={() => setFilterOpen(!filterOpen)}
              className={`flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-none transition-colors lg:h-auto lg:w-auto lg:p-1.5 ${
                filterOpen
                  ? "bg-teal-50 text-teal-600"
                  : "bg-transparent text-slate-500 hover:text-teal-600"
              }`}
              title="Filters"
              aria-label="Filters"
              aria-expanded={filterOpen}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
            </button>

            {/* Active filter chips */}
            <FilterChips filters={filters} onChange={onFiltersChange} />

            {/* Search input */}
            <input
              type="text"
              // `text-base` (16px) below `sm`: a smaller font makes iOS Safari zoom the viewport
              // on focus and never restore it. `h-11` gives the field a real tap area — it was
              // a 20px-tall bare input.
              className="h-11 min-w-[100px] flex-1 border-none bg-transparent text-base text-[var(--color-app-text-navy)] outline-none placeholder:text-[var(--color-app-text-light)] sm:text-sm"
              placeholder="Lookup category..."
              value={searchValue}
              onChange={(e) => onSearchChange?.(e.target.value)}
              aria-label="Lookup category"
            />

            {/* Clear all button */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAll}
                className="h-11 shrink-0 cursor-pointer border-none bg-transparent px-2 text-xs font-semibold whitespace-nowrap text-teal-600 transition-colors hover:text-teal-700"
              >
                Clear
              </button>
            )}
          </div>

          {/* Filter Popover (floating context menu) */}
          <FilterDrawer
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            filters={filters}
            onChange={onFiltersChange}
            availableSubtypes={availableSubtypes}
            anchorRef={filterBtnRef}
          />

          {/* Category List — scrollable */}
          <div className="overflow-y-auto flex-1 bg-white dark:bg-slate-900">{children}</div>
        </div>

        {/* Side Panel — desktop only, hidden on mobile */}
        <div className="hidden lg:block shrink-0 w-[340px]">{sidePanel}</div>
      </div>

      {/* Mobile Slide-Over — full screen overlay for view/edit/create */}
      {showMobilePanel && (
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30 transition-opacity"
            onClick={onMobilePanelClose}
            onKeyDown={(e) => e.key === "Escape" && onMobilePanelClose?.()}
            role="button"
            tabIndex={-1}
            aria-label="Close panel"
          />
          {/* Panel — slides from right */}
          <div className="pt-safe absolute inset-y-0 right-0 flex w-full max-w-[400px] flex-col bg-[var(--color-app-page-bg,#e8f0f2)] shadow-2xl animate-[slideInRight_0.2s_ease-out] dark:bg-slate-900">
            {/* Close button */}
            <div className="flex shrink-0 items-center px-2 py-1">
              <button
                type="button"
                onClick={onMobilePanelClose}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg border-none bg-transparent px-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back
              </button>
            </div>
            {/* Content */}
            <div className="pb-safe-3 flex-1 overflow-y-auto px-3">{sidePanel}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CategoryManagerLayout;
