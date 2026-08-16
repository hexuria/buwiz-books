/**
 * LedgerRow — Single transaction row in the Ledger
 * Uses CSS Grid for pixel-perfect header ↔ row alignment.
 *
 * Columns: Status | Date | Party | Source | Category | Department | Location | Amount | Balance | Chevron
 *
 * In edit mode, Party/Category/Department/Location render as inline Combobox dropdowns.
 * In card mode (small screens), renders as a stacked card with label/value rows.
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { TransactionType, JournalStatus } from "../../db/validation/journals";
import Combobox from "../ui/Combobox";
import type { ComboboxOption } from "../ui/Combobox";
import { formatCurrency } from "@/lib/format-currency";

// ============================================================================
// Shared Grid Template — used by both header rows and data rows
// ============================================================================

/**
 * Grid column template shared between LedgerRow and column-header rows.
 * StatusBar(4px) | Date(72px) | Party(1fr, min 140px) | Src(40px) |
 * Category(160px) | Department(130px) | Location(130px) | Debit(100px) |
 * Credit(100px) | Balance(110px) | Chevron(36px)
 */
export const LEDGER_GRID_COLS =
  "4px 72px minmax(140px, 1fr) 40px 160px 130px 130px 100px 100px 110px 36px";

/** Same grid but without the Balance column */
export const LEDGER_GRID_COLS_NO_BALANCE =
  "4px 72px minmax(140px, 1fr) 40px 160px 130px 130px 100px 100px 36px";

/**
 * Sum of the fixed tracks above. Fixed grid tracks never shrink, so below these widths the row
 * silently overflows a `overflow-hidden` ancestor instead of scrolling — the caller must put the
 * list inside a horizontal scroll container of at least this width for the grid to stay reachable.
 */
export const LEDGER_GRID_MIN_WIDTH = 1022;
/** Same, minus the 110px Balance track. */
export const LEDGER_GRID_MIN_WIDTH_NO_BALANCE = 912;
/** The selection checkbox sits outside the grid (`pl-3 pr-1` + a 16px box). */
export const LEDGER_CHECKBOX_WIDTH = 32;

// ============================================================================
// Types
// ============================================================================

export interface LedgerRowData {
  id: string;
  transactionNumber?: string | null;
  referenceNumber?: string | null;
  transactionDate: string;
  transactionType: TransactionType;
  memo?: string | null;
  partyId?: string | null;
  partyName?: string | null;
  totalAmount?: string | null;
  createdAt?: string | Date | null;
  status: JournalStatus;
  source: string;
  lineCount: number;
  // Account-specific fields (when filtered by account)
  accountDebit?: string | null;
  accountCredit?: string | null;
  categoryName?: string | null;
  categoryAccountId?: string | null;
  runningBalance?: string;
  // Dimensional fields
  departmentId?: string | null;
  departmentName?: string | null;
  locationId?: string | null;
  locationName?: string | null;
  // Creator info
  createdByName?: string | null;
}

/** Fields that can be edited inline */
export interface InlineEdits {
  partyId?: string;
  accountId?: string;
  departmentId?: string;
  locationId?: string;
  /** Identifies which journal line this edit targets (the account group's ID) */
  lineAccountId?: string;
  /** Transaction type — determines propagation rules */
  transactionType?: string;
}

interface LedgerRowProps {
  transaction: LedgerRowData;
  isSelected: boolean;
  showBalance: boolean;
  onSelect: (id: string) => void;
  // Batch Selection
  hasCheckbox?: boolean;
  isChecked?: boolean;
  onToggleSelection?: (id: string) => void;
  // Inline editing
  isEditMode?: boolean;
  pendingEdits?: InlineEdits;
  onFieldChange?: (
    id: string,
    field: keyof InlineEdits,
    value: string,
    lineAccountId?: string | null,
  ) => void;
  allParties?: ComboboxOption[];
  allCategories?: ComboboxOption[];
  allDepartments?: ComboboxOption[];
  allLocations?: ComboboxOption[];
  cardMode?: boolean;
  currency: string;
}

// ============================================================================
// Helpers
// ============================================================================

const SOURCE_CONFIG: Record<string, { label: string; color: string }> = {
  manual: { label: "M", color: "#64748b" },
  import: { label: "I", color: "#6366f1" },
  invoice: { label: "INV", color: "#0891b2" },
  bill: { label: "B", color: "#d97706" },
  reconciliation: { label: "R", color: "#16a34a" },
  system: { label: "S", color: "#8b5cf6" },
};

