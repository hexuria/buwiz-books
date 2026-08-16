/**
 * Banks & Cards Page — Two-panel layout with account list + detail/create panel
 * Financial accounts (bank, checking, savings, credit cards) linked to COA
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { listFinancialAccounts } from "./api/-financial-accounts";
import { callServerFn } from "../lib/server-fn-client";
import { FinancialAccountCard } from "../components/banks/FinancialAccountCard";
import { FinancialAccountDetailPanel } from "../components/banks/FinancialAccountDetailPanel";
import { FinancialAccountForm } from "../components/banks/FinancialAccountForm";
import {
  StatusFilterChip,
  type StatusFilterValue,
} from "../components/accounts/StatusFilterPopover";
import { EntitySplitLayout } from "../components/layouts/EntitySplitLayout";

// ============================================================================
// Route Definition
// ============================================================================

interface BanksSearch {
  selected?: string;
  mode?: string; // "new" | "edit"
  status?: string; // "active" | "deactivated"
}

export const Route = createFileRoute("/entities/banks")({
  component: BanksPage,
  validateSearch(search: Record<string, unknown>): BanksSearch {
    return {
      selected: (search.selected as string) || undefined,
      mode: (search.mode as string) || undefined,
      status: (search.status as string) || undefined,
    };
  },
});

// ============================================================================
// Types
// ============================================================================

type SortKey = "name" | "recent";
type SortDir = "asc" | "desc";
type TypeFilterValue =
  | "checking"
  | "savings"
  | "credit_card"
  | "money_market"
  | "investment"
  | "other";
type AccountResult = {
  id: string;
  accountName: string;
  institutionName: string | null;
  institutionLogoUrl: string | null;
  accountType: string;
  lastFour: string | null;
  ledgerAccountId: string | null;
  isManual: boolean;
  connectionStatus: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  ledgerAccountName: string | null;
  ledgerAccountType: string | null;
};

// ============================================================================
// Bank Filter Popover — Status + Type multi-select
// ============================================================================

const TYPE_OPTIONS: { value: TypeFilterValue; label: string; color: string }[] = [
  { value: "checking", label: "Checking", color: "#3b82f6" },
  { value: "savings", label: "Savings", color: "#22c55e" },
  { value: "credit_card", label: "Credit Card", color: "#f97316" },
  { value: "money_market", label: "Money Market", color: "#8b5cf6" },
  { value: "investment", label: "Investment", color: "#06b6d4" },
  { value: "other", label: "Other", color: "#94a3b8" },
];

const STATUS_OPTIONS: { value: "active" | "deactivated"; label: string; color: string }[] = [
  { value: "active", label: "Active", color: "#22c55e" },
  { value: "deactivated", label: "Inactive", color: "#94a3b8" },
];

function BankFilterPopover({
  open,
  onClose,
  statusFilter,
  onStatusChange,
  typeFilter,
  onTypeChange,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  statusFilter: StatusFilterValue;
  onStatusChange: (v: StatusFilterValue) => void;
  typeFilter: TypeFilterValue[];
  onTypeChange: (v: TypeFilterValue[]) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (open && anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: rect.left });
    }
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (anchorRef?.current?.contains(e.target as Node)) return;
        onClose();
      }
    };
    const rafId = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
    });
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const toggleType = (value: TypeFilterValue) => {
    onTypeChange(
      typeFilter.includes(value) ? typeFilter.filter((t) => t !== value) : [...typeFilter, value],
    );
  };

  return createPortal(
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
          className="touch-target flex items-center justify-center w-6 h-6 rounded-full bg-transparent border-none cursor-pointer text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
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

      {/* Status Section */}
      <div className="border-b border-gray-200 dark:border-slate-700">
        <div className="flex items-center gap-2 px-4 py-3 font-semibold text-[0.85rem] text-slate-800 dark:text-slate-200">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ transform: "rotate(90deg)" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
          <span className="flex-1">Status</span>
          {statusFilter && (
            <span className="bg-[#2a9d8f] text-white text-[0.7rem] font-bold rounded-full w-5 h-5 flex items-center justify-center">
              1
            </span>
          )}
        </div>
        <div className="px-4 pb-3 pl-9">
          {STATUS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 py-1 cursor-pointer text-[0.85rem] text-gray-700 dark:text-slate-300"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: opt.color }} />
              <span className="flex-1">{opt.label}</span>
              <input
                type="radio"
                name="status-filter"
                checked={statusFilter === opt.value}
                onChange={() => onStatusChange(statusFilter === opt.value ? null : opt.value)}
                className="w-[18px] h-[18px] accent-[#2a9d8f] cursor-pointer"
              />
            </label>
          ))}
        </div>
      </div>

      {/* Type Section */}
      <div>
        <div className="flex items-center gap-2 px-4 py-3 font-semibold text-[0.85rem] text-slate-800 dark:text-slate-200">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ transform: "rotate(90deg)" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="2" y1="10" x2="22" y2="10" />
          </svg>
          <span className="flex-1">Type</span>
          {typeFilter.length > 0 && (
            <span className="bg-[#2a9d8f] text-white text-[0.7rem] font-bold rounded-full w-5 h-5 flex items-center justify-center">
              {typeFilter.length}
            </span>
          )}
        </div>
        <div className="px-4 pb-3 pl-9">
          {TYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 py-1 cursor-pointer text-[0.85rem] text-gray-700 dark:text-slate-300"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: opt.color }} />
              <span className="flex-1">{opt.label}</span>
              <input
                type="checkbox"
                checked={typeFilter.includes(opt.value)}
                onChange={() => toggleType(opt.value)}
                className="w-[18px] h-[18px] accent-[#2a9d8f] cursor-pointer"
              />
            </label>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================================
// Page Component
// ============================================================================

function BanksPage() {
  const search = Route.useSearch() as BanksSearch;
  const navigate = Route.useNavigate();

  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const handleSortToggle = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir("asc");
    }
  };
  const [typeFilter, setTypeFilter] = useState<TypeFilterValue[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  // Derive status filter from URL (default: "active")
  const statusFilter: StatusFilterValue = (search.status as StatusFilterValue) ?? "active";
  const setStatusFilter = (next: StatusFilterValue) => {
    navigate({
      search: {
        ...search,
        status: next === "active" ? undefined : (next ?? undefined),
      },
    });
  };

  // Fetch all financial accounts
  const { data: accounts = [], isLoading } = useQuery<AccountResult[]>({
    queryKey: ["financial-accounts"],
    queryFn: async (): Promise<AccountResult[]> =>
      await callServerFn(listFinancialAccounts, { data: {} }),
  });

  // Filter & sort
  const filtered = useMemo(() => {
    let results = accounts;

    // Apply status filter
    if (statusFilter === "active") {
      results = results.filter((a) => a.isActive);
    } else if (statusFilter === "deactivated") {
      results = results.filter((a) => !a.isActive);
    }

    // Apply type filter
    if (typeFilter.length > 0) {
      results = results.filter((a) => typeFilter.includes(a.accountType as TypeFilterValue));
    }

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      results = results.filter(
        (a) =>
          a.accountName.toLowerCase().includes(q) ||
          (a.institutionName && a.institutionName.toLowerCase().includes(q)) ||
          (a.lastFour && a.lastFour.includes(q)),
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...results].sort((a, b) => {
      if (sortBy === "recent") {
        const cmp = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        return dir * cmp;
      }
      return dir * a.accountName.localeCompare(b.accountName);
    });
  }, [accounts, searchTerm, sortBy, sortDir, statusFilter, typeFilter]);

  // Group by type for sidebar sections
  const bankAccounts = filtered.filter((a) => a.accountType !== "credit_card");
  const creditCards = filtered.filter((a) => a.accountType === "credit_card");

  const selectedAccount = accounts.find((a) => a.id === search.selected);
  const isNewMode = search.mode === "new";
  const isEditMode = search.mode === "edit" && selectedAccount;
  const showDetail = search.selected && !isEditMode;

  return (
    <EntitySplitLayout
      fullscreen={isNewMode}
      header={
        <div className="flex items-center justify-between px-8 py-5 border-b border-[#e2e8f0] dark:border-white/10">
          <div className="flex items-center gap-3">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-[#10b981]"
            >
              <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
              <line x1="1" y1="10" x2="23" y2="10" />
            </svg>
            <h1 className="text-xl font-semibold text-[#1e293b] dark:text-white">
              Banks &amp; Cards
            </h1>
            <span className="ml-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#e2e8f0] dark:bg-white/10 text-[#64748b] dark:text-white/50">
              {accounts.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate({ search: { mode: "new" } })}
              className="touch-target flex items-center gap-2 h-9 px-4 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
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
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Account
            </button>
          </div>
        </div>
      }
      sidebar={
        <>
          {/* Search + Sort + Filter */}
          <div className="px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Filter toggle button */}
              <button
                ref={filterBtnRef}
                type="button"
                onClick={() => setFilterOpen(!filterOpen)}
                className={`flex items-center p-1.5 rounded-md border-none cursor-pointer transition-colors ${
                  filterOpen
                    ? "bg-teal-50 text-teal-600"
                    : "bg-transparent text-slate-500 hover:text-teal-600"
                }`}
                title="Filters"
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
              <StatusFilterChip status={statusFilter} onClear={() => setStatusFilter(null)} />
              {typeFilter.map((tf) => {
                const opt = TYPE_OPTIONS.find((o) => o.value === tf);
                if (!opt) return null;
                return (
                  <span
                    key={tf}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[20px] text-xs font-semibold border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                  >
                    <span
                      className="w-[7px] h-[7px] rounded-full shrink-0"
                      style={{ background: opt.color }}
                    />
                    {opt.label}
                    <button
                      type="button"
                      className="bg-transparent border-none cursor-pointer p-0 flex items-center text-slate-400 dark:text-slate-500 text-[0.9rem] leading-none"
                      onClick={() => setTypeFilter((f) => f.filter((t) => t !== tf))}
                    >
                      ×
                    </button>
                  </span>
                );
              })}

              {/* Search input */}
              <input
                type="text"
                className="flex-1 min-w-[100px] border-none outline-none text-base sm:text-sm text-[var(--color-app-text-navy)] dark:text-white bg-transparent placeholder:text-[var(--color-app-text-light)] dark:placeholder:text-white/30"
                placeholder="Search for…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />

              {/* Clear all button */}
              {(statusFilter || typeFilter.length > 0) && (
                <button
                  type="button"
                  onClick={() => {
                    setStatusFilter(null);
                    setTypeFilter([]);
                  }}
                  className="bg-transparent border-none cursor-pointer text-teal-600 font-semibold text-xs whitespace-nowrap hover:text-teal-700 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Filter Popover — Bank-specific with Status + Type */}
            <BankFilterPopover
              open={filterOpen}
              onClose={() => setFilterOpen(false)}
              statusFilter={statusFilter}
              onStatusChange={setStatusFilter}
              typeFilter={typeFilter}
              onTypeChange={setTypeFilter}
              anchorRef={filterBtnRef}
            />

            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                Sort:
              </span>
              {(["name", "recent"] as SortKey[]).map((key) => {
                const isActive = sortBy === key;
                let label: string;
                if (key === "name") label = isActive && sortDir === "desc" ? "Z–A" : "A–Z";
                else label = isActive && sortDir === "desc" ? "Oldest" : "Recent";
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSortToggle(key)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      isActive
                        ? "bg-[#10b981]/10 text-[#10b981] dark:text-[#34d399]"
                        : "text-[#94a3b8] dark:text-white/40 hover:text-[#64748b] dark:hover:text-white/60"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Account list with sections */}
          <div className="flex-1 overflow-y-auto p-3">
            {isLoading ? (
              <AccountListSkeleton />
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-[#e2e8f0] dark:text-white/10 mb-3"
                >
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
                <p className="text-sm font-medium text-[#94a3b8] dark:text-white/40">
                  {searchTerm ? "No accounts match your search" : "No accounts yet"}
                </p>
                {!searchTerm && (
                  <button
                    type="button"
                    onClick={() => navigate({ search: { mode: "new" } })}
                    className="mt-3 text-sm text-[#10b981] hover:underline font-medium"
                  >
                    Add your first account
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {/* Bank Accounts Section */}
                {bankAccounts.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1.5">
                      <span className="text-base">🏦</span>
                      <span className="text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider">
                        Bank Accounts
                      </span>
                      <span className="ml-auto text-[10px] font-medium text-[#94a3b8] dark:text-white/30 px-1.5 py-0.5 rounded-full bg-[#f1f5f9] dark:bg-white/5">
                        {bankAccounts.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {bankAccounts.map((account) => (
                        <FinancialAccountCard
                          key={account.id}
                          account={account}
                          isSelected={account.id === search.selected}
                          onClick={() =>
                            navigate({
                              search: {
                                selected: account.id === search.selected ? undefined : account.id,
                                mode: undefined,
                              },
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Credit Cards Section */}
                {creditCards.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1.5">
                      <span className="text-base">💳</span>
                      <span className="text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider">
                        Credit Cards
                      </span>
                      <span className="ml-auto text-[10px] font-medium text-[#94a3b8] dark:text-white/30 px-1.5 py-0.5 rounded-full bg-[#f1f5f9] dark:bg-white/5">
                        {creditCards.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {creditCards.map((account) => (
                        <FinancialAccountCard
                          key={account.id}
                          account={account}
                          isSelected={account.id === search.selected}
                          onClick={() =>
                            navigate({
                              search: {
                                selected: account.id === search.selected ? undefined : account.id,
                                mode: undefined,
                              },
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      }
      content={(isSidebarOpen) =>
        isNewMode ? (
          <FinancialAccountForm onClose={() => navigate({ search: {} })} />
        ) : isEditMode && selectedAccount ? (
          <FinancialAccountForm
            initialData={selectedAccount}
            onClose={() => navigate({ search: { selected: selectedAccount.id } })}
          />
        ) : showDetail && search.selected ? (
          <FinancialAccountDetailPanel
            accountId={search.selected}
            onEdit={() => navigate({ search: { selected: search.selected, mode: "edit" } })}
            onDeleted={() => navigate({ search: {} })}
          />
        ) : (
          <div className="flex-1 flex flex-col">
            <div className="shrink-0 border-b border-[#e2e8f0] dark:border-white/10 h-[52px]" />
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mx-auto text-[#e2e8f0] dark:text-white/10 mb-4"
                >
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
                <p className="text-base text-[#94a3b8] dark:text-white/40 font-medium">
                  {isSidebarOpen
                    ? "Select an account to view details"
                    : "Toggle the sidebar to browse accounts"}
                </p>
                <p className="text-sm text-[#cbd5e1] dark:text-white/20 mt-1">
                  {isSidebarOpen
                    ? 'Or click "New Account" to add one'
                    : 'Or click "New Account" to create one'}
                </p>
              </div>
            </div>
          </div>
        )
      }
    />
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function AccountListSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="p-3.5 rounded-xl border border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] animate-pulse mb-2"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
            <div className="flex-1">
              <div className="h-3.5 w-32 rounded bg-[#e2e8f0] dark:bg-white/10 mb-1.5" />
              <div className="h-2.5 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
