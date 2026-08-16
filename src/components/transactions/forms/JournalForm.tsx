/**
 * JournalForm — Reusable journal entry lines form
 * Used by both /transactions/new and /transactions/$transactionId
 *
 * Responsive layout:
 *   - Desktop/Tablet (md+): Original compact horizontal rows
 *   - Mobile (<md): Stacked card layout with full-width fields
 */
import { useMemo } from "react";
import Combobox from "../../ui/Combobox";
import type { ComboboxOption, SuggestedItem } from "../../ui/Combobox";
import CategoryPartyCombobox from "./CategoryPartyCombobox";

import type { AccountOption, CreatePartyFn, JournalLine, ListPartiesFn } from "../shared/types";
import { labelClass, CATEGORY_ICON, DEPARTMENT_ICON, LOCATION_ICON } from "../shared/constants";
import { buildAccountOptions } from "../shared/helpers";
import type { PartyMappingOverride } from "../../../lib/party-scoping";

interface JournalFormProps {
  lines: JournalLine[];
  accounts: AccountOption[];
  onUpdateLine: (key: string, field: keyof JournalLine, value: string) => void;
  onAddLine: () => void;
  onAddLineAfter: (afterKey: string) => void;
  onCopyLine: (key: string) => void;
  onRemoveLine: (key: string) => void;
  totals: { debit: number; credit: number; balanced: boolean };
  validationErrors: Set<string>;
  departmentOptions: ComboboxOption[];
  locationOptions: ComboboxOption[];
  listPartiesFn: ListPartiesFn;
  createPartyFn?: CreatePartyFn;
  partyOverrides?: Record<string, PartyMappingOverride>;
  readOnly?: boolean;
  /** Create a new category from typed query (per line) */
  onCreateCategory?: (lineKey: string, query: string) => void;
  /** Propagate combobox search for suggestion matching */
  onCategorySugQuery?: (query: string) => void;
  /** Pre-computed category suggestions */
  categorySuggestions?: SuggestedItem[];
  /** User clicked a suggested category (per line) */
  onCreateCategorySuggestion?: (lineKey: string, item: SuggestedItem) => void;
  /** Notify parent of resolved party name per line (for multi-avatar) */
  onPartyNameChange?: (lineKey: string, name: string) => void;
}