const STATUS_INDICATOR: Record<JournalStatus, { color: string }> = {
  draft: { color: "#fbbf24" },
  posted: { color: "#22c55e" },
  voided: { color: "#ef4444" },
};

function formatDate(dateStr: string): { day: string; month: string; year: string } {
  const date = new Date(`${dateStr}T00:00:00`);
  return {
    day: date.toLocaleDateString("en-US", { day: "numeric" }),
    month: date.toLocaleDateString("en-US", { month: "short" }),
    year: date.toLocaleDateString("en-US", { year: "numeric" }),
  };
}

function getDebitCredit(
  txn: LedgerRowData,
  currency: string,
): {
  debit: string | null;
  credit: string | null;
} {
  // If we have per-account amounts (grouped/filtered view), show raw values
  if (txn.accountDebit || txn.accountCredit) {
    const debit = Number.parseFloat(txn.accountDebit ?? "0");
    const credit = Number.parseFloat(txn.accountCredit ?? "0");
    return {
      debit: debit > 0 ? formatCurrency(debit.toFixed(2), currency) : null,
      credit: credit > 0 ? formatCurrency(credit.toFixed(2), currency) : null,
    };
  }
  // Fallback: infer column from transaction type
  const num = Number.parseFloat(txn.totalAmount ?? "0");
  if (num === 0) return { debit: null, credit: null };
  const amt = formatCurrency(Math.abs(num).toFixed(2), currency);
  // Pay-out = expense = debit side; Pay-in = revenue = credit side
  if (txn.transactionType === "pay_out") return { debit: amt, credit: null };
  if (txn.transactionType === "pay_in") return { debit: null, credit: amt };
  // Journal/transfer default to debit
  return { debit: amt, credit: null };
}

function getPartyInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Stable color from string for party avatar
function stringToColor(str: string): string {
  const colors = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#84cc16",
    "#22c55e",
    "#14b8a6",
    "#06b6d4",
    "#3b82f6",
    "#6366f1",
    "#a855f7",
    "#ec4899",
    "#f43f5e",
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// ============================================================================
// Inline Combobox wrapper — compact, fits inside the row
// ============================================================================

function InlineDropdown({
  options,
  value,
  displayLabel,
  placeholder,
  onChange,
}: {
  options: ComboboxOption[];
  value: string | undefined;
  displayLabel: string | null | undefined;
  placeholder: string;
  onChange: (val: string) => void;
}) {
  return (
    <div
      className="w-full"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Combobox
        options={options}
        value={value ?? ""}
        onChange={onChange}
        placeholder={placeholder}
        searchPlaceholder={`Find ${placeholder.toLowerCase()}...`}
        displayValue={displayLabel ?? undefined}
      />
    </div>
  );
}

// ============================================================================
// Card Mode Component (small screens)
// ============================================================================

interface LedgerCardProps {
  transaction: LedgerRowData;
  isSelected: boolean;
  onSelect: (id: string) => void;
  showBalance: boolean;
  effectivePartyId: string | undefined;
  effectivePartyName: string | null | undefined;
  effectiveCategoryId: string | undefined;
  effectiveCategoryName: string | null | undefined;
  effectiveDeptId: string | undefined;
  effectiveDeptName: string | null | undefined;
  effectiveLocId: string | undefined;
  effectiveLocName: string | null | undefined;
  debitDisplay: string | null;
  creditDisplay: string | null;
  month: string;
  day: string;
  year: string;
  statusColor: string;
  partyColor: string;
  sourceConf: { label: string; color: string };
  hasCheckbox?: boolean;
  isChecked?: boolean;
  onToggleSelection?: (id: string) => void;
  isEditMode?: boolean;
  hasPendingEdits?: boolean;
  onFieldChange: (field: keyof InlineEdits, value: string) => void;
  allParties: ComboboxOption[];
  allCategories: ComboboxOption[];
  allDepartments: ComboboxOption[];
  allLocations: ComboboxOption[];
  currency: string;
}

/**
 * Card presentation below `md`.
 *
 * Field priority (responsive-ui §4.1): the party identifies the row, the debit/credit figure is
 * what the reader came for, and date/category/dimension are the supporting fields. Source and
 * creator degrade to a chip; everything else lives on the transaction detail page.
 *
 * Debit and credit share one right-hand rail rather than two columns: a journal line sits on one
 * side, so the pair reads as one signed figure plus a Dr/Cr marker, and the running balance stacks
 * directly beneath it so the balance column still scans vertically down the card list.
 */
function LedgerCard({
  transaction,
  isSelected,
  onSelect,
  showBalance,
  effectivePartyId,
  effectivePartyName,
  effectiveCategoryId,
  effectiveCategoryName,
  effectiveDeptId,
  effectiveDeptName,
  effectiveLocId,
  effectiveLocName,
  debitDisplay,
  creditDisplay,
  month,
  day,
  year,
  statusColor,
  partyColor,
  sourceConf,
  hasCheckbox,
  isChecked,
  onToggleSelection,
  isEditMode,
  hasPendingEdits,
  onFieldChange,
  allParties,
  allCategories,
  allDepartments,
  allLocations,
  currency,
}: LedgerCardProps) {
  const isUnposted = transaction.status !== "posted";
  const dimensions = [effectiveDeptName, effectiveLocName].filter(Boolean).join(" · ");
  const sourceLabel =
    transaction.source === "manual" && transaction.createdByName
      ? transaction.createdByName
      : transaction.source;

  // Edit mode carries category and the dimensions in its own labelled fields, so repeating them
  // here would just push the amount off the fold.
  const secondary = isEditMode
    ? [`${month} ${day}, ${year}`]
    : [`${month} ${day}, ${year}`, effectiveCategoryName, dimensions].filter(Boolean);

  return (
    <div
      data-testid={`ledger-row-${transaction.id}`}
      className={`border-b px-4 py-3 transition-colors duration-100 ${
        hasPendingEdits
          ? "bg-[#f0fdfa] dark:bg-teal-950/30 border-[#99f6e4] dark:border-teal-900/50"
          : isSelected
            ? "bg-[#eff6ff] dark:bg-blue-950/60 border-[#dbeafe] dark:border-blue-900/40"
            : "border-[#f1f5f9] dark:border-slate-800"
      }`}
    >
      <div className="flex items-start gap-3">
        {hasCheckbox && (
          <button
            type="button"
            role="checkbox"
            aria-checked={!!isChecked}
            aria-label="Select transaction"
            data-testid={`row-checkbox-${transaction.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelection?.(transaction.id);
            }}
            // A real 44×44 box rather than `.touch-target`: an expanded pseudo-element here would
            // overhang the card body and turn "open the transaction" into "toggle selection".
            className="-my-1 -ml-2 flex h-11 w-11 shrink-0 items-center justify-center"
          >
            <span
              aria-hidden="true"
              className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
                isChecked
                  ? "bg-[var(--color-app-header-teal,#2dd4bf)] border-[var(--color-app-header-teal,#2dd4bf)]"
                  : "bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600"
              }`}
            >
              {isChecked && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="11.6666 3.5 5.24992 9.91667 2.33325 7" />
                </svg>
              )}
            </span>
          </button>
        )}

        {/* The identity block is the tap target for the detail view; the checkbox and the inline
            editors stay siblings so neither ends up nested inside the anchor. */}
        <Link
          to="/transactions/$transactionId"
          params={{ transactionId: transaction.id }}
          className="flex min-w-0 flex-1 items-start gap-3"
          onClick={(e) => {
            e.preventDefault();
            onSelect(transaction.id);
          }}
        >
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
            style={{ backgroundColor: partyColor }}
          >
            {getPartyInitials(effectivePartyName)}
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[#1e293b] dark:text-slate-100">
              {effectivePartyName || transaction.memo || "Untitled"}
            </span>
            {transaction.memo && effectivePartyName && (
              <span className="mt-0.5 block truncate text-xs text-[#94a3b8] dark:text-slate-500">
                {transaction.memo}
              </span>
            )}
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-[#64748b] dark:text-slate-400">
              {/* Order is fixed and the values are plain strings, so index keys are stable. */}
              {secondary.map((item, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true">·</span>}
                  <span className="truncate">{item}</span>
                </span>
              ))}
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {isUnposted && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f8fafc] px-2 py-0.5 text-xs font-medium capitalize text-[#475569] dark:bg-slate-800 dark:text-slate-300">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: statusColor }}
                  />
                  {transaction.status}
                </span>
              )}
              <span className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full bg-[#f8fafc] px-2 py-0.5 text-xs font-medium text-[#475569] dark:bg-slate-800 dark:text-slate-300">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: sourceConf.color }}
                />
                <span className="truncate capitalize">{sourceLabel}</span>
              </span>
            </span>
          </span>

          {/* Money never truncates and never wraps — it is why the user opened this page. */}
          <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
            {debitDisplay && <CardAmount tag="Dr" value={debitDisplay} />}
            {creditDisplay && <CardAmount tag="Cr" value={creditDisplay} credit />}
            {!debitDisplay && !creditDisplay && (
              <span className="text-sm text-[#cbd5e1] dark:text-slate-600">—</span>
            )}
            {showBalance && transaction.runningBalance && (
              <span className="tabular-figures text-xs whitespace-nowrap text-[#64748b] dark:text-slate-400">
                Bal {formatCurrency(transaction.runningBalance, currency)}
              </span>
            )}
          </span>
        </Link>
      </div>

      {isEditMode && (
        // The combobox trigger is a 38px control everywhere else; on a phone it has to clear 44px.
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 [&_[role=combobox]]:min-h-11">
          <CardEditField label="Party">
            <InlineDropdown
              options={allParties}
              value={effectivePartyId}
              displayLabel={effectivePartyName}
              placeholder="Party"
              onChange={(val) => onFieldChange("partyId", val)}
            />
          </CardEditField>
          <CardEditField label="Category">
            <InlineDropdown
              options={allCategories}
              value={effectiveCategoryId}
              displayLabel={effectiveCategoryName}
              placeholder="Category"
              onChange={(val) => onFieldChange("accountId", val)}
            />
          </CardEditField>
          <CardEditField label="Department">
            <InlineDropdown
              options={allDepartments}
              value={effectiveDeptId}
              displayLabel={effectiveDeptName}
              placeholder="Department"
              onChange={(val) => onFieldChange("departmentId", val)}
            />
          </CardEditField>
          <CardEditField label="Location">
            <InlineDropdown
              options={allLocations}
              value={effectiveLocId}
              displayLabel={effectiveLocName}
              placeholder="Location"
              onChange={(val) => onFieldChange("locationId", val)}
            />
          </CardEditField>
        </div>
      )}
    </div>
  );
}

function CardAmount({ tag, value, credit }: { tag: string; value: string; credit?: boolean }) {
  return (
    <span className="flex items-baseline justify-end gap-1 whitespace-nowrap">
      <span className="text-xs font-medium text-[#94a3b8] dark:text-slate-500">{tag}</span>
      <span
        className={`tabular-figures text-[15px] font-semibold ${
          credit ? "text-[#16a34a] dark:text-emerald-400" : "text-[#1e293b] dark:text-slate-100"
        }`}
      >
        {value}
      </span>
    </span>
  );
}

function CardEditField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium tracking-wider text-[#94a3b8] uppercase dark:text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

// ============================================================================
// Component
// ============================================================================

export default function LedgerRow({
  transaction,
  isSelected,
  showBalance,
  onSelect,
  hasCheckbox,
  isChecked,
  onToggleSelection,
  isEditMode,
  pendingEdits,
  onFieldChange,
  allParties = [],
  allCategories = [],
  allDepartments = [],
  allLocations = [],
  cardMode,
  currency,
}: LedgerRowProps) {
  const { day, month, year } = formatDate(transaction.transactionDate);
  const { debit: debitDisplay, credit: creditDisplay } = getDebitCredit(transaction, currency);
  const sourceConf = SOURCE_CONFIG[transaction.source] ?? SOURCE_CONFIG.manual;
  const statusColor = STATUS_INDICATOR[transaction.status].color;
  const hasPendingEdits = pendingEdits && Object.keys(pendingEdits).length > 0;

  // Wrap onFieldChange to automatically include line context (lineAccountId + transactionType)
  // so the server knows which journal line to target and what propagation rules to apply.
  // Pass categoryAccountId as 4th arg so the parent can build a composite key per journal line.
  const handleFieldChange = (field: keyof InlineEdits, value: string) => {
    if (!onFieldChange) return;
    const lineAccId = transaction.categoryAccountId;
    // First set the actual field the user changed
    onFieldChange(transaction.id, field, value, lineAccId);
    // Then ensure line context is always set (idempotent — set on every change)
    if (lineAccId) {
      onFieldChange(transaction.id, "lineAccountId", lineAccId, lineAccId);
    }
    onFieldChange(transaction.id, "transactionType", transaction.transactionType, lineAccId);
  };

  // Resolve display values: pending edit → original data
  const effectivePartyId = pendingEdits?.partyId ?? transaction.partyId ?? undefined;
  const effectivePartyName =
    pendingEdits?.partyId != null
      ? (allParties.find((p) => p.value === pendingEdits.partyId)?.label ?? transaction.partyName)
      : transaction.partyName;
  const effectiveCategoryId = pendingEdits?.accountId ?? transaction.categoryAccountId ?? undefined;
  const effectiveCategoryName =
    pendingEdits?.accountId != null
      ? (allCategories.find((c) => c.value === pendingEdits.accountId)?.label ??
        transaction.categoryName)
      : transaction.categoryName;
  const effectiveDeptId = pendingEdits?.departmentId ?? transaction.departmentId ?? undefined;
  const effectiveDeptName =
    pendingEdits?.departmentId != null
      ? (allDepartments.find((d) => d.value === pendingEdits.departmentId)?.label ??
        transaction.departmentName)
      : transaction.departmentName;
  const effectiveLocId = pendingEdits?.locationId ?? transaction.locationId ?? undefined;
  const effectiveLocName =
    pendingEdits?.locationId != null
      ? (allLocations.find((l) => l.value === pendingEdits.locationId)?.label ??
        transaction.locationName)
      : transaction.locationName;

  const partyColor = effectivePartyName ? stringToColor(effectivePartyName) : "#94a3b8";

  // ── Card mode (small screens) ──
  if (cardMode) {
    return (
      <LedgerCard
        transaction={transaction}
        isSelected={isSelected}
        onSelect={onSelect}
        showBalance={showBalance}
        effectivePartyId={effectivePartyId}
        effectivePartyName={effectivePartyName}
        effectiveCategoryId={effectiveCategoryId}
        effectiveCategoryName={effectiveCategoryName}
        effectiveDeptId={effectiveDeptId}
        effectiveDeptName={effectiveDeptName}
        effectiveLocId={effectiveLocId}
        effectiveLocName={effectiveLocName}
        debitDisplay={debitDisplay}
        creditDisplay={creditDisplay}
        month={month}
        day={day}
        year={year}
        statusColor={statusColor}
        partyColor={partyColor}
        sourceConf={sourceConf}
        hasCheckbox={hasCheckbox}
        isChecked={isChecked}
        onToggleSelection={onToggleSelection}
        isEditMode={isEditMode}
        hasPendingEdits={hasPendingEdits}
        onFieldChange={handleFieldChange}
        allParties={allParties}
        allCategories={allCategories}
        allDepartments={allDepartments}
        allLocations={allLocations}
        currency={currency}
      />
    );
  }

  // ── Grid mode (medium / large screens) ──
  const gridTemplate = showBalance ? LEDGER_GRID_COLS : LEDGER_GRID_COLS_NO_BALANCE;

  return (
    <div
      data-testid={`ledger-row-${transaction.id}`}
      className={`group flex items-center cursor-pointer border-b transition-colors duration-100 ${
        hasPendingEdits
          ? "bg-[#f0fdfa] dark:bg-teal-950/30 border-[#99f6e4] dark:border-teal-900/50"
          : isSelected
            ? "bg-[#eff6ff] dark:bg-blue-950/60 border-[#dbeafe] dark:border-blue-900/40"
            : "border-[#f1f5f9] dark:border-slate-800 hover:bg-[#fafbfc] dark:hover:bg-slate-800"
      }`}
      onClick={() => onSelect(transaction.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(transaction.id)}
      role="button"
      tabIndex={0}
    >
      {/* Selection Checkbox — outside grid to preserve column alignment */}
      {hasCheckbox && (
        <div
          data-testid={`row-checkbox-${transaction.id}`}
          className="pl-3 pr-1 py-3 flex items-center justify-center shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelection?.(transaction.id);
          }}
        >
          <div
            className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
              isChecked
                ? "bg-[var(--color-app-header-teal,#2dd4bf)] border-[var(--color-app-header-teal,#2dd4bf)]"
                : "bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 group-hover:border-gray-400"
            }`}
          >
            {isChecked && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 14 14"
                fill="none"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="11.6666 3.5 5.24992 9.91667 2.33325 7" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Grid row */}
      <div
        className="grid items-center flex-1 min-w-0"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {/* Status indicator bar */}
        <div className="self-stretch">
          {transaction.status !== "posted" && (
            <div className="w-1 h-full" style={{ backgroundColor: statusColor }} />
          )}
        </div>

        {/* Date */}
        <div className="py-2.5 px-2 text-center">
          <div className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100 leading-tight">
            {month} {day}
          </div>
          <div className="text-[10px] text-[#94a3b8] dark:text-slate-500">{year}</div>
        </div>

        {/* Party */}
        <div className="flex items-center gap-2.5 py-2.5 px-2 min-w-0">
          {isEditMode ? (
            <div className="flex items-center gap-2 w-full min-w-0">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                style={{ backgroundColor: partyColor }}
              >
                {getPartyInitials(effectivePartyName)}
              </div>
              <div className="flex-1 min-w-0">
                <InlineDropdown
                  options={allParties}
                  value={effectivePartyId ?? undefined}
                  displayLabel={effectivePartyName}
                  placeholder="Party"
                  onChange={(val) => handleFieldChange("partyId", val)}
                />
              </div>
            </div>
          ) : (
            <>
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                style={{ backgroundColor: partyColor }}
              >
                {getPartyInitials(effectivePartyName)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[#1e293b] dark:text-slate-100 truncate">
                  {effectivePartyName || transaction.memo || "Untitled"}
                </div>
                {transaction.memo && effectivePartyName && (
                  <div className="text-[11px] text-[#94a3b8] dark:text-slate-500 truncate">
                    {transaction.memo}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Source icon */}
        <div className="flex items-center justify-center">
          {transaction.source === "manual" && transaction.createdByName ? (
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[8px] font-bold"
              style={{ backgroundColor: stringToColor(transaction.createdByName) }}
              title={transaction.createdByName}
            >
              {getPartyInitials(transaction.createdByName)}
            </div>
          ) : (
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[8px] font-bold"
              style={{ backgroundColor: sourceConf.color }}
              title={transaction.source}
            >
              {sourceConf.label}
            </div>
          )}
        </div>

        {/* Category */}
        <div className="py-2.5 px-2">
          {isEditMode ? (
            <InlineDropdown
              options={allCategories}
              value={effectiveCategoryId ?? undefined}
              displayLabel={effectiveCategoryName}
              placeholder="Category"
              onChange={(val) => handleFieldChange("accountId", val)}
            />
          ) : effectiveCategoryName ? (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#94a3b8] shrink-0" />
              <span className="text-[12px] text-[#475569] dark:text-slate-300 truncate">
                {effectiveCategoryName}
              </span>
            </div>
          ) : (
            <span className="text-[11px] text-[#cbd5e1] dark:text-slate-600 italic">—</span>
          )}
        </div>

        {/* Department */}
        <div className="py-2.5 px-2">
          {isEditMode ? (
            <InlineDropdown
              options={allDepartments}
              value={effectiveDeptId ?? undefined}
              displayLabel={effectiveDeptName}
              placeholder="Department"
              onChange={(val) => handleFieldChange("departmentId", val)}
            />
          ) : effectiveDeptName ? (
            <span className="text-[12px] text-[#475569] dark:text-slate-300 truncate block">
              {effectiveDeptName}
            </span>
          ) : (
            <span className="text-[11px] text-[#cbd5e1] dark:text-slate-600 italic">None</span>
          )}
        </div>

        {/* Location */}
        <div className="py-2.5 px-2">
          {isEditMode ? (
            <InlineDropdown
              options={allLocations}
              value={effectiveLocId ?? undefined}
              displayLabel={effectiveLocName}
              placeholder="Location"
              onChange={(val) => handleFieldChange("locationId", val)}
            />
          ) : effectiveLocName ? (
            <span className="text-[12px] text-[#475569] dark:text-slate-300 truncate block">
              {effectiveLocName}
            </span>
          ) : (
            <span className="text-[11px] text-[#cbd5e1] dark:text-slate-600 italic">None</span>
          )}
        </div>

        {/* Debit */}
        <div className="py-2.5 px-2 text-right">
          {debitDisplay && (
            <span className="text-[13px] font-semibold tabular-nums text-[#1e293b] dark:text-slate-100">
              {debitDisplay}
            </span>
          )}
        </div>

        {/* Credit */}
        <div className="py-2.5 px-2 text-right">
          {creditDisplay && (
            <span className="text-[13px] font-semibold tabular-nums text-[#16a34a] dark:text-emerald-400">
              {creditDisplay}
            </span>
          )}
        </div>

        {/* Running balance */}
        {showBalance && (
          <div className="py-2.5 px-2 text-right">
            <span className="text-[12px] text-[#64748b] dark:text-slate-400 tabular-nums">
              {transaction.runningBalance
                ? formatCurrency(transaction.runningBalance, currency)
                : "—"}
            </span>
          </div>
        )}

        {/* Chevron */}
        <div className="flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
      {/* End grid row */}
    </div>
  );
}
