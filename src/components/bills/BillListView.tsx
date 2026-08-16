/**
 * BillListView — Expandable status-grouped list with filters & column toggles
 * Mobile responsive: rows → stacked cards below 768px
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BillListItem } from "../../routes/api/-bills";
import BillFilters from "./BillFilters";
import { FilterBar } from "../ui/Actions";
import { useIsMobile } from "../../hooks/useBreakpoint";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Types
// ============================================================================

interface BillListViewProps {
  bills: BillListItem[];
  isPending: boolean;
}

interface StatusGroup {
  key: string;
  label: string;
  statuses: string[];
  color: string;
  bgColor: string;
  /** SVG path(s) for the status-specific icon (24x24 viewBox) */
  iconPaths: string[];
}

type ColumnKey =
  | "billNumber"
  | "vendor"
  | "billDate"
  | "dueDate"
  | "status"
  | "amount"
  | "balanceDue"
  | "approver"
  | "memo";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_GROUPS: StatusGroup[] = [
  {
    key: "in_review",
    label: "In Review",
    statuses: ["in_review"],
    color: "#10b981",
    bgColor: "rgba(16,185,129,0.08)",
    iconPaths: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.35-4.35"],
  },
  {
    key: "pending_approval",
    label: "Pending Approval",
    statuses: ["pending_approval"],
    color: "#f59e0b",
    bgColor: "rgba(245,158,11,0.08)",
    iconPaths: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  },
  {
    key: "awaiting_payment",
    label: "Awaiting Payment",
    statuses: ["awaiting_payment", "approved", "scheduled"],
    color: "#8b5cf6",
    bgColor: "rgba(139,92,246,0.08)",
    iconPaths: [
      "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z",
      "M12 6v6l4 2",
    ],
  },
  {
    key: "paid",
    label: "Paid",
    statuses: ["paid"],
    color: "#3b82f6",
    bgColor: "rgba(59,130,246,0.08)",
    iconPaths: ["M22 11.08V12a10 10 0 1 1-5.93-9.14", "M22 4L12 14.01l-3-3"],
  },
  {
    key: "voided",
    label: "Voided",
    statuses: ["voided"],
    color: "#6b7280",
    bgColor: "rgba(107,114,128,0.08)",
    iconPaths: ["M18.36 5.64a9 9 0 1 1-12.73 0 9 9 0 0 1 12.73 0z", "M4.93 4.93l14.14 14.14"],
  },
];

const COLUMNS: ColumnDef[] = [
  { key: "billNumber", label: "Bill #", defaultVisible: true },
  { key: "vendor", label: "Vendor", defaultVisible: true },
  { key: "billDate", label: "Bill Date", defaultVisible: true },
  { key: "dueDate", label: "Due Date", defaultVisible: true },
  { key: "status", label: "Status", defaultVisible: true },
  { key: "amount", label: "Amount", defaultVisible: true },
  { key: "balanceDue", label: "Balance Due", defaultVisible: true },
  { key: "approver", label: "Approver", defaultVisible: false },
  { key: "memo", label: "Memo", defaultVisible: false },
];

const DEFAULT_STATUSES = ["in_review", "pending_approval", "awaiting_payment", "paid"];

/** Kept in step with `BillFilters` — the popover and the sheet must offer the same choices. */
const DATE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "30", label: "Past 30 Days" },
  { value: "90", label: "Past 90 Days" },
  { value: "180", label: "Past 6 Months" },
  { value: "365", label: "Past 1 Year" },
];

/** Desktop grid track floor. Below this the columns squash into each other instead of scrolling. */
const MIN_COLUMN_WIDTH_PX = 128;

// ============================================================================
// Helpers
// ============================================================================

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getDaysOverdue(dueDate: string): number {
  const now = new Date();
  const due = new Date(`${dueDate}T00:00:00`);
  return Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
}

function getVendorInitial(name: string | null): string {
  if (!name) return "?";
  return name.charAt(0).toUpperCase();
}

function getVendorColor(name: string | null): string {
  if (!name) return "#94a3b8";
  const colors = [
    "#8b5cf6",
    "#ec4899",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#ef4444",
    "#14b8a6",
    "#6366f1",
  ];
  let hash = 0;
  for (const c of name) hash = hash + c.charCodeAt(0);
  return colors[hash % colors.length];
}

