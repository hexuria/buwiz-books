/**
 * BillFilters — Slide-in filter panel for the Bills list
 * filters with collapsible sections: Status, Amount, Date Range, Overdue
 */
import { useState, useEffect, useRef } from "react";

// ============================================================================
// Types
// ============================================================================

interface BillFiltersProps {
  isOpen: boolean;
  onClose: () => void;
  activeStatuses: string[];
  dateFilter: string;
  amountMin: string;
  amountMax: string;
  overdueOnly: boolean;
  onToggleStatus: (status: string) => void;
  onDateFilterChange: (value: string) => void;
  onAmountChange: (min: string, max: string) => void;
  onToggleOverdue: () => void;
  onClearAll: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const BILL_STATUSES: { value: string; label: string; color: string }[] = [
  { value: "in_review", label: "In Review", color: "#10b981" },
  { value: "pending_approval", label: "Pending Approval", color: "#f59e0b" },
  { value: "awaiting_payment", label: "Awaiting Payment", color: "#8b5cf6" },
  { value: "paid", label: "Paid", color: "#3b82f6" },
  { value: "voided", label: "Voided", color: "#6b7280" },
];

const DATE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "30", label: "Past 30 Days" },
  { value: "90", label: "Past 90 Days" },
  { value: "180", label: "Past 6 Months" },
  { value: "365", label: "Past 1 Year" },
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
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  color?: string;
}) {
  return (
    <label className="flex items-center gap-2.5 py-1.5 cursor-pointer group">
      {color && (
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

function StatusIcon() {
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

function DateIcon() {
  return (
    <svg
      width="16"
      height="16"
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
  );
}

function OverdueIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

// ============================================================================
// Component
// ============================================================================

export default function BillFilters({
  isOpen,
  onClose,
  activeStatuses,
  dateFilter,
  amountMin,
  amountMax,
  overdueOnly,
  onToggleStatus,
  onDateFilterChange,
  onAmountChange,
  onToggleOverdue,
  onClearAll,
}: BillFiltersProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (target.closest("[data-ignore-click-outside]")) return;
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);

  const hasFilters =
    activeStatuses.length > 0 ||
    dateFilter !== "all" ||
    amountMin !== "" ||
    amountMax !== "" ||
    overdueOnly;

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
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
      <div className="max-h-[60vh] overflow-y-auto">
        {/* Status */}
        <FilterSection
          title="Status"
          icon={<StatusIcon />}
          count={activeStatuses.length}
          defaultOpen
        >
          {BILL_STATUSES.map((s) => (
            <FilterCheckbox
              key={s.value}
              label={s.label}
              color={s.color}
              checked={activeStatuses.includes(s.value)}
              onChange={() => onToggleStatus(s.value)}
            />
          ))}
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
                  className="w-full pl-5 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] transition-colors"
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
                  className="w-full pl-5 pr-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:border-[var(--color-app-header-teal)] transition-colors"
                />
              </div>
            </div>
          </div>
        </FilterSection>

        {/* Date Range */}
        <FilterSection title="Date Range" icon={<DateIcon />} count={dateFilter !== "all" ? 1 : 0}>
          {DATE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2.5 py-1.5 cursor-pointer group"
            >
              <span className="flex-1 text-[13px] text-[#374151] dark:text-slate-300 group-hover:text-[#1e293b] dark:group-hover:text-slate-100 transition-colors">
                {opt.label}
              </span>
              <input
                type="radio"
                name="billDateFilter"
                checked={dateFilter === opt.value}
                onChange={() => onDateFilterChange(opt.value)}
                className="w-[18px] h-[18px] cursor-pointer shrink-0"
                style={{ accentColor: "var(--color-app-header-teal)" }}
              />
            </label>
          ))}
        </FilterSection>

        {/* Overdue */}
        <FilterSection title="Overdue Only" icon={<OverdueIcon />} count={overdueOnly ? 1 : 0}>
          <FilterCheckbox
            label="Show only overdue bills"
            checked={overdueOnly}
            onChange={onToggleOverdue}
          />
        </FilterSection>
      </div>
    </div>
  );
}
