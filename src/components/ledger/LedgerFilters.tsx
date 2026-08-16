/**
 * LedgerFilters — Slide-in filter panel for the Ledger
 * filters with collapsible sections: Transaction Type, Status,
 * Source, Matched Status, Department, Location
 */
import { useState, useEffect, useRef } from "react";
import type { TransactionType, JournalStatus } from "../../db/validation/journals";

export type SourceType = "manual" | "import" | "invoice" | "bill" | "reconciliation" | "system";
export type MatchedStatus = "matched" | "unmatched";

// ============================================================================
// Types
// ============================================================================

interface PartyOption {
  id: string;
  name: string;
  partyType: string;
}

interface DimensionOption {
  id: string;
  name: string;
}

interface LedgerFiltersProps {
  isOpen: boolean;
  onClose: () => void;
  typeFilter: TransactionType[];
  statusFilter: JournalStatus[];
  sourceFilter: SourceType[];
  matchedFilter: MatchedStatus[];
  amountMin: string;
  amountMax: string;
  partyFilter: string[];
  partyOptions: PartyOption[];
  partySearch: string;
  onPartySearchChange: (q: string) => void;
  onToggleParty: (id: string) => void;
  departmentFilter: string[];
  departmentOptions: DimensionOption[];
  departmentSearch: string;
  onDepartmentSearchChange: (q: string) => void;
  onToggleDepartment: (id: string) => void;
  locationFilter: string[];
  locationOptions: DimensionOption[];
  locationSearch: string;
  onLocationSearchChange: (q: string) => void;
  onToggleLocation: (id: string) => void;
  onToggleType: (type: TransactionType) => void;
  onToggleStatus: (status: JournalStatus) => void;
  onToggleSource: (source: SourceType) => void;
  onToggleMatched: (status: MatchedStatus) => void;
  onAmountChange: (min: string, max: string) => void;
  onClearAll: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const TYPES: { value: TransactionType; label: string; icon: string }[] = [
  { value: "pay_in", label: "Pay In", icon: "↓" },
  { value: "pay_out", label: "Pay Out", icon: "↑" },
  { value: "journal", label: "Journal", icon: "📋" },
  { value: "transfer", label: "Transfer", icon: "⇄" },
];

const STATUSES: { value: JournalStatus; label: string; color: string }[] = [
  { value: "draft", label: "Unsettled", color: "#fbbf24" },
  { value: "posted", label: "Reconciled", color: "#22c55e" },
];

const SOURCES: { value: SourceType; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "import", label: "Import" },
  { value: "invoice", label: "Invoice" },
  { value: "bill", label: "Bill" },
  { value: "reconciliation", label: "Reconciliation" },
  { value: "system", label: "System" },
];

// ============================================================================
// Sub-components
// ============================================================================

