import React, { useState, useEffect, useRef } from "react";
import type { AccountType } from "./CategoryRow";
import { subtypeLabel } from "../../lib/coa/subtype-labels";

// ============================================================================
// Types
// ============================================================================

export interface FilterState {
  status: string[];
  types: AccountType[];
  subtypes: string[];
}

export const emptyFilters: FilterState = {
  status: ["active"],
  types: [],
  subtypes: [],
};

interface FilterPanelProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  /** Available subtypes from the current data set */
  availableSubtypes: string[];
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "deactivated", label: "Deactivated" },
];

const TYPE_OPTIONS: { value: AccountType; label: string; color: string }[] = [
  { value: "asset", label: "Asset", color: "#2e7d32" },
  { value: "cost_of_revenue", label: "Cost of Revenue", color: "#4e342e" },
  { value: "equity", label: "Equity", color: "#6a1b9a" },
  { value: "expense", label: "Operating Expenses", color: "#c62828" },
  { value: "revenue", label: "Revenue", color: "#1565c0" },
  { value: "liability", label: "Liability", color: "#e65100" },
  { value: "other_expense", label: "Other Expenses", color: "#b71c1c" },
  { value: "other_income", label: "Other Income", color: "#00838f" },
];

// SVG Icons for filter sections
const StatusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" y1="9" x2="9.01" y2="9" />
    <line x1="15" y1="9" x2="15.01" y2="9" />
  </svg>
);

const TypeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
  </svg>
);

const SubtypeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);

// ============================================================================
// Collapsible Section
// ============================================================================

const Section: React.FC<{
  title: string;
  icon: React.ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, icon, count, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-gray-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-transparent border-none cursor-pointer font-semibold text-[0.85rem] text-slate-800 dark:text-slate-200"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {count != null && count > 0 && (
          <span className="bg-[#2a9d8f] text-white text-[0.7rem] font-bold rounded-full w-5 h-5 flex items-center justify-center">
            {count}
          </span>
        )}
      </button>
      {open && <div className="px-4 pb-3 pl-9">{children}</div>}
    </div>
  );
};

// ============================================================================
// Checkbox Row
// ============================================================================

const CheckboxRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  color?: string;
  icon?: React.ReactNode;
}> = ({ label, checked, onChange, color, icon }) => (
  <label className="flex items-center gap-2 py-1 cursor-pointer text-[0.85rem] text-gray-700 dark:text-slate-300">
    {icon && (
      <span style={{ color: color || "#64748b" }} className="flex items-center">
        {icon}
      </span>
    )}
    {color && !icon && (
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
    )}
    <span className="flex-1">{label}</span>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="w-[18px] h-[18px] accent-[#2a9d8f] cursor-pointer"
    />
  </label>
);

// ============================================================================
// Main Component
// ============================================================================

export const FilterPanel: React.FC<FilterPanelProps> = ({
  filters,
  onChange,
  availableSubtypes,
}) => {
  const toggleStatus = (value: string) => {
    // Radio-style: pick one or none. Clicking the active one deselects it (show all).
    const next = filters.status.includes(value) ? [] : [value];
    onChange({ ...filters, status: next });
  };

  const toggleType = (value: AccountType, checked: boolean) => {
    const next = checked ? [...filters.types, value] : filters.types.filter((t) => t !== value);
    onChange({ ...filters, types: next });
  };

  const toggleSubtype = (value: string, checked: boolean) => {
    const next = checked
      ? [...filters.subtypes, value]
      : filters.subtypes.filter((s) => s !== value);
    onChange({ ...filters, subtypes: next });
  };

  return (
    <>
      <Section title="Status" icon={<StatusIcon />} count={filters.status.length} defaultOpen>
        {STATUS_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 py-1 cursor-pointer text-[0.85rem] text-gray-700 dark:text-slate-300"
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{
                background: opt.value === "active" ? "#22c55e" : "#94a3b8",
              }}
            />
            <span className="flex-1">{opt.label}</span>
            <input
              type="radio"
              name="status-filter"
              checked={filters.status.includes(opt.value)}
              onChange={() => toggleStatus(opt.value)}
              className="w-[18px] h-[18px] accent-[#2a9d8f] cursor-pointer"
            />
          </label>
        ))}
      </Section>

      <Section title="Type" icon={<TypeIcon />} count={filters.types.length}>
        {TYPE_OPTIONS.map((opt) => (
          <CheckboxRow
            key={opt.value}
            label={opt.label}
            checked={filters.types.includes(opt.value)}
            onChange={(c) => toggleType(opt.value, c)}
            color={opt.color}
          />
        ))}
      </Section>

      <Section title="Subtype" icon={<SubtypeIcon />} count={filters.subtypes.length}>
        {availableSubtypes.map((sub) => (
          <CheckboxRow
            key={sub}
            label={subtypeLabel(sub)}
            checked={filters.subtypes.includes(sub)}
            onChange={(c) => toggleSubtype(sub, c)}
          />
        ))}
      </Section>
    </>
  );
};

