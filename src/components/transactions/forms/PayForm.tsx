/**
 * PayForm — Reusable Pay In / Pay Out form
 * Used by both /transactions/new and /transactions/$transactionId
 */
import { useMemo } from "react";
import Combobox from "../../ui/Combobox";
import type { ComboboxOption, SuggestedItem } from "../../ui/Combobox";
import { ICON_PATHS } from "../../accounts/icons";
import type { PayForLine, AccountOption } from "../shared/types";
import { labelClass, CATEGORY_ICON, DEPARTMENT_ICON, LOCATION_ICON } from "../shared/constants";
import {
  buildAccountOptions,
  formatCurrency,
  filterPaymentAccounts,
  filterCategoryOptions,
} from "../shared/helpers";

interface PayFormProps {
  partyId: string;
  onPartyChange: (id: string) => void;
  type: "pay_in" | "pay_out";
  categoryId: string;
  onCategoryChange: (id: string) => void;
  lines: PayForLine[];
  accounts: AccountOption[];
  onUpdateLine: (key: string, field: keyof PayForLine, value: string) => void;
  onAddLine: () => void;
  onRemoveLine: (key: string) => void;
  onCopyLine: (key: string) => void;
  onAddLineAfter: (afterKey: string) => void;
  total: number;
  partyOptions: ComboboxOption[];
  onPartyQueryChange: (query: string) => void;
  departmentOptions: ComboboxOption[];
  locationOptions: ComboboxOption[];
  readOnly?: boolean;
  validationErrors?: Set<string>;
  /** Create a new header-level category from query */
  onCreateCategory?: (query: string) => void;
  /** Propagate combobox search for suggestion matching */
  onCategorySugQuery?: (query: string) => void;
  /** Pre-computed category suggestions */
  categorySuggestions?: SuggestedItem[];
  /** User clicked a suggested category for the header */
  onCreateCategorySuggestion?: (item: SuggestedItem) => void;
  /** Create a new category from query for a line item */
  onCreateLineCategory?: (lineKey: string, query: string) => void;
  /** User clicked a suggested category for a line item */
  onCreateLineCategorySuggestion?: (lineKey: string, item: SuggestedItem) => void;
}