/** Collapsible section header */
function FilterSection({
  title,
  icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-[#f1f5f9] dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-[#fafbfc] dark:hover:bg-slate-800 transition-colors"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#94a3b8"
          strokeWidth="2.5"
          className={`transition-transform duration-150 shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-[#64748b] dark:text-slate-400 shrink-0">{icon}</span>
        <span className="flex-1 text-[13px] font-semibold text-[#1e293b] dark:text-slate-100">
          {title}
        </span>
        {count != null && count > 0 && (
          <span className="w-5 h-5 rounded-full bg-[var(--color-app-header-teal)] text-white text-[10px] font-bold flex items-center justify-center shrink-0">
            {count}
          </span>
        )}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

/** Checkbox row for filter items */
function FilterCheckbox({
  label,
  checked,
  onChange,
  color,
  icon,
  highlighted,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  color?: string;
  icon?: React.ReactNode;
  highlighted?: boolean;
  testId?: string;
}) {
  return (
    <label
      data-testid={testId}
      className={`flex items-center gap-2.5 py-1.5 cursor-pointer group rounded-md px-1 -mx-1 transition-colors ${
        highlighted ? "bg-[#e6f7f5] dark:bg-teal-900/30" : ""
      }`}
    >
      {icon && (
        <span className="text-[#64748b] dark:text-slate-400 text-[14px] shrink-0">{icon}</span>
      )}
      {color && !icon && (
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      )}
      <span className="flex-1 text-[13px] text-[#374151] dark:text-slate-300 group-hover:text-[#1e293b] dark:group-hover:text-slate-100 transition-colors">
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-[18px] h-[18px] rounded cursor-pointer shrink-0"
        style={{ accentColor: "var(--color-app-header-teal)" }}
      />
    </label>
  );
}

// ============================================================================
// Icons
// ============================================================================

function PartyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function AmountIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  );
}

function SourceIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    </svg>
  );
}

function MatchedIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function DepartmentIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </svg>
  );
}

function LocationIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function TypeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

/** Inline party filter with search + grouped checkboxes */
function PartyFilterContent({
  partyFilter,
  partyOptions,
  partySearch,
  onPartySearchChange,
  onToggleParty,
}: {
  partyFilter: string[];
  partyOptions: PartyOption[];
  partySearch: string;
  onPartySearchChange: (q: string) => void;
  onToggleParty: (id: string) => void;
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // Sort parties alphabetically A-Z
  const sorted = [...partyOptions].sort((a, b) => a.name.localeCompare(b.name));

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightedIndex(sorted.length > 0 ? 0 : -1);
  }, [partySearch, sorted.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (sorted.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < sorted.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : sorted.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < sorted.length) {
        onToggleParty(sorted[highlightedIndex].id);
      }
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("label");
    items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div>
      {/* Search Input */}
      <div className="relative mb-2">
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-slate-500"
          width="12"
          height="12"
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
          value={partySearch}
          onChange={(e) => onPartySearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          data-testid="filter-party-search"
          placeholder="Search parties…"
          className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] dark:focus:ring-teal-500 dark:focus:border-teal-500 transition-colors"
        />
      </div>

      {/* Results — flat alphabetical list */}
      <div ref={listRef} className="max-h-[200px] overflow-y-auto -mx-1 px-1 thin-scrollbar">
        {sorted.length === 0 ? (
          <div className="text-[11px] text-[#94a3b8] dark:text-slate-500 italic py-2">
            {partySearch ? "No parties found" : "No parties available"}
          </div>
        ) : (
          sorted.map((p, i) => (
            <FilterCheckbox
              key={p.id}
              label={p.name}
              checked={partyFilter.includes(p.id)}
              onChange={() => onToggleParty(p.id)}
              testId={`filter-party-${p.id}`}
              highlighted={i === highlightedIndex}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Inline dimension filter (department/location) with search + checkboxes */
function DimensionFilterContent({
  filter,
  options,
  search,
  onSearchChange,
  onToggle,
  entityLabel,
  testIdPrefix,
}: {
  filter: string[];
  options: DimensionOption[];
  search: string;
  onSearchChange: (q: string) => void;
  onToggle: (id: string) => void;
  entityLabel: string;
  testIdPrefix?: string;
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = [...options].sort((a, b) => a.name.localeCompare(b.name));

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightedIndex(sorted.length > 0 ? 0 : -1);
  }, [search, sorted.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (sorted.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < sorted.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : sorted.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < sorted.length) {
        onToggle(sorted[highlightedIndex].id);
      }
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("label");
    items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div>
      {/* Search Input */}
      <div className="relative mb-2">
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-slate-500"
          width="12"
          height="12"
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
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          data-testid={testIdPrefix ? `${testIdPrefix}-search` : "filter-search"}
          placeholder={`Search ${entityLabel}…`}
          className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] dark:focus:ring-teal-500 dark:focus:border-teal-500 transition-colors"
        />
      </div>

      {/* Results */}
      <div ref={listRef} className="max-h-[200px] overflow-y-auto -mx-1 px-1 thin-scrollbar">
        {sorted.length === 0 ? (
          <div className="text-[11px] text-[#94a3b8] dark:text-slate-500 italic py-2">
            {search ? `No ${entityLabel} found` : `No ${entityLabel} configured`}
          </div>
        ) : (
          sorted.map((d, i) => (
            <FilterCheckbox
              key={d.id}
              label={d.name}
              checked={filter.includes(d.id)}
              onChange={() => onToggle(d.id)}
              testId={testIdPrefix ? `${testIdPrefix}-${d.id}` : undefined}
              highlighted={i === highlightedIndex}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Searchable checkbox list with search input + arrow key nav + Enter toggle */
interface CheckboxItem {
  value: string;
  label: string;
  icon?: string;
  color?: string;
}

function SearchableCheckboxList({
  items,
  selected,
  onToggle,
  entityLabel,
  renderIcon,
  renderColor,
  testIdPrefix,
}: {
  items: CheckboxItem[];
  selected: string[];
  onToggle: (value: string) => void;
  entityLabel: string;
  renderIcon?: (item: CheckboxItem) => React.ReactNode;
  renderColor?: (item: CheckboxItem) => string | undefined;
  testIdPrefix?: string;
}) {
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = search
    ? items.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()))
    : items;

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightedIndex(filtered.length > 0 ? 0 : -1);
  }, [search, filtered.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
        onToggle(filtered[highlightedIndex].value);
      }
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("label");
    items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div>
      {/* Search Input */}
      <div className="relative mb-2">
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-slate-500"
          width="12"
          height="12"
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
          onKeyDown={handleKeyDown}
          data-testid={testIdPrefix ? `${testIdPrefix}-search` : "filter-search"}
          placeholder={`Search ${entityLabel}…`}
          className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] dark:focus:ring-teal-500 dark:focus:border-teal-500 transition-colors"
        />
      </div>

      {/* Results */}
      <div ref={listRef} className="max-h-[200px] overflow-y-auto -mx-1 px-1 thin-scrollbar">
        {filtered.length === 0 ? (
          <div className="text-[11px] text-[#94a3b8] dark:text-slate-500 italic py-2">
            {search ? `No ${entityLabel} found` : `No ${entityLabel} available`}
          </div>
        ) : (
          filtered.map((item, i) => (
            <FilterCheckbox
              key={item.value}
              label={item.label}
              icon={renderIcon?.(item)}
              color={renderColor?.(item)}
              checked={selected.includes(item.value)}
              onChange={() => onToggle(item.value)}
              testId={testIdPrefix ? `${testIdPrefix}-${item.value}` : undefined}
              highlighted={i === highlightedIndex}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export default function LedgerFilters({
  isOpen,
  onClose,
  typeFilter,
  statusFilter,
  sourceFilter,
  matchedFilter,
  amountMin,
  amountMax,
  partyFilter,
  partyOptions,
  partySearch,
  onPartySearchChange,
  onToggleParty,
  departmentFilter,
  departmentOptions,
  departmentSearch,
  onDepartmentSearchChange,
  onToggleDepartment,
  locationFilter,
  locationOptions,
  locationSearch,
  onLocationSearchChange,
  onToggleLocation,
  onToggleType,
  onToggleStatus,
  onToggleSource,
  onToggleMatched,
  onAmountChange,
  onClearAll,
}: LedgerFiltersProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      // If clicking outside the filter panel, close it
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Also check if the click target is the filter toggle button (it has its own toggle logic)
        const target = e.target as HTMLElement;
        if (target.closest("[data-ignore-click-outside]")) return;

        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [isOpen, onClose]);

  const hasFilters =
    typeFilter.length > 0 ||
    statusFilter.length > 0 ||
    sourceFilter.length > 0 ||
    matchedFilter.length > 0 ||
    partyFilter.length > 0 ||
    departmentFilter.length > 0 ||
    locationFilter.length > 0 ||
    amountMin !== "" ||
    amountMax !== "";

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      data-testid="filter-panel"
      className="absolute right-0 top-full mt-1 w-[280px] bg-white dark:bg-slate-900 border border-[#e5e7eb] dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#f1f5f9] dark:border-slate-800">
        <span className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100">
          Filters
        </span>
        <div className="flex items-center gap-2">
          {hasFilters && (
            <button
              type="button"
              onClick={onClearAll}
              className="text-[11px] text-[var(--color-app-header-teal)] hover:text-[#248f82] font-medium transition-colors"
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Scrollable sections */}
      <div className="max-h-[60vh] overflow-y-auto thin-scrollbar">
        {/* Party */}
        <FilterSection title="Party" icon={<PartyIcon />} count={partyFilter.length} defaultOpen>
          <PartyFilterContent
            partyFilter={partyFilter}
            partyOptions={partyOptions}
            partySearch={partySearch}
            onPartySearchChange={onPartySearchChange}
            onToggleParty={onToggleParty}
          />
        </FilterSection>

        {/* Amount */}
        <FilterSection title="Amount" icon={<AmountIcon />} count={amountMin || amountMax ? 1 : 0}>
          <div className="flex items-center gap-2 py-1">
            <div className="flex-1">
              <label className="text-[10px] text-[#94a3b8] dark:text-slate-500 font-medium mb-0.5 block">
                Min
              </label>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-[#94a3b8] dark:text-slate-500">
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountMin}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.,]/g, "");
                    onAmountChange(v, amountMax);
                  }}
                  placeholder="0.00"
                  className="w-full pl-5 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] dark:focus:ring-teal-500 dark:focus:border-teal-500 transition-colors"
                />
              </div>
            </div>
            <span className="text-[12px] text-[#94a3b8] mt-4">—</span>
            <div className="flex-1">
              <label className="text-[10px] text-[#94a3b8] dark:text-slate-500 font-medium mb-0.5 block">
                Max
              </label>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-[#94a3b8] dark:text-slate-500">
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountMax}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.,]/g, "");
                    onAmountChange(amountMin, v);
                  }}
                  placeholder="0.00"
                  className="w-full pl-5 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] dark:focus:ring-teal-500 dark:focus:border-teal-500 transition-colors"
                />
              </div>
            </div>
          </div>
        </FilterSection>

        {/* Source */}
        <FilterSection title="Source" icon={<SourceIcon />} count={sourceFilter.length}>
          {SOURCES.map((s) => (
            <FilterCheckbox
              key={s.value}
              label={s.label}
              checked={sourceFilter.includes(s.value)}
              onChange={() => onToggleSource(s.value)}
            />
          ))}
        </FilterSection>

        {/* Matched Status */}
        <FilterSection title="Matched Status" icon={<MatchedIcon />} count={matchedFilter.length}>
          <FilterCheckbox
            label="Matched"
            checked={matchedFilter.includes("matched")}
            onChange={() => onToggleMatched("matched")}
          />
          <FilterCheckbox
            label="Unmatched"
            checked={matchedFilter.includes("unmatched")}
            onChange={() => onToggleMatched("unmatched")}
          />
        </FilterSection>

        {/* Department */}
        <FilterSection title="Department" icon={<DepartmentIcon />} count={departmentFilter.length}>
          <DimensionFilterContent
            filter={departmentFilter}
            options={departmentOptions}
            search={departmentSearch}
            onSearchChange={onDepartmentSearchChange}
            onToggle={onToggleDepartment}
            entityLabel="departments"
            testIdPrefix="filter-dept"
          />
        </FilterSection>

        {/* Location */}
        <FilterSection title="Location" icon={<LocationIcon />} count={locationFilter.length}>
          <DimensionFilterContent
            filter={locationFilter}
            options={locationOptions}
            search={locationSearch}
            onSearchChange={onLocationSearchChange}
            onToggle={onToggleLocation}
            entityLabel="locations"
            testIdPrefix="filter-loc"
          />
        </FilterSection>

        {/* Transaction Type */}
        <FilterSection
          title="Transaction Type"
          icon={<TypeIcon />}
          count={typeFilter.length}
          defaultOpen
        >
          <SearchableCheckboxList
            items={TYPES}
            selected={typeFilter}
            onToggle={(v) => onToggleType(v as TransactionType)}
            entityLabel="types"
            renderIcon={(t) => <span className="text-[12px]">{t.icon}</span>}
          />
        </FilterSection>

        {/* Status */}
        <FilterSection title="Status" icon={<MatchedIcon />} count={statusFilter.length}>
          {STATUSES.map((s) => (
            <FilterCheckbox
              key={s.value}
              label={s.label}
              color={s.color}
              checked={statusFilter.includes(s.value)}
              onChange={() => onToggleStatus(s.value)}
            />
          ))}
        </FilterSection>
      </div>
    </div>
  );
}
