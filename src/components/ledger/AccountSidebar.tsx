/**
 * AccountSidebar — COA tree sidebar for the Ledger
 * hierarchical account tree with lookup search, expand/collapse,
 * transaction count badges, hover checkboxes, and account selection
 */
import { useState, useMemo, useCallback } from "react";
import { ICON_PATHS } from "../accounts/icons";

// ============================================================================
// Types
// ============================================================================

export interface SidebarAccount {
  id: string;
  name: string;
  accountNumber?: string | null;
  accountType: string;
  parentId?: string | null;
  children?: SidebarAccount[];
  transactionCount?: number;
  icon?: string | null;
}

interface AccountSidebarProps {
  accounts: SidebarAccount[];
  selectedAccountId?: string | null;
  onSelectAccount: (id: string | null) => void;
  accountBalances?: Record<string, { balance: string; count: number }>;
  /** Set of checked account IDs for category filtering */
  checkedAccountIds?: Set<string>;
  /** Callback when a category checkbox is toggled */
  onToggleAccount?: (accountId: string, account: SidebarAccount) => void;
}

// ============================================================================
// Constants
// ============================================================================

const TYPE_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  asset: { bg: "#dcfce7", text: "#16a34a", label: "Assets" },
  liability: { bg: "#fef3c7", text: "#d97706", label: "Liabilities" },
  equity: { bg: "#dbeafe", text: "#2563eb", label: "Equity" },
  revenue: { bg: "#d1fae5", text: "#059669", label: "Revenue" },
  expense: { bg: "#fee2e2", text: "#dc2626", label: "Expenses" },
  cost_of_goods_sold: { bg: "#fce7f3", text: "#db2777", label: "Cost of Sales" },
  cost_of_revenue: { bg: "#fce7f3", text: "#db2777", label: "Cost of Revenue" },
  other_income: { bg: "#e0e7ff", text: "#4f46e5", label: "Other Income" },
  other_expense: { bg: "#fef9c3", text: "#ca8a04", label: "Other Expense" },
};

// ============================================================================
// Helpers
// ============================================================================

/** Recursively collect all descendant IDs from an account */
function getAllDescendantIds(account: SidebarAccount): string[] {
  const ids: string[] = [account.id];
  if (account.children) {
    for (const child of account.children) {
      ids.push(...getAllDescendantIds(child));
    }
  }
  return ids;
}

/** Determine the check state of a node given the set of checked IDs */
function getCheckState(account: SidebarAccount, checkedIds: Set<string>): "none" | "some" | "all" {
  if (!account.children || account.children.length === 0) {
    return checkedIds.has(account.id) ? "all" : "none";
  }
  const allIds = getAllDescendantIds(account);
  // Don't include the parent itself — just descendants
  const descendantIds = allIds.slice(1);
  const checkedCount = descendantIds.filter((id) => checkedIds.has(id)).length;
  // Also check self
  const selfChecked = checkedIds.has(account.id);
  if (selfChecked && checkedCount === descendantIds.length) return "all";
  if (selfChecked || checkedCount > 0) return "some";
  return "none";
}

/** Get total transaction count for an account and all its descendants */
function getTotalCount(
  account: SidebarAccount,
  balances?: Record<string, { balance: string; count: number }>,
): number {
  if (!balances) return 0;
  let total = balances[account.id]?.count ?? 0;
  if (account.children) {
    for (const child of account.children) {
      total += getTotalCount(child, balances);
    }
  }
  return total;
}

// ============================================================================
// Checkbox Component
// ============================================================================

