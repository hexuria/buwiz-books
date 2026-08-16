/**
 * AccountGroupedList — account-grouped transaction view
 * Shows transactions grouped by account with:
 *   - Collapsible sticky account headers (chevron + icon badge)
 *   - Per-account "Load More" pagination
 *   - Auto-switching pinned header via IntersectionObserver
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { formatCurrency } from "@/lib/format-currency";
import LedgerRow, { LEDGER_GRID_COLS } from "./LedgerRow";
import type { LedgerRowData, InlineEdits } from "./LedgerRow";
import type { ComboboxOption } from "../ui/Combobox";
import { ICON_PATHS } from "../accounts/icons";

// ============================================================================
// Types
// ============================================================================

export interface AccountGroup {
  accountId: string;
  accountName: string;
  accountNumber?: string | null;
  accountType: string;
  accountSubtype?: string | null;
  accountIcon?: string | null;
  parentPath: string[];
  balance: string;
  transactionCount: number;
  transactions: LedgerRowData[];
  hasMore: boolean;
}

interface AccountGroupedListProps {
  groups: AccountGroup[];
  isLoading: boolean;
  error: Error | null;
  onSelectTransaction: (id: string) => void;
  selectedTransactionId?: string;
  onLoadMore: (accountId: string) => void;
  loadingAccountIds?: Set<string>;
  // Batch Selection
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelection?: (id: string) => void;
  // Inline editing
  isEditMode?: boolean;
  pendingEditsMap?: Map<string, InlineEdits>;
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
  /** Small-screen card mode — renders LedgerRows as cards (the column headers hide in CSS) */
  isSmallScreen?: boolean;
  /** When true, all category groups are collapsed (balances-only view) */
  allCollapsed?: boolean;
  /** Called when manual toggle changes whether all groups are collapsed */
  /** Called when manual toggle changes whether all groups are collapsed */
  onAllCollapsedChange?: (collapsed: boolean) => void;
  currency: string;
}

// ============================================================================
// Helpers
// ============================================================================

const TYPE_COLORS: Record<string, { bg: string; text: string; darkBg: string; darkText: string }> =
  {
    asset: {
      bg: "#dcfce7",
      text: "#16a34a",
      darkBg: "rgba(22, 163, 74, 0.15)",
      darkText: "#4ade80",
    },
    liability: {
      bg: "#fef3c7",
      text: "#d97706",
      darkBg: "rgba(217, 119, 6, 0.15)",
      darkText: "#fbbf24",
    },
    equity: {
      bg: "#dbeafe",
      text: "#2563eb",
      darkBg: "rgba(37, 99, 235, 0.15)",
      darkText: "#60a5fa",
    },
    revenue: {
      bg: "#d1fae5",
      text: "#059669",
      darkBg: "rgba(5, 150, 105, 0.15)",
      darkText: "#34d399",
    },
    expense: {
      bg: "#fee2e2",
      text: "#dc2626",
      darkBg: "rgba(220, 38, 38, 0.15)",
      darkText: "#f87171",
    },
    cost_of_goods_sold: {
      bg: "#fce7f3",
      text: "#db2777",
      darkBg: "rgba(219, 39, 119, 0.15)",
      darkText: "#f472b6",
    },
    cost_of_revenue: {
      bg: "#fce7f3",
      text: "#db2777",
      darkBg: "rgba(219, 39, 119, 0.15)",
      darkText: "#f472b6",
    },
    other_income: {
      bg: "#e0e7ff",
      text: "#4f46e5",
      darkBg: "rgba(79, 70, 229, 0.15)",
      darkText: "#818cf8",
    },
    other_expense: {
      bg: "#fef9c3",
      text: "#ca8a04",
      darkBg: "rgba(202, 138, 4, 0.15)",
      darkText: "#facc15",
    },
  };