function isWithinDateRange(dateStr: string, days: string): boolean {
  if (days === "all") return true;
  const d = new Date(`${dateStr}T00:00:00`);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  return diff <= Number.parseInt(days, 10);
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    in_review: "In Review",
    pending_approval: "Pending",
    approved: "Approved",
    awaiting_payment: "Awaiting",
    scheduled: "Scheduled",
    paid: "Paid",
    voided: "Voided",
  };
  return map[status] ?? status;
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    draft: "#94a3b8",
    in_review: "#10b981",
    pending_approval: "#f59e0b",
    approved: "#8b5cf6",
    awaiting_payment: "#8b5cf6",
    scheduled: "#3b82f6",
    paid: "#3b82f6",
    voided: "#6b7280",
  };
  return map[status] ?? "#94a3b8";
}

// ============================================================================
// Component
// ============================================================================

export function BillListView({ bills, isPending }: BillListViewProps) {
  // The row grid and the card list cannot share a DOM tree, and the collapse animation needs to
  // know which one it is measuring, so this is one of the cases the hook exists for.
  const isMobile = useIsMobile();

  // Filter state — persisted to localStorage
  const [activeStatuses, setActiveStatuses] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("bills-active-statuses");
      if (saved) return JSON.parse(saved) as string[];
    } catch {}
    return DEFAULT_STATUSES;
  });
  const [dateFilter, setDateFilter] = useState("all");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Column visibility — persisted to localStorage
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(() => {
    try {
      const saved = localStorage.getItem("bills-visible-columns");
      if (saved) return JSON.parse(saved) as ColumnKey[];
    } catch {}
    return COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
  });
  const [columnDropdownOpen, setColumnDropdownOpen] = useState(false);

  // Expanded groups
  const [expandedGroups, setExpandedGroups] = useState<string[]>(STATUS_GROUPS.map((g) => g.key));

  // Filter panel open
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Persist to localStorage on change
  useEffect(() => {
    localStorage.setItem("bills-active-statuses", JSON.stringify(activeStatuses));
  }, [activeStatuses]);

  useEffect(() => {
    localStorage.setItem("bills-visible-columns", JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  // Toggle helpers
  const toggleStatus = useCallback((status: string) => {
    setActiveStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    );
  }, []);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) =>
      prev.includes(key) ? prev.filter((g) => g !== key) : [...prev, key],
    );
  };

  const toggleColumn = (key: ColumnKey) => {
    setVisibleColumns((prev) =>
      prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key],
    );
  };

  const handleAmountChange = useCallback((min: string, max: string) => {
    setAmountMin(min);
    setAmountMax(max);
  }, []);

  const clearAllFilters = useCallback(() => {
    setActiveStatuses([]);
    setDateFilter("all");
    setAmountMin("");
    setAmountMax("");
    setOverdueOnly(false);
    setFiltersOpen(false);
  }, []);

  // ── Build filter chips ──
  const filterChips = useMemo(() => {
    const chips: { id: string; label: string }[] = [];

    const statusLabels: Record<string, string> = {
      in_review: "In Review",
      pending_approval: "Pending Approval",
      awaiting_payment: "Awaiting Payment",
      paid: "Paid",
      voided: "Voided",
    };
    for (const s of activeStatuses) {
      chips.push({ id: `status-${s}`, label: statusLabels[s] ?? s });
    }

    if (dateFilter !== "all") {
      const dateLabels: Record<string, string> = {
        "30": "Past 30 Days",
        "90": "Past 90 Days",
        "180": "Past 6 Months",
        "365": "Past 1 Year",
      };
      chips.push({ id: "date", label: dateLabels[dateFilter] ?? dateFilter });
    }

    if (amountMin || amountMax) {
      const label =
        amountMin && amountMax
          ? `$${amountMin} – $${amountMax}`
          : amountMin
            ? `≥ $${amountMin}`
            : `≤ $${amountMax}`;
      chips.push({ id: "amount", label });
    }

    if (overdueOnly) {
      chips.push({ id: "overdue", label: "Overdue Only" });
    }

    return chips;
  }, [activeStatuses, dateFilter, amountMin, amountMax, overdueOnly]);

  const handleRemoveChip = useCallback(
    (chipId: string) => {
      if (chipId.startsWith("status-")) {
        const status = chipId.slice(7);
        toggleStatus(status);
      } else if (chipId === "date") {
        setDateFilter("all");
      } else if (chipId === "amount") {
        setAmountMin("");
        setAmountMax("");
      } else if (chipId === "overdue") {
        setOverdueOnly(false);
      }
    },
    [toggleStatus],
  );

  const hasActiveFilters =
    activeStatuses.length > 0 ||
    dateFilter !== "all" ||
    amountMin !== "" ||
    amountMax !== "" ||
    overdueOnly;

  // Filter bills
  const filtered = useMemo(() => {
    return bills.filter((bill) => {
      // Status filter — if statuses selected, match against them; if none selected, show all
      if (activeStatuses.length > 0) {
        const matchesStatusGroup = activeStatuses.some((groupKey) => {
          const group = STATUS_GROUPS.find((g) => g.key === groupKey);
          return group ? group.statuses.includes(bill.status) : false;
        });
        if (!matchesStatusGroup) return false;
      }

      // Date filter
      if (!isWithinDateRange(bill.billDate, dateFilter)) return false;

      // Amount range
      const amount = Number.parseFloat(bill.amount);
      if (amountMin && amount < Number.parseFloat(amountMin)) return false;
      if (amountMax && amount > Number.parseFloat(amountMax)) return false;

      // Text search (unified: bill # + vendor)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesBillNum = (bill.billNumber ?? "").toLowerCase().includes(q);
        const matchesVendor = (bill.vendorName ?? "").toLowerCase().includes(q);
        if (!matchesBillNum && !matchesVendor) return false;
      }

      // Overdue only
      if (overdueOnly) {
        if (bill.status === "paid" || bill.status === "voided" || getDaysOverdue(bill.dueDate) <= 0)
          return false;
      }

      return true;
    });
  }, [bills, activeStatuses, dateFilter, amountMin, amountMax, searchQuery, overdueOnly]);

  // Group filtered bills
  const grouped = useMemo(() => {
    const map: Record<string, BillListItem[]> = {};
    for (const group of STATUS_GROUPS) {
      map[group.key] = filtered.filter((bill) => group.statuses.includes(bill.status));
    }
    return map;
  }, [filtered]);

  // Determine which groups to show (those with matching statuses OR all if no filter)
  const visibleGroups = useMemo(() => {
    if (activeStatuses.length === 0) return STATUS_GROUPS;
    return STATUS_GROUPS.filter((g) => activeStatuses.includes(g.key));
  }, [activeStatuses]);

  if (isPending) {
    return <ListSkeleton />;
  }

  const hasChips = filterChips.length > 0;
  const activeColumns = COLUMNS.filter((c) => visibleColumns.includes(c.key));

  // Sheet body for the mobile filters. Same state and handlers as the desktop popover
  // (`BillFilters`), re-laid out for touch: no nested disclosures, 44px rows, 16px inputs.
  const sectionHeadingClass =
    "text-xs font-semibold tracking-wider text-[#94a3b8] uppercase dark:text-white/40";
  const rowClass =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-sm text-[#374151] dark:text-slate-300";
  const amountInputClass =
    "h-11 w-full rounded-lg border border-[#e2e8f0] bg-white pr-3 pl-7 text-base text-[#1e293b] placeholder-[#cbd5e1] focus:border-[var(--color-app-header-teal)] focus:ring-1 focus:ring-[var(--color-app-header-teal)] focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-600";

  const billFilterFields = (
    <>
      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearAllFilters}
          className="min-h-11 self-start text-sm font-semibold text-[var(--color-app-header-teal)]"
        >
          Clear all filters
        </button>
      )}

      <section className="flex flex-col gap-1">
        <h3 className={sectionHeadingClass}>Status</h3>
        {STATUS_GROUPS.map((group) => (
          <label key={group.key} className={rowClass}>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: group.color }}
            />
            <span className="flex-1">{group.label}</span>
            <input
              type="checkbox"
              checked={activeStatuses.includes(group.key)}
              onChange={() => toggleStatus(group.key)}
              className="h-5 w-5 shrink-0 rounded"
              style={{ accentColor: "var(--color-app-header-teal)" }}
            />
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={sectionHeadingClass}>Amount</h3>
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-medium text-[#94a3b8] dark:text-slate-500">
              Min
            </span>
            <div className="relative">
              <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm text-[#94a3b8] dark:text-slate-500">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amountMin}
                onChange={(e) =>
                  handleAmountChange(e.target.value.replace(/[^0-9.,]/g, ""), amountMax)
                }
                placeholder="0.00"
                className={amountInputClass}
              />
            </div>
          </label>
          <span className="pb-3 text-sm text-[#94a3b8]">—</span>
          <label className="flex-1">
            <span className="mb-1 block text-xs font-medium text-[#94a3b8] dark:text-slate-500">
              Max
            </span>
            <div className="relative">
              <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm text-[#94a3b8] dark:text-slate-500">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amountMax}
                onChange={(e) =>
                  handleAmountChange(amountMin, e.target.value.replace(/[^0-9.,]/g, ""))
                }
                placeholder="0.00"
                className={amountInputClass}
              />
            </div>
          </label>
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className={sectionHeadingClass}>Date range</h3>
        {DATE_OPTIONS.map((opt) => (
          <label key={opt.value} className={rowClass}>
            <span className="flex-1">{opt.label}</span>
            <input
              type="radio"
              name="billDateFilterSheet"
              checked={dateFilter === opt.value}
              onChange={() => setDateFilter(opt.value)}
              className="h-5 w-5 shrink-0"
              style={{ accentColor: "var(--color-app-header-teal)" }}
            />
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className={sectionHeadingClass}>Overdue</h3>
        <label className={rowClass}>
          <span className="flex-1">Show only overdue bills</span>
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={() => setOverdueOnly(!overdueOnly)}
            className="h-5 w-5 shrink-0 rounded"
            style={{ accentColor: "var(--color-app-header-teal)" }}
          />
        </label>
      </section>
    </>
  );

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {/* ── Search Bar + Filter Chips ── */}
      <div className="flex items-center gap-2 md:rounded-xl md:border md:border-[#e2e8f0] md:bg-white md:px-1 md:py-1 md:dark:border-white/10 md:dark:bg-[#111827]">
        {/* Search keeps its own frame below md, where the toolbar is no longer one pill. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#e2e8f0] bg-white px-2 py-1 md:border-0 md:bg-transparent md:px-0 md:py-0 dark:border-white/10 dark:bg-[#111827] md:dark:border-0 md:dark:bg-transparent">
          <span className="flex shrink-0 items-center pl-1 text-[#94a3b8] dark:text-slate-500">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {filterChips.map((chip) => (
              <span
                key={chip.id}
                className="inline-flex items-center gap-1 rounded-full border border-[#b2e0db] bg-[#e6f7f5] px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--color-app-header-teal)] dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-400"
              >
                {chip.label}
                <button
                  type="button"
                  aria-label={`Remove ${chip.label} filter`}
                  onClick={() => handleRemoveChip(chip.id)}
                  className="touch-target flex h-3.5 w-3.5 items-center justify-center rounded-full text-[#7cc8bf] transition-colors hover:bg-[#ccece8] hover:text-[var(--color-app-header-teal)] dark:text-teal-500 dark:hover:bg-teal-900/40 dark:hover:text-teal-300"
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </span>
            ))}
            {/* 16px on mobile: anything smaller makes iOS Safari zoom the viewport on focus. */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Filter ${filtered.length} bill${filtered.length !== 1 ? "s" : ""}...`}
              className="min-w-[100px] flex-1 bg-transparent py-1.5 text-base text-[#1e293b] placeholder-[#94a3b8] focus:outline-none md:py-0.5 md:text-[13px] dark:text-slate-100 dark:placeholder-slate-500"
            />
          </div>

          {hasChips && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="min-h-11 shrink-0 px-2.5 text-xs font-semibold whitespace-nowrap text-[var(--color-app-header-teal)] transition-colors hover:text-[#248f82] md:min-h-0 dark:text-teal-400 dark:hover:text-teal-300"
            >
              Clear
            </button>
          )}
        </div>

        {/* Right controls: Column toggle + Filter button */}
        <div className="flex shrink-0 items-center gap-1.5 md:h-8 md:pr-1">
          {/* Column visibility toggle — mobile renders cards, which have no columns to toggle. */}
          <div className="relative hidden md:block">
            <button
              type="button"
              onClick={() => setColumnDropdownOpen(!columnDropdownOpen)}
              className="flex h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 w-8 items-center justify-center rounded-lg text-[#94a3b8] transition-colors hover:bg-[#f1f5f9] hover:text-[#64748b] dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
              title="Columns"
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
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </button>

            {columnDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setColumnDropdownOpen(false)}
                  role="presentation"
                />
                <div className="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-[#1e293b] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-xl z-20 py-2">
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                    Visible Columns
                  </div>
                  {COLUMNS.map((col) => (
                    <label
                      key={col.key}
                      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(col.key)}
                        onChange={() => toggleColumn(col.key)}
                        className="rounded border-[#e2e8f0] dark:border-white/10 cursor-pointer"
                        style={{ accentColor: "var(--color-app-header-teal)" }}
                      />
                      <span className="text-xs text-[#1e293b] dark:text-white">{col.label}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Filter trigger — FilterBar's button + sheet on mobile, the funnel + anchored popover
              above md. FilterBar is mounted only below md because its desktop branch lays the
              fields out inline, which this one-line toolbar has no room for. */}
          {isMobile ? (
            <FilterBar activeCount={filterChips.length}>{billFilterFields}</FilterBar>
          ) : (
            <div className="relative">
              <button
                type="button"
                onClick={() => setFiltersOpen(!filtersOpen)}
                data-ignore-click-outside
                className={`w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center transition-colors ${
                  filtersOpen || hasActiveFilters
                    ? "bg-[#ccece8] dark:bg-teal-900/40 text-[var(--color-app-header-teal)] dark:text-teal-400"
                    : "text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-800"
                }`}
                title="Filters"
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
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
              </button>

              {/* Filter Panel */}
              <BillFilters
                isOpen={filtersOpen}
                onClose={() => setFiltersOpen(false)}
                activeStatuses={activeStatuses}
                dateFilter={dateFilter}
                amountMin={amountMin}
                amountMax={amountMax}
                overdueOnly={overdueOnly}
                onToggleStatus={toggleStatus}
                onDateFilterChange={setDateFilter}
                onAmountChange={handleAmountChange}
                onToggleOverdue={() => setOverdueOnly(!overdueOnly)}
                onClearAll={clearAllFilters}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Unified Table with Collapsible Status Groups ── */}
      <div className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden bg-white dark:bg-[#111827]">
        {/* The grid scrolls rather than squashing once the visible columns stop fitting — with the
            app shell clipping overflow, a squashed grid silently loses its right-hand columns.
            Mobile renders cards, so the floor only applies from md up. */}
        <div className="scroll-x">
          <div
            className="min-w-0 md:min-w-[var(--bills-grid-min)]"
            style={
              {
                "--bills-grid-min": `${activeColumns.length * MIN_COLUMN_WIDTH_PX}px`,
              } as React.CSSProperties
            }
          >
            {/* Table Header */}
            <div
              className="hidden md:grid items-center px-4 py-2 border-b border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]"
              style={{
                gridTemplateColumns: activeColumns.map(() => "1fr").join(" "),
              }}
            >
              {activeColumns.map((col) => (
                <span
                  key={col.key}
                  className="text-[10px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider whitespace-nowrap px-2"
                >
                  {col.label}
                </span>
              ))}
            </div>

            {/* Status Group Rows */}
            {visibleGroups.map((group) => {
              const items = grouped[group.key] ?? [];
              const isExpanded = expandedGroups.includes(group.key);
              const groupTotal = items.reduce(
                (sum, bill) => sum + Number.parseFloat(bill.amount),
                0,
              );

              const hasItems = items.length > 0;

              return (
                <div key={group.key}>
                  {/* Group Header Row — CategoryManager style */}
                  <button
                    type="button"
                    onClick={() => hasItems && toggleGroup(group.key)}
                    className={`group/header w-full flex items-center justify-between px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10 transition-colors ${
                      hasItems
                        ? "hover:bg-[#f8fafc] dark:hover:bg-white/[0.03] cursor-pointer"
                        : "cursor-default opacity-60"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {/* Icon box — shows status icon, swaps to chevron on hover */}
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors"
                        style={{ backgroundColor: `${group.color}15`, color: group.color }}
                      >
                        {!hasItems ? (
                          /* Empty group: static status icon, no interaction */
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity="0.7"
                          >
                            {group.iconPaths.map((d) => (
                              <path key={d} d={d} />
                            ))}
                          </svg>
                        ) : isExpanded ? (
                          <>
                            {/* Expanded: status icon by default, chevron-down on hover. There is no
                            hover on touch, so below md the chevron is the permanent state —
                            otherwise an expanded group offers no hint that it collapses. */}
                            <span className="hidden md:flex md:group-hover/header:hidden items-center justify-center">
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                {group.iconPaths.map((d) => (
                                  <path key={d} d={d} />
                                ))}
                              </svg>
                            </span>
                            <span className="flex md:hidden md:group-hover/header:flex items-center justify-center">
                              <svg
                                width="16"
                                height="16"
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
                          /* Collapsed: always show chevron-right */
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                          >
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        )}
                      </div>

                      <span
                        className="truncate text-sm font-semibold"
                        style={{ color: group.color }}
                      >
                        {group.label}
                      </span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-[#e2e8f0] dark:bg-white/10 text-[#64748b] dark:text-white/50">
                        {items.length}
                      </span>
                    </div>
                    <span className="tabular-figures shrink-0 pl-3 text-sm font-semibold text-[#1e293b] dark:text-white">
                      {formatCurrency(groupTotal)}
                    </span>
                  </button>

                  {/* Group Body — animated collapse (only if items exist) */}
                  {hasItems && (
                    <div
                      className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
                      style={{
                        // Animating grid rows instead of a pixel max-height: any per-item height
                        // constant is a guess, and a desktop row and a mobile card are nowhere
                        // near the same size, so under-estimating silently clipped bills off the
                        // bottom of an expanded group. Matches InvoiceListView.
                        gridTemplateRows: isExpanded ? "1fr" : "0fr",
                        opacity: isExpanded ? 1 : 0,
                      }}
                    >
                      <div className="overflow-hidden">
                        {/* Desktop Rows */}
                        <div className="hidden md:block">
                          {items.map((bill) => (
                            <BillRow key={bill.id} bill={bill} visibleColumns={visibleColumns} />
                          ))}
                        </div>

                        {/* Mobile Cards */}
                        <div className="md:hidden flex flex-col gap-2 p-3">
                          {items.map((bill) => (
                            <BillMobileCard key={bill.id} bill={bill} />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && !isPending && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-full bg-[#f1f5f9] dark:bg-white/5 flex items-center justify-center mb-3">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <p className="text-sm font-medium text-[#64748b] dark:text-white/40">
            No bills match your filters
          </p>
          <p className="text-xs text-[#94a3b8] dark:text-white/30 mt-1">
            Try adjusting your status or date filters
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Bill Table Row (Desktop)
// ============================================================================

function BillRow({ bill, visibleColumns }: { bill: BillListItem; visibleColumns: ColumnKey[] }) {
  const navigate = useNavigate();
  const isOverdue =
    bill.status !== "paid" && bill.status !== "voided" && getDaysOverdue(bill.dueDate) > 0;

  const cellMap: Record<ColumnKey, React.ReactNode> = {
    billNumber: (
      <span className="text-sm font-medium text-[#1e293b] dark:text-white">
        {bill.billNumber ?? "—"}
      </span>
    ),
    vendor: (
      <div className="flex items-center gap-2">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
          style={{ backgroundColor: getVendorColor(bill.vendorName) }}
        >
          {getVendorInitial(bill.vendorName)}
        </div>
        <span className="text-sm text-[#1e293b] dark:text-white truncate max-w-[160px]">
          {bill.vendorName ?? "Unknown"}
        </span>
      </div>
    ),
    billDate: (
      <span className="text-xs text-[#64748b] dark:text-white/50">{formatDate(bill.billDate)}</span>
    ),
    dueDate: (
      <span
        className={`text-xs ${
          isOverdue ? "text-[#ea580c] font-medium" : "text-[#64748b] dark:text-white/50"
        }`}
      >
        {formatDate(bill.dueDate)}
        {isOverdue && <span className="ml-1 text-[10px]">({getDaysOverdue(bill.dueDate)}d)</span>}
      </span>
    ),
    status: (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
        style={{
          backgroundColor: `${statusColor(bill.status)}15`,
          color: statusColor(bill.status),
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: statusColor(bill.status) }}
        />
        {statusLabel(bill.status)}
      </span>
    ),
    amount: (
      <span className="tabular-figures text-sm font-semibold text-[#1e293b] dark:text-white">
        {formatCurrency(bill.amount)}
      </span>
    ),
    balanceDue: (
      <span className="tabular-figures text-sm text-[#1e293b] dark:text-white">
        {formatCurrency(bill.balanceDue)}
      </span>
    ),
    approver: <span className="text-xs text-[#64748b] dark:text-white/50">—</span>,
    memo: (
      <span className="text-xs text-[#64748b] dark:text-white/50 truncate max-w-[120px] block">
        {bill.memo ?? "—"}
      </span>
    ),
  };

  const cols = COLUMNS.filter((c) => visibleColumns.includes(c.key));

  return (
    <div
      onClick={() => navigate({ to: `/bills/${bill.id}` as string & {} })}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate({ to: `/bills/${bill.id}` as string & {} });
      }}
      role="button"
      tabIndex={0}
      className="grid items-center px-4 py-2.5 border-b border-[#f1f5f9] dark:border-white/5 hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] cursor-pointer transition-colors"
      style={{ gridTemplateColumns: cols.map(() => "1fr").join(" ") }}
    >
      {cols.map((col) => (
        <div key={col.key} className="px-2 whitespace-nowrap">
          {cellMap[col.key]}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Bill Mobile Card
// ============================================================================

/**
 * Strategy A card (responsive-ui §4.1). Identity is vendor + bill number, because a bill number
 * alone is unrecognisable and a vendor alone is ambiguous once an org has several open with the
 * same supplier. The amount is the figure the user came for, so it is right-aligned, tabular and
 * never truncated — the vendor name gives way first. Due date and status are the two supporting
 * facts that decide whether a bill needs attention; bill date, balance due, approver and memo are
 * dropped and live on the detail page.
 */
function BillMobileCard({ bill }: { bill: BillListItem }) {
  const navigate = useNavigate();
  const isOverdue =
    bill.status !== "paid" && bill.status !== "voided" && getDaysOverdue(bill.dueDate) > 0;

  return (
    <button
      type="button"
      onClick={() => navigate({ to: `/bills/${bill.id}` as string & {} })}
      className="w-full rounded-lg border border-[#e2e8f0] bg-white p-4 text-left transition-all hover:shadow-md dark:border-white/8 dark:bg-[#15192a]"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
            style={{ backgroundColor: getVendorColor(bill.vendorName) }}
          >
            {getVendorInitial(bill.vendorName)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-[#1e293b] dark:text-white">
              {bill.vendorName ?? "Unknown"}
            </div>
            <div className="truncate text-xs text-[#94a3b8] dark:text-white/40">
              {bill.billNumber ?? "No number"}
            </div>
          </div>
        </div>
        <div className="tabular-figures shrink-0 text-sm font-semibold whitespace-nowrap text-[#1e293b] dark:text-white">
          {formatCurrency(bill.amount)}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[#f1f5f9] pt-2 dark:border-white/5">
        <div className="text-xs text-[#94a3b8] dark:text-white/40">
          Due {formatDate(bill.dueDate)}
        </div>
        <div className="flex items-center gap-2">
          {isOverdue && (
            <span className="text-xs font-semibold text-[#ea580c]">
              {getDaysOverdue(bill.dueDate)}d overdue
            </span>
          )}
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{
              backgroundColor: `${statusColor(bill.status)}15`,
              color: statusColor(bill.status),
            }}
          >
            {statusLabel(bill.status)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 animate-pulse">
      {/* Filter bar skeleton */}
      <div className="flex flex-wrap items-center gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-7 w-20 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
        ))}
        <div className="flex-1" />
        <div className="h-7 w-20 rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
      </div>
      {/* Group skeletons */}
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-[#e2e8f0] dark:bg-white/10" />
              <div className="h-4 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
              <div className="h-4 w-6 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
            </div>
            <div className="h-4 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
          </div>
          <div className="p-3 flex flex-col gap-2">
            {[1, 2].map((j) => (
              <div key={j} className="h-12 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