function SidebarCheckbox({
  state,
  onClick,
}: {
  state: "none" | "some" | "all";
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-[18px] h-[18px] rounded border flex items-center justify-center shrink-0 transition-all duration-100 cursor-pointer"
      style={{
        borderColor: state !== "none" ? "#2a9d8f" : "#cbd5e1",
        backgroundColor: state !== "none" ? "#2a9d8f" : "transparent",
      }}
    >
      {state === "all" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {state === "some" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )}
    </button>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function AccountNode({
  account,
  depth,
  isSelected,
  onSelect,
  balances,
  checkedIds,
  onToggle,
  selectedAccountId,
}: {
  account: SidebarAccount;
  depth: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  balances?: Record<string, { balance: string; count: number }>;
  checkedIds?: Set<string>;
  onToggle?: (accountId: string, account: SidebarAccount) => void;
  selectedAccountId?: string | null;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [hovered, setHovered] = useState(false);
  const hasChildren = account.children && account.children.length > 0;
  const isRoot = depth === 0;
  const typeConf = TYPE_COLORS[account.accountType] ?? {
    bg: "#f1f5f9",
    text: "#64748b",
    label: account.accountType,
  };

  const count = isRoot ? getTotalCount(account, balances) : (balances?.[account.id]?.count ?? 0);

  const iconPath =
    account.parentId === null || isRoot
      ? account.icon
        ? ICON_PATHS[account.icon as string]
        : null
      : null;
  const childIconPath = !isRoot && account.icon ? ICON_PATHS[account.icon as string] : null;

  const checkState = checkedIds ? getCheckState(account, checkedIds) : "none";

  const showCheckbox = hovered || checkState !== "none";

  const handleCheckboxClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle?.(account.id, account);
    },
    [onToggle, account],
  );

  return (
    <div>
      <div
        className={`group/node w-full flex items-center gap-2 px-3 py-[7px] text-left transition-colors duration-100 cursor-pointer ${
          isSelected
            ? "bg-[#e6f7f5] dark:bg-slate-700 border-r-2 border-[var(--color-app-header-teal)]"
            : "hover:bg-[#f8fafc] dark:hover:bg-slate-800"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Icon box — doubles as expand/collapse toggle (matches Category Manager pattern) */}
        {hasChildren ? (
          <button
            type="button"
            className={`${isRoot ? "w-7 h-7 rounded-lg" : "w-6 h-6 rounded-md"} min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center shrink-0 border-none cursor-pointer transition-colors`}
            style={{ backgroundColor: isRoot ? typeConf.bg : "transparent", color: typeConf.text }}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <>
                {/* Expanded: show icon by default, chevron-down on hover */}
                <span className="group-hover/node:hidden flex items-center justify-center">
                  {isRoot && iconPath ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      dangerouslySetInnerHTML={{ __html: iconPath }}
                    />
                  ) : childIconPath ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      dangerouslySetInnerHTML={{ __html: childIconPath }}
                    />
                  ) : isRoot ? (
                    <span className="text-[11px] font-bold">{typeConf.label[0]}</span>
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />
                  )}
                </span>
                <span className="hidden group-hover/node:flex items-center justify-center">
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
                </span>
              </>
            ) : (
              <>
                {/* Collapsed: show icon by default, chevron-right on hover */}
                <span className="group-hover/node:hidden flex items-center justify-center">
                  {isRoot && iconPath ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      dangerouslySetInnerHTML={{ __html: iconPath }}
                    />
                  ) : childIconPath ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      dangerouslySetInnerHTML={{ __html: childIconPath }}
                    />
                  ) : isRoot ? (
                    <span className="text-[11px] font-bold">{typeConf.label[0]}</span>
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />
                  )}
                </span>
                <span className="hidden group-hover/node:flex items-center justify-center">
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
                </span>
              </>
            )}
          </button>
        ) : isRoot ? (
          <span
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 dark:!bg-current/15 transition-colors"
            style={{ backgroundColor: typeConf.bg, color: typeConf.text }}
          >
            {iconPath ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                dangerouslySetInnerHTML={{ __html: iconPath }}
              />
            ) : (
              <span className="text-[11px] font-bold">{typeConf.label[0]}</span>
            )}
          </span>
        ) : (
          <span
            className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
            style={{ color: typeConf.text }}
          >
            {childIconPath ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                dangerouslySetInnerHTML={{ __html: childIconPath }}
              />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />
            )}
          </span>
        )}

        {/* Name + account code — clicking selects the account */}
        <span
          className={`flex-1 min-w-0 ${
            isRoot
              ? "text-[13px] font-semibold text-[#1e293b] dark:text-slate-100"
              : "text-[12px] text-[#475569] dark:text-slate-400"
          }`}
          title={`${account.name}${account.accountNumber ? ` ${account.accountNumber}` : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren && isRoot) {
              setExpanded(!expanded);
            } else {
              onSelect(account.id);
            }
          }}
          onKeyDown={() => {}}
          role="button"
          tabIndex={-1}
        >
          <span className="block truncate">{account.name}</span>
          {account.accountNumber && (
            <span className="block text-[10px] text-[#94a3b8] dark:text-slate-500 leading-tight">
              {account.accountNumber}
            </span>
          )}
        </span>

        {/* Right side: checkbox on hover, count otherwise */}
        {onToggle && showCheckbox ? (
          <SidebarCheckbox state={checkState} onClick={handleCheckboxClick} />
        ) : count > 0 ? (
          <span className="text-[10px] font-medium text-[#94a3b8] tabular-nums shrink-0">
            {count}
          </span>
        ) : null}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div>
          {account.children!.map((child) => (
            <AccountNode
              key={child.id}
              account={child}
              depth={depth + 1}
              isSelected={child.id === selectedAccountId}
              onSelect={onSelect}
              balances={balances}
              checkedIds={checkedIds}
              onToggle={onToggle}
              selectedAccountId={selectedAccountId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export { getAllDescendantIds };

export default function AccountSidebar({
  accounts,
  selectedAccountId,
  onSelectAccount,
  accountBalances,
  checkedAccountIds,
  onToggleAccount,
}: AccountSidebarProps) {
  const [search, setSearch] = useState("");

  // Filter accounts by search
  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return accounts;
    const q = search.toLowerCase();
    const filterTree = (accs: SidebarAccount[]): SidebarAccount[] => {
      return accs
        .map((acc) => {
          const nameMatch = acc.name.toLowerCase().includes(q);
          const numMatch = acc.accountNumber?.toLowerCase().includes(q);
          const filteredChildren = acc.children ? filterTree(acc.children) : [];
          if (nameMatch || numMatch || filteredChildren.length > 0) {
            return {
              ...acc,
              children: filteredChildren.length > 0 ? filteredChildren : acc.children,
            };
          }
          return null;
        })
        .filter(Boolean) as SidebarAccount[];
    };
    return filterTree(accounts);
  }, [accounts, search]);

  return (
    <div className="flex flex-col h-full bg-[#f8fafc] dark:bg-slate-900 border-r border-[#e5e7eb] dark:border-slate-700">
      {/* Lookup search */}
      <div className="px-3 py-2.5 border-b border-[#e5e7eb] dark:border-slate-700">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94a3b8]"
            width="13"
            height="13"
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
            placeholder="Lookup..."
            className="w-full pl-8 pr-3 py-1.5 rounded-md bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-600 text-base sm:text-[12px] text-[#1e293b] dark:text-slate-200 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:border-[var(--color-app-header-teal)] dark:focus:border-teal-500 focus:ring-1 focus:ring-[var(--color-app-header-teal)] dark:focus:ring-teal-500 transition-all"
          />
        </div>
      </div>

      {/* Account tree */}
      <div className="flex-1 overflow-y-auto">
        {filteredAccounts.map((account) => (
          <AccountNode
            key={account.id}
            account={account}
            depth={0}
            isSelected={selectedAccountId === account.id}
            onSelect={onSelectAccount}
            balances={accountBalances}
            checkedIds={checkedAccountIds}
            onToggle={onToggleAccount}
            selectedAccountId={selectedAccountId}
          />
        ))}
      </div>
    </div>
  );
}