export default function PayForm({
  type,
  categoryId,
  onCategoryChange,
  lines,
  accounts,
  onUpdateLine,
  onAddLine: _onAddLine,
  onRemoveLine,
  onCopyLine,
  onAddLineAfter,
  total: _total,
  partyOptions: _partyOptions,
  onPartyQueryChange: _onPartyQueryChange,
  partyId: _partyId,
  onPartyChange: _onPartyChange,
  departmentOptions,
  locationOptions,
  readOnly = false,
  validationErrors,
  onCreateCategory,
  onCategorySugQuery,
  categorySuggestions,
  onCreateCategorySuggestion,
  onCreateLineCategory,
  onCreateLineCategorySuggestion,
}: PayFormProps) {
  const columnLabel = type === "pay_in" ? "Credit" : "Debit";

  // 1. Payment / Header Account Options (Assets/Liabilities)
  const paymentAccounts = useMemo(() => filterPaymentAccounts(accounts), [accounts]);
  const paymentOptions = useMemo(() => {
    const base = buildAccountOptions(paymentAccounts);
    // Ensure the currently-selected header category always appears in the options,
    // even if it falls outside the type filter (e.g. after Pay Out → Pay In swap).
    if (categoryId && !paymentAccounts.some((a) => a.id === categoryId)) {
      const selected = accounts.find((a) => a.id === categoryId);
      if (selected) {
        base.unshift(buildAccountOptions([selected])[0]);
      }
    }
    return base;
  }, [paymentAccounts, accounts, categoryId]);

  // 2. Line Item Category Options (Income/Expense based on type)
  const lineCategoryAccounts = useMemo(
    () => filterCategoryOptions(accounts, type),
    [accounts, type],
  );
  const lineCategoryOptions = useMemo(() => {
    const base = buildAccountOptions(lineCategoryAccounts);
    // Ensure each pay line's currently-selected category appears in options,
    // even if outside the type filter (e.g. after swapping Pay In ↔ Pay Out).
    const baseIds = new Set(lineCategoryAccounts.map((a) => a.id));
    const missingIds = new Set<string>();
    for (const line of lines) {
      if (line.categoryId && !baseIds.has(line.categoryId) && !missingIds.has(line.categoryId)) {
        missingIds.add(line.categoryId);
        const match = accounts.find((a) => a.id === line.categoryId);
        if (match) {
          base.unshift(buildAccountOptions([match])[0]);
        }
      }
    }
    return base;
  }, [lineCategoryAccounts, accounts, lines]);

  // ── Read-only view ──
  if (readOnly) {
    const selectedCategory = paymentOptions.find((o) => o.value === categoryId);
    const _selectedParty = _partyOptions.find((o: ComboboxOption) => o.value === _partyId);
    return (
      <div>
        {/* Category */}
        <div className="mb-5">
          <div className={labelClass}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              dangerouslySetInnerHTML={{ __html: ICON_PATHS.Bank }}
            />
            {type === "pay_in" ? "Pay In Category" : "Pay Out Category"}
          </div>
          <div className="flex items-center gap-3 text-sm text-[#1e293b] dark:text-slate-200 font-medium bg-white dark:bg-slate-800 rounded-md border border-[#e2e8f0] dark:border-slate-700 px-4 py-2 shadow-sm min-h-[64px]">
            {selectedCategory ? (
              <>
                <span className="w-10 h-10 flex items-center justify-center bg-[#27ae60] text-white rounded-lg shrink-0 [&>svg]:w-6 [&>svg]:h-6">
                  {selectedCategory.icon}
                </span>
                {selectedCategory.label}
              </>
            ) : (
              "—"
            )}
          </div>
        </div>

        {/* Pay For lines (read-only table) */}
        <div className="flex items-center justify-between mb-3">
          <div className={labelClass}>
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
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            Pay For
          </div>
          <span className="text-xs font-medium text-[#64748b] dark:text-slate-400 w-20 text-right">
            {columnLabel}
          </span>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-lg border border-[#e2e8f0] dark:border-slate-700 overflow-hidden">
          {lines.map((line, idx) => {
            const acct = lineCategoryOptions.find((o) => o.value === line.categoryId);
            const dept = departmentOptions.find((o) => o.value === line.departmentId);
            const loc = locationOptions.find((o) => o.value === line.locationId);

            return (
              <div
                key={line.key}
                className="flex items-start justify-between px-4 py-3 border-b border-[#f0f2f5] dark:border-slate-700 last:border-b-0 transition-colors"
              >
                <div className="flex items-start gap-3 flex-1">
                  <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-slate-500 w-5 pt-1 text-center shrink-0">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[#1e293b] dark:text-slate-200 mb-1.5">
                      {line.description || "—"}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {acct && (
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="w-4 h-4 flex items-center justify-center text-[var(--color-app-header-teal)] opacity-80 [&>svg]:w-full [&>svg]:h-full">
                              {acct.icon}
                            </span>
                            <span className="text-sm font-medium text-[#1e293b] dark:text-slate-200">
                              {acct.label.split(" · ")[1] || acct.label}
                            </span>
                          </div>
                          {acct.label.includes(" · ") && (
                            <div className="text-xs text-[#64748b] dark:text-slate-500 pl-6">
                              {acct.label.split(" · ")[0]}
                            </div>
                          )}
                        </div>
                      )}
                      {dept && (
                        <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-slate-200 dark:bg-slate-800 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 shadow-sm">
                          <span className="opacity-50">
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <rect x="4" y="4" width="16" height="16" rx="2" />
                              <rect x="9" y="9" width="6" height="6" />
                              <path d="M9 1v3" />
                              <path d="M15 1v3" />
                              <path d="M9 20v3" />
                              <path d="M15 20v3" />
                              <path d="M20 9h3" />
                              <path d="M20 14h3" />
                              <path d="M1 9h3" />
                              <path d="M1 14h3" />
                            </svg>
                          </span>
                          <span className="truncate max-w-[150px]">{dept.label}</span>
                        </div>
                      )}
                      {loc && (
                        <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-slate-200 dark:bg-slate-800 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 shadow-sm">
                          <span className="opacity-50">
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                              <circle cx="12" cy="10" r="3" />
                            </svg>
                          </span>
                          <span className="truncate max-w-[150px]">{loc.label}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <span className="text-sm tabular-nums text-[#1e293b] dark:text-slate-200 font-bold pt-0.5">
                  {line.amount && Number.parseFloat(line.amount) > 0
                    ? formatCurrency(line.amount)
                    : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Edit mode ──
  return (
    <div>
      {/* Category */}
      <div className="mb-5">
        <div className={labelClass}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            dangerouslySetInnerHTML={{ __html: ICON_PATHS.Bank }}
          />
          {type === "pay_in" ? "Pay In Category" : "Pay Out Category"}
        </div>
        <Combobox
          value={categoryId}
          onChange={onCategoryChange}
          options={paymentOptions}
          placeholder="Account..."
          placeholderIcon={CATEGORY_ICON}
          searchPlaceholder="Select Account"
          onCreate={onCreateCategory}
          createLabel="account"
          onSearch={onCategorySugQuery}
          suggestions={categorySuggestions}
          onCreateSuggestion={onCreateCategorySuggestion}
        />
      </div>

      {/* Pay For lines */}
      <div className="flex items-center justify-between mb-3">
        <div className={labelClass}>
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
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          Pay For
        </div>
        <span className="text-xs font-medium text-[#64748b] dark:text-slate-400 w-20 text-right">
          {columnLabel}
        </span>
      </div>

      <div className="space-y-3 md:space-y-0">
        {lines.map((line, idx) => {
          const hasError = validationErrors?.has(line.key);
          return (
            <div
              key={line.key}
              className="relative bg-white dark:bg-slate-800/50 rounded-xl border border-[#e8ecf0] dark:border-slate-700/50 md:bg-transparent md:dark:bg-transparent md:rounded-none md:border-0 md:border-b md:border-[#f0f2f5] md:dark:border-slate-800 md:last:border-b-0 md:py-3"
            >
              {/* ═══════════════════════════════════════════════
                  MEDIUM DEVICES (md to lg): 3-row layout
                  ═══════════════════════════════════════════════ */}

              {/* Row 1: Line # · Description · Amount */}
              <div className="hidden md:flex lg:hidden items-center gap-2 mb-2">
                <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-slate-500 w-5 text-center shrink-0">
                  {idx + 1}
                </span>
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) => onUpdateLine(line.key, "description", e.target.value)}
                  placeholder="Add description for this item..."
                  className="flex-[2] min-w-0 bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={line.amount}
                  onChange={(e) => onUpdateLine(line.key, "amount", e.target.value)}
                  placeholder="$0.00"
                  className="flex-1 min-w-0 text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
              </div>

              {/* Row 2: Category · Party (md only — no party on pay forms, use for category) */}
              <div className="hidden md:flex lg:hidden items-center gap-2 pl-7 mb-2">
                <div className="flex-1 min-w-0">
                  <Combobox
                    value={line.categoryId}
                    onChange={(v) => onUpdateLine(line.key, "categoryId", v)}
                    options={lineCategoryOptions}
                    placeholder="Category"
                    placeholderIcon={CATEGORY_ICON}
                    searchPlaceholder="Select or Create New"
                    className={
                      hasError
                        ? "[&>button]:border-orange-400 [&>button]:ring-1 [&>button]:ring-orange-400"
                        : ""
                    }
                    onCreate={
                      onCreateLineCategory ? (q) => onCreateLineCategory(line.key, q) : undefined
                    }
                    createLabel="category"
                    onSearch={onCategorySugQuery}
                    suggestions={categorySuggestions}
                    onCreateSuggestion={
                      onCreateLineCategorySuggestion
                        ? (item) => onCreateLineCategorySuggestion(line.key, item)
                        : undefined
                    }
                  />
                </div>
              </div>

              {/* Row 3: Department · Location · Delete · Copy · Add */}
              <div className="hidden md:flex lg:hidden items-center gap-2 pl-7">
                <div className="flex-1 min-w-0">
                  <Combobox
                    value={line.departmentId}
                    onChange={(v) => onUpdateLine(line.key, "departmentId", v)}
                    options={departmentOptions}
                    placeholder="Department"
                    placeholderIcon={DEPARTMENT_ICON}
                    searchPlaceholder="Find department..."
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <Combobox
                    value={line.locationId}
                    onChange={(v) => onUpdateLine(line.key, "locationId", v)}
                    options={locationOptions}
                    placeholder="Location"
                    placeholderIcon={LOCATION_ICON}
                    searchPlaceholder="Find location..."
                  />
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveLine(line.key)}
                      className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Delete line"
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
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCopyLine(line.key)}
                    className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-[#475569] hover:bg-[#f1f5f9] dark:hover:text-slate-300 dark:hover:bg-slate-700 transition-colors"
                    title="Copy line"
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
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddLineAfter(line.key)}
                    className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-[var(--color-app-header-teal)] hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-colors"
                    title="Add line below"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* ═══════════════════════════════════════════════
                  LARGE DESKTOP (lg+): Compact 2-row layout
                  ═══════════════════════════════════════════════ */}

              {/* Row 1: Line # · Description · Amount */}
              <div className="hidden lg:flex items-center gap-2 mb-2">
                <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-slate-500 w-5 text-center shrink-0">
                  {idx + 1}
                </span>
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) => onUpdateLine(line.key, "description", e.target.value)}
                  placeholder="Add description for this item..."
                  className="flex-1 min-w-0 bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={line.amount}
                  onChange={(e) => onUpdateLine(line.key, "amount", e.target.value)}
                  placeholder="$0.00"
                  className="w-20 text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
              </div>

              {/* Row 2: Category · Department · Location · actions */}
              <div className="hidden lg:flex items-center gap-2 pl-7">
                <div className="grid grid-cols-3 gap-2 flex-1">
                  <Combobox
                    value={line.categoryId}
                    onChange={(v) => onUpdateLine(line.key, "categoryId", v)}
                    options={lineCategoryOptions}
                    placeholder="Category"
                    placeholderIcon={CATEGORY_ICON}
                    searchPlaceholder="Select or Create New"
                    className={
                      hasError
                        ? "[&>button]:border-orange-400 [&>button]:ring-1 [&>button]:ring-orange-400"
                        : ""
                    }
                    onCreate={
                      onCreateLineCategory ? (q) => onCreateLineCategory(line.key, q) : undefined
                    }
                    createLabel="category"
                    onSearch={onCategorySugQuery}
                    suggestions={categorySuggestions}
                    onCreateSuggestion={
                      onCreateLineCategorySuggestion
                        ? (item) => onCreateLineCategorySuggestion(line.key, item)
                        : undefined
                    }
                  />
                  <Combobox
                    value={line.departmentId}
                    onChange={(v) => onUpdateLine(line.key, "departmentId", v)}
                    options={departmentOptions}
                    placeholder="Department"
                    placeholderIcon={DEPARTMENT_ICON}
                    searchPlaceholder="Find department..."
                  />
                  <Combobox
                    value={line.locationId}
                    onChange={(v) => onUpdateLine(line.key, "locationId", v)}
                    options={locationOptions}
                    placeholder="Location"
                    placeholderIcon={LOCATION_ICON}
                    searchPlaceholder="Find location..."
                  />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveLine(line.key)}
                      className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Delete line"
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
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCopyLine(line.key)}
                    className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-[#475569] hover:bg-[#f1f5f9] dark:hover:text-slate-300 dark:hover:bg-slate-700 transition-colors"
                    title="Copy line"
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
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddLineAfter(line.key)}
                    className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-[var(--color-app-header-teal)] hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-colors"
                    title="Add line below"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* ═══════════════════════════════════════════════════════════
                  MOBILE ONLY (below md): Stacked card layout
                  ═══════════════════════════════════════════════════════════ */}

              {/* Card Header: Line # · Description */}
              <div className="flex md:hidden items-center gap-2 px-3 pt-3 pb-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-app-header-teal)] text-white text-[11px] font-bold shrink-0">
                  {idx + 1}
                </span>
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) => onUpdateLine(line.key, "description", e.target.value)}
                  placeholder="Line description..."
                  className="flex-1 min-w-0 bg-transparent border-none px-1 py-1 text-base sm:text-sm text-[#1e293b] dark:text-slate-200 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none"
                />
              </div>

              {/* Amount (labeled) */}
              <div className="px-3 pb-2 md:hidden">
                <label className="block text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider mb-1">
                  {columnLabel}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={line.amount}
                  onChange={(e) => onUpdateLine(line.key, "amount", e.target.value)}
                  placeholder="$0.00"
                  className="w-full text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-lg px-3 py-2 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)] focus:ring-1 focus:ring-[var(--color-app-header-teal)] transition-colors"
                />
              </div>

              {/* Category (full width) */}
              <div className="px-3 pb-2 md:hidden">
                <Combobox
                  value={line.categoryId}
                  onChange={(v) => onUpdateLine(line.key, "categoryId", v)}
                  options={lineCategoryOptions}
                  placeholder="Category"
                  placeholderIcon={CATEGORY_ICON}
                  searchPlaceholder="Select or Create New"
                  className={
                    hasError
                      ? "[&>button]:border-orange-400 [&>button]:ring-1 [&>button]:ring-orange-400"
                      : ""
                  }
                  onCreate={
                    onCreateLineCategory ? (q) => onCreateLineCategory(line.key, q) : undefined
                  }
                  createLabel="category"
                  onSearch={onCategorySugQuery}
                  suggestions={categorySuggestions}
                  onCreateSuggestion={
                    onCreateLineCategorySuggestion
                      ? (item) => onCreateLineCategorySuggestion(line.key, item)
                      : undefined
                  }
                />
              </div>

              {/* Department (full width) */}
              <div className="px-3 pb-2 md:hidden">
                <Combobox
                  value={line.departmentId}
                  onChange={(v) => onUpdateLine(line.key, "departmentId", v)}
                  options={departmentOptions}
                  placeholder="Department"
                  placeholderIcon={DEPARTMENT_ICON}
                  searchPlaceholder="Find department..."
                />
              </div>

              {/* Location · Delete · Copy · Add */}
              <div className="flex md:hidden items-center gap-2 px-3 pb-3">
                <div className="flex-1">
                  <Combobox
                    value={line.locationId}
                    onChange={(v) => onUpdateLine(line.key, "locationId", v)}
                    options={locationOptions}
                    placeholder="Location"
                    placeholderIcon={LOCATION_ICON}
                    searchPlaceholder="Find location..."
                  />
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveLine(line.key)}
                      className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Delete line"
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCopyLine(line.key)}
                    className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[#475569] hover:bg-[#f1f5f9] dark:hover:text-slate-300 dark:hover:bg-slate-700 transition-colors"
                    title="Copy line"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddLineAfter(line.key)}
                    className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[var(--color-app-header-teal)] hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-colors"
                    title="Add line below"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