export default function JournalForm({
  lines,
  accounts,
  onUpdateLine,
  onAddLine: _onAddLine,
  onAddLineAfter,
  onCopyLine,
  onRemoveLine,
  totals: _totals,
  validationErrors,
  departmentOptions,
  locationOptions,
  listPartiesFn,
  createPartyFn,
  partyOverrides,
  readOnly = false,
  onCreateCategory,
  onCategorySugQuery,
  categorySuggestions,
  onCreateCategorySuggestion,
  onPartyNameChange,
}: JournalFormProps) {
  const categoryOptions = useMemo(() => buildAccountOptions(accounts), [accounts]);

  // ── Read-only view ──
  if (readOnly) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className={labelClass}>
            <svg
              width="12"
              height="12"
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
            Lines
          </div>
          <div className="flex gap-8 text-xs font-medium text-[#64748b] dark:text-slate-400">
            <span className="w-20 text-right">Debit</span>
            <span className="w-20 text-right">Credit</span>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-[#e2e8f0] dark:border-slate-700 overflow-hidden">
          <div className="scroll-x scroll-x-shadow">
            <table className="w-full text-sm min-w-[34rem]">
              <thead>
                <tr className="bg-[#f9fafb] dark:bg-slate-700 border-b border-[#e2e8f0] dark:border-slate-600">
                  <th className="text-left p-3 text-[11px] font-medium text-[#6b7c93] dark:text-slate-400 uppercase tracking-wider w-8">
                    #
                  </th>
                  <th className="text-left p-3 text-[11px] font-medium text-[#6b7c93] dark:text-slate-400 uppercase tracking-wider">
                    Account / Description
                  </th>
                  <th className="text-right p-3 text-[11px] font-medium text-[#6b7c93] dark:text-slate-400 uppercase tracking-wider w-[100px]">
                    Debit
                  </th>
                  <th className="text-right p-3 text-[11px] font-medium text-[#6b7c93] dark:text-slate-400 uppercase tracking-wider w-[100px]">
                    Credit
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const acct = categoryOptions.find((o) => o.value === line.categoryId);
                  return (
                    <tr
                      key={line.key}
                      className="border-b border-[#f0f2f5] dark:border-slate-700 last:border-b-0"
                    >
                      <td className="p-3 text-[11px] font-semibold text-[#94a3b8] dark:text-slate-500 text-center">
                        {idx + 1}
                      </td>
                      <td className="p-3">
                        <div className="text-[#1e293b] dark:text-slate-200 font-medium">
                          {acct?.label || "—"}
                        </div>
                        {line.description && (
                          <div className="text-[11px] text-[#6b7c93] dark:text-slate-500 mt-0.5">
                            {line.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums text-[#1e293b] dark:text-slate-200">
                        {line.debit && Number.parseFloat(line.debit) > 0
                          ? `$${Number.parseFloat(line.debit).toFixed(2)}`
                          : ""}
                      </td>
                      <td className="p-3 text-right tabular-nums text-[#1e293b] dark:text-teal-300">
                        {line.credit && Number.parseFloat(line.credit) > 0
                          ? `$${Number.parseFloat(line.credit).toFixed(2)}`
                          : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Edit mode ──
  return (
    <div>
      {/* ── Section header — Mobile + Large desktop ── */}
      <div className="flex md:hidden lg:flex items-center justify-between mb-3">
        <div className={labelClass}>
          <svg
            width="12"
            height="12"
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
          Lines
        </div>
        {/* Debit/Credit header labels — lg+ only */}
        <div className="hidden lg:flex gap-8 text-xs font-medium text-[#64748b] dark:text-slate-400">
          <span className="w-20 text-right">Debit</span>
          <span className="w-20 text-right">Credit</span>
        </div>
      </div>
      {/* ── Section header — Medium devices: Lines + Debit/Credit in one row ── */}
      <div className="hidden md:flex lg:hidden items-center gap-2 mb-3">
        <span className="w-5 shrink-0" />
        <div className="flex-[2] min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#475569] dark:text-slate-400">
            <svg
              width="12"
              height="12"
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
            Lines
          </div>
        </div>
        <span className="flex-1 min-w-0 text-left text-xs font-medium text-[#64748b] dark:text-slate-400">
          Debit
        </span>
        <span className="flex-1 min-w-0 text-left text-xs font-medium text-[#64748b] dark:text-slate-400">
          Credit
        </span>
      </div>

      <div className="space-y-3 md:space-y-0">
        {lines.map((line, idx) => {
          const hasError = validationErrors.has(line.key);
          return (
            <div
              key={line.key}
              className="relative rounded-xl border border-[#e2e8f0] dark:border-slate-700 bg-[#fafbfc] dark:bg-slate-800/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden md:rounded-none md:border-0 md:border-b md:border-[#f0f2f5] md:dark:border-slate-800 md:bg-transparent md:dark:bg-transparent md:shadow-none md:overflow-visible md:last:border-b-0 md:py-3"
            >
              {/* ═══════════════════════════════════════════════
                  TABLET ONLY (md to lg): 3-row layout
                  ═══════════════════════════════════════════════ */}

              {/* Row 1: Line # · Description (flex-2) · Debit (flex-1) · Credit (flex-1) · Delete */}
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
                  value={line.debit}
                  onChange={(e) => onUpdateLine(line.key, "debit", e.target.value)}
                  placeholder="$0.00"
                  className="flex-1 min-w-0 text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={line.credit}
                  onChange={(e) => onUpdateLine(line.key, "credit", e.target.value)}
                  placeholder="$0.00"
                  className="flex-1 min-w-0 text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
              </div>

              {/* Row 2: Category (flex-1) · Party (flex-1) */}
              <div className="hidden md:flex lg:hidden items-center gap-2 pl-7 mb-2">
                <div className="flex-1 min-w-0">
                  <Combobox
                    value={line.categoryId}
                    onChange={(v) => onUpdateLine(line.key, "categoryId", v)}
                    options={categoryOptions}
                    placeholder="Category"
                    placeholderIcon={CATEGORY_ICON}
                    searchPlaceholder="Select or Create New"
                    className={
                      hasError
                        ? "[&>button]:border-orange-400 [&>button]:ring-1 [&>button]:ring-orange-400"
                        : ""
                    }
                    onCreate={onCreateCategory ? (q) => onCreateCategory(line.key, q) : undefined}
                    createLabel="category"
                    onSearch={onCategorySugQuery}
                    suggestions={categorySuggestions}
                    onCreateSuggestion={
                      onCreateCategorySuggestion
                        ? (item) => onCreateCategorySuggestion(line.key, item)
                        : undefined
                    }
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <CategoryPartyCombobox
                    value={line.partyId}
                    onChange={(v) => onUpdateLine(line.key, "partyId", v)}
                    onNameChange={
                      onPartyNameChange ? (n) => onPartyNameChange(line.key, n) : undefined
                    }
                    categoryId={line.categoryId}
                    flatAccounts={accounts}
                    listPartiesFn={listPartiesFn}
                    createPartyFn={createPartyFn}
                    overrides={partyOverrides}
                  />
                </div>
              </div>

              {/* Row 3: Department (flex-1) · Location (flex-1) · Delete · Copy · Add */}
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
                  {lines.length > 2 && (
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

              {/* Row 1: Line # · Description · Debit · Credit */}
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
                  value={line.debit}
                  onChange={(e) => onUpdateLine(line.key, "debit", e.target.value)}
                  placeholder="$0.00"
                  className="w-20 text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={line.credit}
                  onChange={(e) => onUpdateLine(line.key, "credit", e.target.value)}
                  placeholder="$0.00"
                  className="w-20 text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-md px-2 py-1.5 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)]"
                />
              </div>

              {/* Row 2: Combobox grid + action buttons */}
              <div className="hidden lg:flex items-center gap-2 pl-7">
                <div className="grid grid-cols-4 gap-2 flex-1">
                  <Combobox
                    value={line.categoryId}
                    onChange={(v) => onUpdateLine(line.key, "categoryId", v)}
                    options={categoryOptions}
                    placeholder="Category"
                    placeholderIcon={CATEGORY_ICON}
                    searchPlaceholder="Select or Create New"
                    className={
                      hasError
                        ? "[&>button]:border-orange-400 [&>button]:ring-1 [&>button]:ring-orange-400"
                        : ""
                    }
                    onCreate={onCreateCategory ? (q) => onCreateCategory(line.key, q) : undefined}
                    createLabel="category"
                    onSearch={onCategorySugQuery}
                    suggestions={categorySuggestions}
                    onCreateSuggestion={
                      onCreateCategorySuggestion
                        ? (item) => onCreateCategorySuggestion(line.key, item)
                        : undefined
                    }
                  />
                  <CategoryPartyCombobox
                    value={line.partyId}
                    onChange={(v) => onUpdateLine(line.key, "partyId", v)}
                    onNameChange={
                      onPartyNameChange ? (n) => onPartyNameChange(line.key, n) : undefined
                    }
                    categoryId={line.categoryId}
                    flatAccounts={accounts}
                    listPartiesFn={listPartiesFn}
                    createPartyFn={createPartyFn}
                    overrides={partyOverrides}
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
                  <button
                    type="button"
                    onClick={() => onRemoveLine(line.key)}
                    className={`w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center text-[#94a3b8] hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors ${lines.length <= 2 ? "invisible" : ""}`}
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

              {/* Card Header: Line # · Description · Delete */}
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

              {/* Debit · Credit (side by side, labeled) */}
              <div className="grid grid-cols-2 gap-2 px-3 pb-2 md:hidden">
                <div>
                  <label className="block text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider mb-1">
                    Debit
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={line.debit}
                    onChange={(e) => onUpdateLine(line.key, "debit", e.target.value)}
                    placeholder="$0.00"
                    className="w-full text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-lg px-3 py-2 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)] focus:ring-1 focus:ring-[var(--color-app-header-teal)] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider mb-1">
                    Credit
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={line.credit}
                    onChange={(e) => onUpdateLine(line.key, "credit", e.target.value)}
                    placeholder="$0.00"
                    className="w-full text-right bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 rounded-lg px-3 py-2 text-base sm:text-sm tabular-nums text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:border-[var(--color-app-header-teal)] focus:ring-1 focus:ring-[var(--color-app-header-teal)] transition-colors"
                  />
                </div>
              </div>

              {/* Category (full width) */}
              <div className="px-3 pb-2 md:hidden">
                <Combobox
                  value={line.categoryId}
                  onChange={(v) => onUpdateLine(line.key, "categoryId", v)}
                  options={categoryOptions}
                  placeholder="Category"
                  placeholderIcon={CATEGORY_ICON}
                  searchPlaceholder="Select or Create New"
                  className={
                    hasError
                      ? "[&>button]:border-orange-400 [&>button]:ring-1 [&>button]:ring-orange-400"
                      : ""
                  }
                  onCreate={onCreateCategory ? (q) => onCreateCategory(line.key, q) : undefined}
                  createLabel="category"
                  onSearch={onCategorySugQuery}
                  suggestions={categorySuggestions}
                  onCreateSuggestion={
                    onCreateCategorySuggestion
                      ? (item) => onCreateCategorySuggestion(line.key, item)
                      : undefined
                  }
                />
              </div>

              {/* Party (full width) */}
              <div className="px-3 pb-2 md:hidden">
                <CategoryPartyCombobox
                  value={line.partyId}
                  onChange={(v) => onUpdateLine(line.key, "partyId", v)}
                  onNameChange={
                    onPartyNameChange ? (n) => onPartyNameChange(line.key, n) : undefined
                  }
                  categoryId={line.categoryId}
                  flatAccounts={accounts}
                  listPartiesFn={listPartiesFn}
                  createPartyFn={createPartyFn}
                  overrides={partyOverrides}
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

              {/* Location · Copy · Add */}
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
                  {lines.length > 2 && (
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
