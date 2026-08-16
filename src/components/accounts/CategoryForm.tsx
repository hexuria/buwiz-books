import React, { useState, useEffect, useRef, useMemo } from "react";
import { useTheme } from "../ThemeContext";
import { ICON_PATHS, ICON_NAMES } from "./icons";
import type { AccountType } from "./CategoryRow";
import { SUBTYPE_OPTIONS_BY_TYPE } from "../../lib/coa/subtype-labels";

// ============================================================================
// Types
// ============================================================================

interface ParentCategory {
  id: string;
  name: string;
  accountNumber?: string;
  accountType?: string;
  subtype?: string;
}

export interface CategoryFormData {
  name: string;
  accountNumber?: string;
  description?: string;
  accountType: AccountType;
  subtype?: string;
  parentId?: string;
  icon?: string;
}

interface CategoryFormProps {
  /** Parent categories for dropdown */
  parentCategories: ParentCategory[];
  /** Initial data for edit mode (with id) or add-child mode (preset parent) */
  initialData?: CategoryFormData & { id?: string };
  /** Submit handler */
  onSubmit: (data: CategoryFormData) => void;
  /** Cancel handler */
  onCancel: () => void;
  /** Deactivate/Activate handler (edit mode only) */
  onDeactivate?: () => void;
  /** Whether the account is currently active (for toggle button text) */
  isActive?: boolean;
  /** Loading state */
  isLoading?: boolean;
}

// ============================================================================
// SVG Icon Library (from icons.ts registry)
// ============================================================================

interface IconDef {
  id: string;
  label: string;
}

/** Convert PascalCase icon ID to a human-readable label, e.g. "BankNote03" → "Bank Note 03" */
function iconIdToLabel(id: string): string {
  return id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/(\D)(\d)/g, "$1 $2");
}

export const iconLibrary: IconDef[] = ICON_NAMES.map((id) => ({
  id,
  label: iconIdToLabel(id),
}));

/** Render an icon SVG by its registry ID */
export function renderIconSvg(iconId: string, size = 20): React.ReactElement | null {
  const pathData = ICON_PATHS[iconId];
  if (!pathData) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ color: "inherit" }}
      dangerouslySetInnerHTML={{ __html: pathData }}
    />
  );
}

// ============================================================================
// Subtype Mapping
// ============================================================================

// Derived from the canonical SUBTYPES_BY_TYPE map so this picker can never
// offer a subtype the database would reject.
const subtypesByType = SUBTYPE_OPTIONS_BY_TYPE;

// ============================================================================
// Subtype → Icon mapping (matches reference layout)
// ============================================================================