function formatTypeName(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ============================================================================
// AccountGroupHeader —: chevron + icon badge + name + balance
// ============================================================================

function AccountGroupHeader({
  group,
  expanded,
  onToggle,
  isPinned,
  selectionMode,
  checkState,
  onToggleAll,
  currency,
}: {
  group: AccountGroup;
  expanded: boolean;
  onToggle: () => void;
  isPinned: boolean;
  selectionMode?: boolean;
  checkState?: "all" | "some" | "none";
  onToggleAll?: () => void;
  currency: string;
}) {
  const typeConf = TYPE_COLORS[group.accountType] ?? {
    bg: "#f1f5f9",
    text: "#64748b",
    darkBg: "rgba(100, 116, 139, 0.15)",
    darkText: "#94a3b8",
  };
  // Compute normal balance based on account type (DEA-LER convention)
  const totalDebit = Number.parseFloat(group.balance.split("|")[0] ?? "0");
  const totalCredit = Number.parseFloat(group.balance.split("|")[1] ?? "0");
  const isDEA = [
    "asset",
    "expense",
    "cost_of_goods_sold",
    "cost_of_revenue",
    "other_expense",
  ].includes(group.accountType);
  const normalBalance = isDEA ? totalDebit - totalCredit : totalCredit - totalDebit;
  const isNegative = normalBalance < 0;
  const iconPath = group.accountIcon ? ICON_PATHS[group.accountIcon] : null;

  return (
    <div
      className={`group/header flex min-h-11 items-center gap-2 px-3 py-3 md:min-h-0 md:py-2.5 cursor-pointer select-none transition-colors ${
        isPinned
          ? "bg-white dark:bg-slate-800 shadow-sm"
          : "bg-[#fafbfc] dark:bg-slate-800/50 hover:bg-[#f1f5f9] dark:hover:bg-slate-800"
      }`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {/* Single icon slot — shows icon by default, chevron on hover.
          Touch has no hover, so below `md` the slot is the chevron permanently: without it the
          collapse control is invisible and the header reads as a static label. */}
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
        style={{
          backgroundColor: typeConf.bg,
          color: typeConf.text,
        }}
      >
        {/* Default: show icon */}
        <span className="hidden md:flex md:group-hover/header:hidden items-center justify-center">
          {iconPath ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              dangerouslySetInnerHTML={{ __html: iconPath }}
            />
          ) : (
            <span className="text-[10px] font-bold">
              {formatTypeName(group.accountType).charAt(0)}
            </span>
          )}
        </span>
        {/* Hover (or always, on small screens): chevron — down if expanded, right if collapsed */}
        <span className="flex md:hidden md:group-hover/header:flex items-center justify-center">
          {expanded ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          )}
        </span>
      </div>

      {/* Checkbox — edit mode only, to the right of the icon.
          The 16px box is its own hit area on desktop; below `md` it gets a real 44px button around
          it. `.touch-target` is not usable here: the expanded pseudo-element would overlap the
          header body and turn "collapse the group" into "select every row in it". */}
      {selectionMode && (
        <button
          type="button"
          role="checkbox"
          aria-checked={checkState === "all" ? true : checkState === "some" ? "mixed" : false}
          aria-label="Select all transactions in this account"
          className="-my-1 -ml-1 flex h-11 w-11 items-center justify-center shrink-0 md:m-0 md:h-auto md:w-auto"
          onClick={(e) => {
            e.stopPropagation();
            onToggleAll?.();
          }}
        >
          <span
            aria-hidden="true"
            className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
              checkState !== "none"
                ? "bg-[var(--color-app-header-teal,#2dd4bf)] border-[var(--color-app-header-teal,#2dd4bf)]"
                : "bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600"
            }`}
          >
            {checkState === "all" ? (
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
            ) : checkState === "some" ? (
              <svg
                width="10"
                height="10"
                viewBox="0 0 14 14"
                fill="none"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
              >
                <line x1="3" y1="7" x2="11" y2="7" />
              </svg>
            ) : null}
          </span>
        </button>
      )}

      {/* Account info */}
      <div className="flex-1 min-w-0">
        {/* Parent path breadcrumb */}
        {group.parentPath.length > 0 && (
          <div className="flex items-center gap-1 text-[11px] md:text-[10px] text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider leading-tight">
            {group.parentPath.map((segment, i) => (
              <span key={segment} className="flex items-center gap-1">
                {i > 0 && (
                  <svg
                    width="7"
                    height="7"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="opacity-40"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                )}
                <span>{segment}</span>
              </span>
            ))}
          </div>
        )}
        {/* Account name + number */}
        <div className="flex items-center gap-2">
          <span className="text-sm md:text-[13px] font-semibold text-[#1e293b] dark:text-slate-100 truncate">
            {group.accountName}
          </span>
          {group.accountNumber && (
            <span className="text-[11px] text-[#94a3b8] dark:text-slate-500 tabular-nums shrink-0">
              {group.accountNumber}
            </span>
          )}
        </div>
      </div>

      {/* Balance + count — money never truncates, so the block keeps its intrinsic width */}
      <div className="text-right shrink-0">
        <div
          className={`text-[15px] md:text-[14px] font-bold tabular-nums whitespace-nowrap ${
            isNegative ? "text-[#dc2626] dark:text-red-400" : "text-[#1e293b] dark:text-slate-100"
          }`}
        >
          {formatCurrency(Math.abs(normalBalance).toFixed(2), currency)}
        </div>
        <div className="text-[11px] md:text-[10px] text-[#94a3b8] dark:text-slate-500 whitespace-nowrap">
          {group.transactionCount}{" "}
          <span className="hidden sm:inline">
            Transaction{group.transactionCount !== 1 ? "s" : ""}
          </span>
          <span className="sm:hidden">txn{group.transactionCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export default function AccountGroupedList({
  groups,
  isLoading,
  error,
  onSelectTransaction,
  selectedTransactionId,
  onLoadMore,
  loadingAccountIds = new Set(),
  selectionMode,
  selectedIds,
  onToggleSelection,
  isEditMode,
  pendingEditsMap,
  onFieldChange,
  allParties,
  allCategories,
  allDepartments,
  allLocations,
  isSmallScreen,
  allCollapsed,
  onAllCollapsedChange,
  currency,
}: AccountGroupedListProps) {
  // Track which groups the user has explicitly collapsed
  const userCollapsed = useRef<Set<string>>(new Set());

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const [pinnedGroupId, setPinnedGroupId] = useState<string | null>(null);
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Expand all groups with transactions on initial load, but respect user collapses
  useEffect(() => {
    if (allCollapsed) {
      setExpandedGroups(new Set());
      return;
    }
    setExpandedGroups(() => {
      const next = new Set<string>();
      for (const g of groups) {
        if (g.transactions.length > 0 && !userCollapsed.current.has(g.accountId)) {
          next.add(g.accountId);
        }
      }
      return next;
    });
  }, [groups, allCollapsed]);

  // IntersectionObserver for auto-switching pinned header
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || groups.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let topMostEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (
              !topMostEntry ||
              entry.boundingClientRect.top < topMostEntry.boundingClientRect.top
            ) {
              topMostEntry = entry;
            }
          }
        }
        if (topMostEntry) {
          const id = (topMostEntry.target as HTMLElement).dataset.groupId;
          if (id) setPinnedGroupId(id);
        }
      },
      {
        root: container,
        rootMargin: "-1px 0px -90% 0px",
        threshold: 0,
      },
    );

    for (const [, el] of groupRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [groups]);

  const toggleGroup = useCallback(
    (accountId: string) => {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(accountId)) {
          next.delete(accountId);
          userCollapsed.current.add(accountId);
        } else {
          next.add(accountId);
          userCollapsed.current.delete(accountId);
        }
        // Sync collapse state with parent
        onAllCollapsedChange?.(next.size === 0);
        return next;
      });
    },
    [onAllCollapsedChange],
  );

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-center h-48">
          <div className="flex items-center gap-2 text-[#94a3b8] dark:text-slate-500 text-sm">
            <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
              <path
                d="M12 2a10 10 0 019.95 9"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
            Loading transactions...
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-center h-48">
          <div className="text-[#ef4444] dark:text-red-400 text-sm">Error: {error.message}</div>
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col items-center justify-center h-48 gap-3">
          <div className="w-12 h-12 rounded-xl bg-[#f1f5f9] dark:bg-slate-800 flex items-center justify-center">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.5"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <div className="text-[#64748b] dark:text-slate-400 text-sm">No transactions found</div>
        </div>
      </div>
    );
  }

  return (
    // The bottom tab bar overlaps the last rows below `lg`, so the list needs more slack there
    // than it does on desktop.
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto pb-24 md:pb-20">
      {groups.map((group) => {
        const isExpanded = expandedGroups.has(group.accountId);
        const isPinned = pinnedGroupId === group.accountId;
        const isLoadingMore = loadingAccountIds.has(group.accountId);

        return (
          <div
            key={group.accountId}
            ref={(el) => {
              if (el) {
                groupRefs.current.set(group.accountId, el);
              } else {
                groupRefs.current.delete(group.accountId);
              }
            }}
            data-group-id={group.accountId}
          >
            {/* Sticky group header */}
            <div className="sticky top-0 z-10">
              <AccountGroupHeader
                group={group}
                expanded={isExpanded}
                onToggle={() => toggleGroup(group.accountId)}
                isPinned={isPinned}
                selectionMode={selectionMode}
                checkState={
                  selectionMode && selectedIds
                    ? group.transactions.length > 0 &&
                      group.transactions.every((t) => selectedIds.has(`${t.id}-${group.accountId}`))
                      ? "all"
                      : group.transactions.some((t) =>
                            selectedIds.has(`${t.id}-${group.accountId}`),
                          )
                        ? "some"
                        : "none"
                    : "none"
                }
                onToggleAll={() => {
                  if (!onToggleSelection) return;
                  const compositeIds = group.transactions.map((t) => `${t.id}-${group.accountId}`);
                  const allSelected = compositeIds.every((id) => selectedIds?.has(id));
                  for (const id of compositeIds) {
                    if (allSelected || !selectedIds?.has(id)) {
                      onToggleSelection(id);
                    }
                  }
                }}
                currency={currency}
              />
            </div>

            {/* Expanded content: column headers + transaction rows */}
            {isExpanded && group.transactions.length > 0 && (
              <div>
                {/* Column headers for this group. Gated in CSS rather than on `isSmallScreen` so
                    the first paint is correct: the card rows below carry their own labels. */}
                <div
                  className="hidden md:grid items-center border-b border-[#e5e7eb] dark:border-slate-700 bg-[#f8fafc] dark:bg-slate-800"
                  style={{ gridTemplateColumns: LEDGER_GRID_COLS }}
                >
                  <div />
                  <div className="px-2 py-1 text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider text-center">
                    Date
                  </div>
                  <div className="px-2 py-1 text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Party
                  </div>
                  <div className="py-1 text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider text-center">
                    Src
                  </div>
                  <div className="px-2 py-1 text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Category
                  </div>
                  <div className="px-2 py-1 text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Department
                  </div>
                  <div className="px-2 py-1 text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Location
                  </div>
                  <div className="px-2 py-1 text-right text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Debit
                  </div>
                  <div className="px-2 py-1 text-right text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Credit
                  </div>
                  <div className="px-2 py-1 text-right text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 uppercase tracking-wider">
                    Balance
                  </div>
                  <div />
                </div>

                {/* Transaction rows */}
                {group.transactions.map((txn) => {
                  const selectionId = `${txn.id}-${group.accountId}`;
                  return (
                    <LedgerRow
                      key={selectionId}
                      transaction={txn}
                      isSelected={selectedTransactionId === txn.id}
                      showBalance={true}
                      onSelect={onSelectTransaction}
                      hasCheckbox={selectionMode}
                      isChecked={selectedIds?.has(selectionId)}
                      onToggleSelection={() => onToggleSelection?.(selectionId)}
                      isEditMode={isEditMode}
                      pendingEdits={
                        pendingEditsMap?.get(
                          txn.categoryAccountId ? `${txn.id}:${txn.categoryAccountId}` : txn.id,
                        ) ?? pendingEditsMap?.get(txn.id)
                      }
                      onFieldChange={onFieldChange}
                      allParties={allParties}
                      allCategories={allCategories}
                      allDepartments={allDepartments}
                      allLocations={allLocations}
                      cardMode={isSmallScreen}
                      currency={currency}
                    />
                  );
                })}

                {/* Load More button */}
                {group.hasMore && (
                  <div className="flex justify-center py-2 border-b border-[#e5e7eb] dark:border-slate-700 bg-white dark:bg-slate-900">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLoadMore(group.accountId);
                      }}
                      disabled={isLoadingMore}
                      className="inline-flex min-h-11 items-center justify-center px-4 py-2 text-[13px] font-medium text-[var(--color-app-header-teal,#2ba89e)] hover:text-[#248f82] bg-transparent hover:bg-[#f0fdf9] dark:hover:bg-teal-900/20 rounded-md transition-colors disabled:opacity-50 md:min-h-0 md:py-1.5 md:text-[12px]"
                    >
                      {isLoadingMore ? (
                        <span className="flex items-center gap-1.5">
                          <svg
                            className="animate-spin"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                          >
                            <circle
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="3"
                              opacity="0.25"
                            />
                            <path
                              d="M12 2a10 10 0 019.95 9"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                            />
                          </svg>
                          Loading more...
                        </span>
                      ) : (
                        "Load More"
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