// ============================================================================
// Filter Chips + Trigger (inline in search bar)
// ============================================================================

export const FilterChips: React.FC<{
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}> = ({ filters, onChange }) => {
  const chips: React.ReactNode[] = [];

  for (const s of filters.status) {
    const label = STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s;
    chips.push(
      <span
        key={`status-${s}`}
        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[20px] text-xs font-semibold border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
      >
        <span
          className="w-[7px] h-[7px] rounded-full shrink-0"
          style={{
            background: s === "active" ? "#22c55e" : "#94a3b8",
          }}
        />
        {label}
        <button
          type="button"
          className="touch-target bg-transparent border-none cursor-pointer p-0 flex items-center text-slate-400 dark:text-slate-500 text-[0.9rem] leading-none"
          onClick={() => onChange({ ...filters, status: [] })}
        >
          ×
        </button>
      </span>,
    );
  }

  for (const t of filters.types) {
    const opt = TYPE_OPTIONS.find((o) => o.value === t);
    chips.push(
      <span
        key={`type-${t}`}
        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[20px] text-xs font-semibold border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
      >
        {opt?.label ?? t}
        <button
          type="button"
          className="touch-target bg-transparent border-none cursor-pointer p-0 flex items-center text-slate-400 dark:text-slate-500 text-[0.9rem] leading-none"
          onClick={() => onChange({ ...filters, types: filters.types.filter((v) => v !== t) })}
        >
          ×
        </button>
      </span>,
    );
  }

  for (const sub of filters.subtypes) {
    chips.push(
      <span
        key={`subtype-${sub}`}
        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[20px] text-xs font-semibold border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
      >
        {subtypeLabel(sub)}
        <button
          type="button"
          className="touch-target bg-transparent border-none cursor-pointer p-0 flex items-center text-slate-400 dark:text-slate-500 text-[0.9rem] leading-none"
          onClick={() =>
            onChange({ ...filters, subtypes: filters.subtypes.filter((v) => v !== sub) })
          }
        >
          ×
        </button>
      </span>,
    );
  }

  return <>{chips}</>;
};

// ============================================================================
// Filter Popover — floating context menu anchored to filter icon
// ============================================================================

export const FilterDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  availableSubtypes: string[];
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
}> = ({ open, onClose, filters, onChange, availableSubtypes, anchorRef }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Position the popover below the anchor
  useEffect(() => {
    if (open && anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 6,
        left: rect.left,
      });
    }
  }, [open, anchorRef]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Don't close if clicking the anchor button itself
        if (anchorRef?.current?.contains(e.target as Node)) return;
        onClose();
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="fixed bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 z-50 overflow-y-auto overflow-x-hidden"
      style={{
        top: position.top,
        left: position.left,
        width: 264,
        maxHeight: "calc(100vh - 120px)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <span className="font-bold text-sm text-slate-800 dark:text-slate-200">Filters</span>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full bg-transparent border-none cursor-pointer text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
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
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      <FilterPanel filters={filters} onChange={onChange} availableSubtypes={availableSubtypes} />
    </div>
  );
};