export const SUBTYPE_ICONS: Record<string, string> = {
  // Asset subtypes
  account_receivable: "CoinsHand",
  accrued_revenue: "CalendarDollar01",
  asset_clearing: "ArrowSwitch",
  bank_accounts: "Bank",
  fixed_assets: "Couch",
  goodwill: "Goodwill",
  intangible_assets: "IntangibleAssets",
  inventory: "Inventory",
  investments: "TrendUp01",
  other_current_assets: "OtherCurrentAssets",
  other_long_term_assets: "OtherCurrentAssets",
  prepaid_expenses: "CalendarDollar01",
  shareholder_loans: "Shareholders",
  uncategorized_assets: "QuestionTransaction",
  // Liability subtypes
  accounts_payable: "CoinsHand02",
  accrued_expenses: "CalendarDollar01",
  convertible_notes: "Certificate01",
  credit_cards: "CreditCard",
  deferred_revenue: "DeferredRevenue",
  liability_clearing: "ArrowSwitch",
  long_term_debt: "Debt",
  other_current_liabilities: "Iou",
  other_long_term_liabilities: "Iou",
  payroll_liabilities: "UserCoins01",
  short_term_debt: "Debt",
  // Equity subtypes
  additional_paid_in_capital: "AdditionalPaidInCapital",
  common_stock: "Certificate01",
  other_comprehensive_income: "OtherComprehensiveIncome",
  owners_equity: "UserCoins01",
  preferred_stock: "Certificate01",
  retained_earnings: "RetainedEarning",
  safes: "Award03",
  treasury_stock: "BankDollar",
  uncategorized_equity: "QuestionTransaction",
  // Revenue subtypes
  partner_revenue: "PartnerRevenue",
  refunds_discounts: "RefundAndDiscount",
  sales_revenue: "SvgTagDollar",
  subscription_revenue: "SubscriptionRevenue",
  transaction_revenue: "Transaction",
  uncategorized_income: "QuestionTransaction",
  // Cost of Revenue subtypes
  cost_of_goods: "BankNoteScissors01",
  cost_of_labor: "Salary",
  hosting_fees: "HostingFee",
  other_cost_of_revenue: "BagDollar01",
  payment_processing_fees: "PaymentProcessingFee",
  // Operating Expenses subtypes
  bad_debt_expense: "BadDebtExpense",
  bank_fees: "BankNoteScissors01",
  business_application_software: "Apps",
  facilities: "Facilities",
  general_operations: "Operations",
  insurance: "Insurance",
  payroll_expenses: "Salary",
  professional_fees: "Award03",
  sales_marketing: "Announcement04",
  supplies_and_materials: "PaperClip",
  travel_entertainment: "Travel",
  uncategorized_expenses: "QuestionTransaction",
  // Other Income subtypes
  credit_card_rewards: "CreditCardRewards",
  interests_dividends: "Percent",
  other_miscellaneous_income: "OtherIncome",
  // Other Expenses subtypes
  depreciation_amortization: "DepreciationAndAmortization",
  interest_expense: "Percent",
  other_miscellaneous_expenses: "OtherExpenses",
  taxes: "CoinsStacked03",
};

// ============================================================================
// Account Type Picker — styled dropdown matching combobox pattern
// ============================================================================

const ACCOUNT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "revenue", label: "Revenue" },
  { value: "expense", label: "Operating Expenses" },
  { value: "cost_of_revenue", label: "Cost of Revenue" },
  { value: "other_income", label: "Other Income" },
  { value: "other_expense", label: "Other Expenses" },
];

const AccountTypePicker: React.FC<{
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = ACCOUNT_TYPE_OPTIONS.find((o) => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      const idx = ACCOUNT_TYPE_OPTIONS.findIndex((o) => o.value === value);
      setHighlightIdx(idx >= 0 ? idx : 0);
    }
  }, [open, value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!disabled) setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, ACCOUNT_TYPE_OPTIONS.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (ACCOUNT_TYPE_OPTIONS[highlightIdx]) {
          onChange(ACCOUNT_TYPE_OPTIONS[highlightIdx].value);
          setOpen(false);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className={`flex items-center w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-all cursor-pointer justify-between ${disabled ? "opacity-70 cursor-not-allowed" : ""}`}
      >
        <span style={{ opacity: selected ? 1 : 0.5 }}>
          {selected ? selected.label : "Select type..."}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          style={{ flexShrink: 0, opacity: 0.4 }}
        >
          <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
        </svg>
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden"
          style={{
            boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          {ACCOUNT_TYPE_OPTIONS.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightIdx;
            return (
              <button
                key={opt.value}
                type="button"
                onMouseEnter={() => setHighlightIdx(idx)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex items-center gap-3 w-full px-4 text-sm transition-colors cursor-pointer ${
                  isSelected
                    ? "text-[var(--color-app-header-teal)] bg-[var(--color-app-bg-light-teal,#eaf6f6)] dark:bg-teal-900/30"
                    : isHighlighted
                      ? "text-[var(--color-app-text-navy)] dark:text-slate-200 bg-slate-50 dark:bg-slate-700"
                      : "text-[var(--color-app-text-navy)] dark:text-slate-200"
                }`}
                style={{ height: 40, minHeight: 40 }}
              >
                <span className="flex-1 text-left truncate">{opt.label}</span>
                {isSelected && (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className="shrink-0"
                    style={{ opacity: 0.6 }}
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Custom Subtype Combobox — filterable dropdown with icons, keyboard nav
// ============================================================================

const ITEM_HEIGHT = 44; // px per option row
const MAX_VISIBLE = 7;

const SubtypePicker: React.FC<{
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}> = ({ value, onChange, options, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filtered options based on query
  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIdx(0);
  }, [filtered.length]);

  // Auto-scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current || highlightIdx < 0) return;
    const el = listRef.current.children[highlightIdx] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  // Focus input when opening
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
    setQuery("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[highlightIdx]) {
          handleSelect(filtered[highlightIdx].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        break;
    }
  };

  const selected = options.find((o) => o.value === value);
  const selectedIcon = value ? SUBTYPE_ICONS[value] : null;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Trigger button */}
      {!open ? (
        <button
          type="button"
          onClick={() => !disabled && setOpen(true)}
          className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-all cursor-pointer justify-between ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <span className="flex items-center gap-2.5 truncate">
            {selectedIcon && (
              <span
                className="flex items-center justify-center shrink-0"
                style={{ width: 22, height: 22 }}
              >
                {renderIconSvg(selectedIcon, 20)}
              </span>
            )}
            <span style={{ opacity: selected ? 1 : 0.5 }}>
              {selected ? selected.label : "Select subtype..."}
            </span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ flexShrink: 0, opacity: 0.4 }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      ) : (
        /* Search input — shown when open */
        <div className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm border-2 border-[var(--color-app-header-teal,#3b82f6)] rounded-lg bg-white dark:bg-slate-800">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            className="shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to filter..."
            className="flex-1 bg-transparent outline-none text-base sm:text-sm text-[var(--color-app-text-navy)] dark:text-slate-200 placeholder:text-gray-400 dark:placeholder:text-slate-500"
          />
        </div>
      )}

      {/* Dropdown list */}
      {open && (
        <div
          className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden"
          style={{
            boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div
            ref={listRef}
            className="subtype-combo-list"
            style={{
              maxHeight: MAX_VISIBLE * ITEM_HEIGHT,
              overflowY: "auto",
              scrollbarWidth: "none",
            }}
          >
            <style>{`.subtype-combo-list::-webkit-scrollbar { display: none; }`}</style>
            {filtered.length === 0 && (
              <div
                className="px-4 text-sm text-gray-400 flex items-center"
                style={{ height: ITEM_HEIGHT }}
              >
                No matching subtypes
              </div>
            )}
            {filtered.map((opt, idx) => {
              const icon = SUBTYPE_ICONS[opt.value];
              const isSelected = opt.value === value;
              const isHighlighted = idx === highlightIdx;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => handleSelect(opt.value)}
                  className={`flex items-center gap-3 w-full px-4 text-sm transition-colors cursor-pointer ${
                    isSelected
                      ? "text-[var(--color-app-header-teal)] bg-[var(--color-app-bg-light-teal,#eaf6f6)] dark:bg-teal-900/30"
                      : isHighlighted
                        ? "text-[var(--color-app-text-navy)] dark:text-slate-200 bg-slate-50 dark:bg-slate-700"
                        : "text-[var(--color-app-text-navy)] dark:text-slate-200"
                  }`}
                  style={{
                    height: ITEM_HEIGHT,
                    minHeight: ITEM_HEIGHT,
                  }}
                >
                  <span
                    className="flex items-center justify-center shrink-0"
                    style={{ width: 24, height: 24, opacity: 0.65 }}
                  >
                    {icon && renderIconSvg(icon, 20)}
                  </span>
                  <span className="flex-1 text-left truncate">{opt.label}</span>
                  {isSelected && (
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="shrink-0"
                      style={{ opacity: 0.6 }}
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Parent Category Combobox — filterable dropdown, keyboard nav
// ============================================================================

const ParentCategoryPicker: React.FC<{
  value: string;
  onChange: (val: string) => void;
  parents: { id: string; name: string; accountNumber?: string | null }[];
}> = ({ value, onChange, parents }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build options: "No parent" + all parents
  const allOptions = useMemo(() => {
    const items = parents.map((p) => ({
      value: p.id,
      label: p.accountNumber ? `${p.accountNumber} - ${p.name}` : p.name,
    }));
    return [{ value: "", label: "No parent (root level)" }, ...items];
  }, [parents]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allOptions;
    const q = query.toLowerCase();
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, query]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setHighlightIdx(0);
  }, [filtered.length]);

  useEffect(() => {
    if (!listRef.current || highlightIdx < 0) return;
    const el = listRef.current.children[highlightIdx] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
    setQuery("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[highlightIdx]) handleSelect(filtered[highlightIdx].value);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        break;
    }
  };

  const selected = allOptions.find((o) => o.value === value);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-all cursor-pointer justify-between"
        >
          <span className="truncate" style={{ opacity: selected ? 1 : 0.5 }}>
            {selected ? selected.label : "Select parent..."}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ flexShrink: 0, opacity: 0.4 }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm border-2 border-[var(--color-app-header-teal,#3b82f6)] rounded-lg bg-white dark:bg-slate-800">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            className="shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to filter..."
            className="flex-1 bg-transparent outline-none text-base sm:text-sm text-[var(--color-app-text-navy)] dark:text-slate-200 placeholder:text-gray-400 dark:placeholder:text-slate-500"
          />
        </div>
      )}

      {open && (
        <div
          className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden"
          style={{
            boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div
            ref={listRef}
            className="parent-combo-list"
            style={{
              maxHeight: MAX_VISIBLE * ITEM_HEIGHT,
              overflowY: "auto",
              scrollbarWidth: "none",
            }}
          >
            <style>{`.parent-combo-list::-webkit-scrollbar { display: none; }`}</style>
            {filtered.length === 0 && (
              <div
                className="px-4 text-sm text-gray-400 flex items-center"
                style={{ height: ITEM_HEIGHT }}
              >
                No matching categories
              </div>
            )}
            {filtered.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isHighlighted = idx === highlightIdx;
              return (
                <button
                  key={opt.value || "__root__"}
                  type="button"
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => handleSelect(opt.value)}
                  className={`flex items-center gap-3 w-full px-4 text-sm transition-colors cursor-pointer ${
                    isSelected
                      ? "text-[var(--color-app-header-teal)] bg-[var(--color-app-bg-light-teal,#eaf6f6)] dark:bg-teal-900/30"
                      : isHighlighted
                        ? "text-[var(--color-app-text-navy)] dark:text-slate-200 bg-slate-50 dark:bg-slate-700"
                        : "text-[var(--color-app-text-navy)] dark:text-slate-200"
                  }`}
                  style={{
                    height: ITEM_HEIGHT,
                    minHeight: ITEM_HEIGHT,
                  }}
                >
                  <span className="flex-1 text-left truncate">{opt.label}</span>
                  {isSelected && (
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="shrink-0"
                      style={{ opacity: 0.6 }}
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================

const IconPicker: React.FC<{
  value: string;
  onChange: (iconId: string) => void;
}> = ({ value, onChange }) => {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
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

  const hasIcon = value && ICON_PATHS[value];
  const filtered = search
    ? iconLibrary.filter(
        (i) =>
          i.label.toLowerCase().includes(search.toLowerCase()) ||
          i.id.toLowerCase().includes(search.toLowerCase()),
      )
    : iconLibrary;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 cursor-pointer w-auto min-w-[56px] justify-center p-2 text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-colors focus:outline-none focus:border-[var(--color-app-header-teal)]"
      >
        {hasIcon ? renderIconSvg(value) : <span style={{ opacity: 0.4 }}>?</span>}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            borderRadius: 10,
            boxShadow: isDark ? "0 10px 40px rgba(0,0,0,0.4)" : "0 10px 40px rgba(0,0,0,0.18)",
            zIndex: 200,
            width: 240,
            padding: "0.5rem",
          }}
          className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700"
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find icon..."
            className="w-full px-3 py-2.5 text-base sm:text-[0.8rem] border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-colors focus:outline-none focus:border-[var(--color-app-header-teal)] mb-2"
            autoFocus
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 4,
              maxHeight: 180,
              overflowY: "auto",
            }}
          >
            {filtered.map((icon) => (
              <button
                key={icon.id}
                type="button"
                title={icon.label}
                onClick={() => {
                  onChange(icon.id);
                  setOpen(false);
                  setSearch("");
                }}
                style={{
                  width: 40,
                  height: 40,
                  border: value === icon.id ? "2px solid #2a9d8f" : "1px solid transparent",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  background: value === icon.id ? (isDark ? "#1a332f" : "#e0f2f1") : "transparent",
                  color: isDark ? "#94a3b8" : "#32497f",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (value !== icon.id)
                    e.currentTarget.style.background = isDark ? "#334155" : "#f0f1f3";
                }}
                onMouseLeave={(e) => {
                  if (value !== icon.id) e.currentTarget.style.background = "transparent";
                }}
              >
                {renderIconSvg(icon.id)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Component
// ============================================================================

export const CategoryForm: React.FC<CategoryFormProps> = ({
  parentCategories,
  initialData,
  onSubmit,
  onCancel,
  onDeactivate,
  isActive = true,
  isLoading = false,
}) => {
  const isEditMode = !!initialData?.id;
  const isRootCategory = isEditMode && !initialData?.parentId;

  const [name, setName] = useState(initialData?.name ?? "");
  const [accountNumber, setAccountNumber] = useState(initialData?.accountNumber ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [accountType, setAccountType] = useState<AccountType>(initialData?.accountType ?? "asset");
  const [subtype, setSubtype] = useState(initialData?.subtype ?? "");
  const [parentId, setParentId] = useState(initialData?.parentId ?? "");
  const [icon, setIcon] = useState(initialData?.icon ?? "building");

  // Reset form when initialData changes (edit mode = id change, add-child = parentId change)
  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setAccountNumber(initialData.accountNumber ?? "");
      setDescription(initialData.description ?? "");
      setAccountType(initialData.accountType);
      setSubtype(initialData.subtype ?? "");
      setParentId(initialData.parentId ?? "");
      setIcon(initialData.icon ?? "building");
    }
  }, [initialData?.id, initialData?.parentId]);

  const availableSubtypes = useMemo(() => subtypesByType[accountType], [accountType]);

  const filteredParents = useMemo(
    () =>
      parentCategories.filter((p) => {
        if (initialData && p.id === initialData.id) return false;
        return true;
      }),
    [parentCategories, initialData],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      accountNumber: accountNumber || undefined,
      description: description || undefined,
      accountType,
      subtype: subtype || undefined,
      parentId: parentId || undefined,
      icon,
    });
  };

  const handleTypeChange = (newType: AccountType) => {
    setAccountType(newType);
    const validSubtypes: string[] = subtypesByType[newType].map((s) => s.value);
    if (!validSubtypes.includes(subtype)) {
      setSubtype("");
    }
  };

  return (
    <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-[360px] shrink-0">
      {/* Header */}
      <div className="bg-[var(--color-app-header-teal)] text-white px-5 py-4 flex items-center gap-3 font-semibold text-base rounded-t-xl">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        <span className="font-semibold">{isEditMode ? "Edit Category" : "New Category"}</span>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="p-4 bg-white dark:bg-slate-800 flex flex-col gap-4">
          {/* Category Name */}
          <div className="mb-0">
            <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
              Category Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter category name..."
              required
              disabled={isRootCategory}
              className={`w-full px-3 py-2.5 text-base sm:text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-colors focus:outline-none focus:border-[var(--color-app-header-teal)] ${isRootCategory ? "opacity-70 cursor-not-allowed" : ""}`}
              title={isRootCategory ? "Root category names cannot be changed" : undefined}
            />
          </div>

          {/* Parent Category - only for sub-categories or new */}
          {(!isEditMode || !isRootCategory) && (
            <div className="mb-0">
              <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
                Parent Category
              </label>
              <ParentCategoryPicker
                value={parentId}
                onChange={(newParentId) => {
                  setParentId(newParentId);
                  // Auto-derive account type from selected parent
                  if (newParentId) {
                    const selectedParent = parentCategories.find((p) => p.id === newParentId);
                    if (selectedParent?.accountType) {
                      handleTypeChange(selectedParent.accountType as AccountType);
                    }
                    if (selectedParent?.subtype) {
                      setSubtype(selectedParent.subtype);
                    }
                  }
                }}
                parents={filteredParents}
              />
            </div>
          )}

          {/* Account Type */}
          <div className="mb-0">
            <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
              Account Type
            </label>
            <AccountTypePicker
              value={accountType}
              onChange={(val) => handleTypeChange(val as AccountType)}
              disabled={isEditMode || !!parentId}
            />
          </div>

          {/* Subtype - only for sub-categories or new */}
          {(!isEditMode || !isRootCategory) && (
            <div className="mb-0">
              <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
                Subtype
              </label>
              <SubtypePicker value={subtype} onChange={setSubtype} options={availableSubtypes} />
            </div>
          )}

          {/* Icon + Category Number row */}
          <div className="flex gap-3">
            <div className="mb-0 shrink-0">
              <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
                Icon
              </label>
              <IconPicker value={icon} onChange={setIcon} />
            </div>
            <div className="mb-0 flex-1">
              <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
                Category Number{" "}
                <span className="text-[10px] font-normal opacity-60">
                  (auto-generated if empty)
                </span>
              </label>
              <input
                type="text"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                placeholder="Auto-generated"
                maxLength={10}
                className="w-full px-3 py-2.5 text-base sm:text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-colors focus:outline-none focus:border-[var(--color-app-header-teal)] font-mono"
              />
            </div>
          </div>

          {/* Description */}
          <div className="mb-0">
            <label className="block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5">
              Description (Optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter a description..."
              rows={3}
              className="w-full px-3 py-2.5 text-base sm:text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-colors focus:outline-none focus:border-[var(--color-app-header-teal)] resize-y min-h-[80px]"
            />
          </div>
        </div>

        {/* Deactivate/Activate button (edit mode only, disabled for root) */}
        {isEditMode && (
          <div className="bg-white dark:bg-slate-800 px-4 pt-2 pb-4">
            <div
              className={`bg-white dark:bg-slate-800 rounded-xl border overflow-hidden ${isRootCategory ? "border-gray-100 dark:border-slate-700" : "border-gray-200 dark:border-slate-600"}`}
            >
              <button
                type="button"
                className={`inline-flex items-center justify-center w-full px-5 py-3.5 text-sm font-semibold transition-all border-none bg-white dark:bg-slate-800 ${isRootCategory ? "text-gray-400 dark:text-slate-500 cursor-not-allowed" : isActive ? "text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer" : "text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30 cursor-pointer"}`}
                disabled={isRootCategory}
                onClick={isRootCategory ? undefined : onDeactivate}
                title={
                  isRootCategory
                    ? "Root categories cannot be deactivated"
                    : isActive
                      ? "Deactivate this category"
                      : "Activate this category"
                }
              >
                {isActive ? "Deactivate Category" : "Activate Category"}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-gray-200 dark:border-slate-700">
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg cursor-pointer transition-all bg-white dark:bg-slate-700 text-[var(--color-app-text-navy)] dark:text-slate-200 border border-gray-200 dark:border-slate-600 hover:bg-[#f5f6f9] dark:hover:bg-slate-600"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg cursor-pointer transition-all border-none bg-[var(--color-app-header-teal)] text-white hover:bg-[#248f82]"
            disabled={!name || isLoading}
          >
            {isLoading
              ? isEditMode
                ? "Saving..."
                : "Creating..."
              : isEditMode
                ? "Save"
                : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
};
