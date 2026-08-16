/**
 * InvoiceListView — Expandable status-grouped list with filters & column toggles
 *
 * Below `md` the grouped table collapses to a card list (responsive-ui.md §4.1): this is a
 * browse-and-drill-in surface — the user scans down for one invoice and opens it — so the row grid
 * buys nothing on a phone. The column picker and the popover filter panel are desktop chrome and
 * are replaced by a single "Filters (n)" sheet.
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { InvoiceListItem } from "../../routes/api/-invoices";
import InvoiceFilters from "./InvoiceFilters";
import { FilterBar } from "../ui/Actions";
import { useIsMobile } from "../../hooks/useBreakpoint";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Types
// ============================================================================

interface InvoiceListViewProps {
  invoices: InvoiceListItem[];
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
  | "invoiceNumber"
  | "customer"
  | "issueDate"
  | "dueDate"
  | "status"
  | "total"
  | "balanceDue"
  | "amountPaid"
  | "paymentTerms";

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
    key: "draft",
    label: "Draft",
    statuses: ["draft"],
    color: "#94a3b8",
    bgColor: "rgba(148,163,184,0.08)",
    iconPaths: ["M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"],
  },
  {
    key: "sent",
    label: "Sent",
    statuses: ["sent", "viewed"],
    color: "#3b82f6",
    bgColor: "rgba(59,130,246,0.08)",
    iconPaths: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
  },
  {
    key: "overdue",
    label: "Overdue",
    statuses: ["overdue"],
    color: "#f59e0b",
    bgColor: "rgba(245,158,11,0.08)",
    iconPaths: [
      "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z",
      "M12 6v6l4 2",
    ],
  },
  {
    key: "paid",
    label: "Paid",
    statuses: ["paid"],
    color: "#10b981",
    bgColor: "rgba(16,185,129,0.08)",
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
  { key: "invoiceNumber", label: "Invoice #", defaultVisible: true },
  { key: "customer", label: "Customer", defaultVisible: true },
  { key: "issueDate", label: "Issue Date", defaultVisible: true },
  { key: "dueDate", label: "Due Date", defaultVisible: true },
  { key: "status", label: "Status", defaultVisible: true },
  { key: "total", label: "Total", defaultVisible: true },
  { key: "balanceDue", label: "Balance Due", defaultVisible: true },
  { key: "amountPaid", label: "Amount Paid", defaultVisible: false },
  { key: "paymentTerms", label: "Payment Terms", defaultVisible: false },
];

const DATE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "30", label: "Past 30 Days" },
  { value: "90", label: "Past 90 Days" },
  { value: "180", label: "Past 6 Months" },
  { value: "365", label: "Past 1 Year" },
];

const DEFAULT_STATUSES = ["draft", "sent", "overdue", "paid"];

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

function getCustomerInitial(name: string | null): string {
  if (!name) return "?";
  return name.charAt(0).toUpperCase();
}

function getCustomerColor(name: string | null): string {
  if (!name) return "#94a3b8";
  const colors = [
    "#10b981",
    "#ec4899",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ef4444",
    "#14b8a6",
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
    sent: "Sent",
    viewed: "Viewed",
    overdue: "Overdue",
    partial: "Partial",
    paid: "Paid",
    voided: "Voided",
  };
  return map[status] ?? status;
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    draft: "#94a3b8",
    sent: "#3b82f6",
    viewed: "#3b82f6",
    overdue: "#f59e0b",
    partial: "#f59e0b",
    paid: "#10b981",
    voided: "#6b7280",
  };
  return map[status] ?? "#94a3b8";
}

// ============================================================================
// Component
// ============================================================================

export function InvoiceListView({ invoices, isPending }: InvoiceListViewProps) {
  const isMobile = useIsMobile();

  // Filter state — persisted to localStorage
  const [activeStatuses, setActiveStatuses] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("invoices-active-statuses");
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
      const saved = localStorage.getItem("invoices-visible-columns");
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
    localStorage.setItem("invoices-active-statuses", JSON.stringify(activeStatuses));
  }, [activeStatuses]);

  useEffect(() => {
    localStorage.setItem("invoices-visible-columns", JSON.stringify(visibleColumns));
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
      draft: "Draft",
      sent: "Sent",
      overdue: "Overdue",
      paid: "Paid",
      voided: "Voided",
    };
    for (const s of activeStatuses) {
      chips.push({ id: `status-${s}`, label: statusLabels[s] ?? s });
    }

    if (dateFilter !== "all") {
      chips.push({
        id: "date",
        label: DATE_OPTIONS.find((o) => o.value === dateFilter)?.label ?? dateFilter,
      });
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

  // Filter invoices
  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      // Status filter — if statuses selected, match against them; if none selected show all
      if (activeStatuses.length > 0) {
        const matchesStatusGroup = activeStatuses.some((groupKey) => {
          const group = STATUS_GROUPS.find((g) => g.key === groupKey);
          return group ? group.statuses.includes(inv.status) : false;
        });
        if (!matchesStatusGroup) return false;
      }

      // Date filter
      if (!isWithinDateRange(inv.issueDate, dateFilter)) return false;

      // Amount range
      const amount = Number.parseFloat(inv.total);
      if (amountMin && amount < Number.parseFloat(amountMin)) return false;
      if (amountMax && amount > Number.parseFloat(amountMax)) return false;

      // Text search (unified: invoice # + customer)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesNum = inv.invoiceNumber.toLowerCase().includes(q);
        const matchesCustomer = (inv.customerName ?? "").toLowerCase().includes(q);
        if (!matchesNum && !matchesCustomer) return false;
      }

      // Overdue only
      if (overdueOnly) {
        if (inv.status === "paid" || inv.status === "voided" || getDaysOverdue(inv.dueDate) <= 0)
          return false;
      }

      return true;
    });
  }, [invoices, activeStatuses, dateFilter, amountMin, amountMax, searchQuery, overdueOnly]);

  // Group filtered invoices
  const grouped = useMemo(() => {
    const map: Record<string, InvoiceListItem[]> = {};
    for (const group of STATUS_GROUPS) {
      map[group.key] = filtered.filter((inv) => group.statuses.includes(inv.status));
    }
    return map;
  }, [filtered]);

  // Determine which groups to show
  const visibleGroups = useMemo(() => {
    if (activeStatuses.length === 0) return STATUS_GROUPS;
    return STATUS_GROUPS.filter((g) => activeStatuses.includes(g.key));
  }, [activeStatuses]);

  if (isPending) {
    return <ListSkeleton />;
  }

  const hasChips = filterChips.length > 0;

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {/* ── Search + filters (mobile: search stays, everything else behind one sheet) ── */}
      {isMobile && (
        <MobileToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          resultCount={filtered.length}
          chips={filterChips}
          onRemoveChip={handleRemoveChip}
          onClearAll={clearAllFilters}
          activeStatuses={activeStatuses}
          dateFilter={dateFilter}
          amountMin={amountMin}
          amountMax={amountMax}
          overdueOnly={overdueOnly}
          onToggleStatus={toggleStatus}
          onDateFilterChange={setDateFilter}
          onAmountChange={handleAmountChange}
          onToggleOverdue={() => setOverdueOnly(!overdueOnly)}
        />
      )}

      {/* ── Search Bar + Filter Chips ── */}
      <div className="hidden md:flex items-center gap-2 px-1 py-1 border border-[#e2e8f0] dark:border-white/10 rounded-xl bg-white dark:bg-[#111827]">
        {!hasChips ? (
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-slate-500"
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
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Filter ${filtered.length} invoice${filtered.length !== 1 ? "s" : ""}...`}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-transparent text-base sm:text-[13px] text-[#1e293b] dark:text-slate-100 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none"
            />
          </div>
        ) : (
          <>
            <div className="h-8 flex items-center shrink-0 pl-2">
              <svg
                className="text-[#94a3b8] dark:text-slate-500"
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
            </div>
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
              {filterChips.map((chip) => (
                <span
                  key={chip.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#e6f7f5] dark:bg-teal-950/60 text-[var(--color-app-header-teal)] dark:text-teal-400 border border-[#b2e0db] dark:border-teal-800 whitespace-nowrap"
                >
                  {chip.label}
                  <button
                    type="button"
                    onClick={() => handleRemoveChip(chip.id)}
                    className="flex items-center justify-center w-3.5 h-3.5 rounded-full text-[#7cc8bf] dark:text-teal-500 hover:text-[var(--color-app-header-teal)] dark:hover:text-teal-300 hover:bg-[#ccece8] dark:hover:bg-teal-900/40 transition-colors"
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
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={`Filter ${filtered.length} invoice${filtered.length !== 1 ? "s" : ""}...`}
                className="flex-1 min-w-[120px] py-0.5 bg-transparent text-base sm:text-[13px] text-[#1e293b] dark:text-slate-100 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none"
              />
            </div>
            <div className="h-8 flex items-center shrink-0">
              <button
                type="button"
                onClick={clearAllFilters}
                className="px-2.5 text-[11px] font-semibold text-[var(--color-app-header-teal)] hover:text-[#248f82] dark:text-teal-400 dark:hover:text-teal-300 transition-colors whitespace-nowrap"
              >
                Clear
              </button>
            </div>
          </>
        )}

        {/* Right controls */}
        <div className="h-8 flex items-center gap-1.5 shrink-0 pr-1">
          {/* Column visibility */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setColumnDropdownOpen(!columnDropdownOpen)}
              className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors"
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

          {/* Filter funnel button */}
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

            <InvoiceFilters
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
        </div>
      </div>

      {/* ── Unified Table with Collapsible Status Groups ── */}
      <div className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden bg-white dark:bg-[#111827]">
        {/* Table Header */}
        <div
          className="hidden md:grid items-center px-4 py-2 border-b border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]"
          style={{
            gridTemplateColumns: COLUMNS.filter((c) => visibleColumns.includes(c.key))
              .map(() => "1fr")
              .join(" "),
          }}
        >
          {COLUMNS.filter((c) => visibleColumns.includes(c.key)).map((col) => (
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
          const groupTotal = items.reduce((sum, inv) => sum + Number.parseFloat(inv.total), 0);

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
                        {/* Expanded: status icon by default, chevron-down on hover. Touch has no
                            hover, so below md the chevron is the permanent affordance. */}
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

                  <span className="truncate text-sm font-semibold" style={{ color: group.color }}>
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
                    // Animating grid rows instead of a pixel max-height: the old
                    // `items.length * 52` assumed a 52px desktop row and clipped the taller
                    // mobile cards, leaving invoices unreachable inside a collapsed-looking group.
                    gridTemplateRows: isExpanded ? "1fr" : "0fr",
                    opacity: isExpanded ? 1 : 0,
                  }}
                >
                  <div className="overflow-hidden">
                    {isMobile ? (
                      <div className="flex flex-col gap-2 p-3">
                        {items.map((inv) => (
                          <InvoiceMobileCard key={inv.id} invoice={inv} />
                        ))}
                      </div>
                    ) : (
                      items.map((inv) => (
                        <InvoiceRow key={inv.id} invoice={inv} visibleColumns={visibleColumns} />
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
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
            No invoices match your filters
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
// Invoice Table Row (Desktop)
// ============================================================================

function InvoiceRow({
  invoice,
  visibleColumns,
}: {
  invoice: InvoiceListItem;
  visibleColumns: ColumnKey[];
}) {
  const navigate = useNavigate();
  const isDraft = invoice.status === "draft";
  const invoicePath = isDraft ? `/invoices/draft/${invoice.id}` : `/invoices/${invoice.id}`;
  const isOverdue =
    invoice.status !== "paid" && invoice.status !== "voided" && getDaysOverdue(invoice.dueDate) > 0;

  const cellMap: Record<ColumnKey, React.ReactNode> = {
    invoiceNumber: (
      <span className="text-sm font-medium text-[#1e293b] dark:text-white">
        {invoice.invoiceNumber}
      </span>
    ),
    customer: (
      <div className="flex items-center gap-2">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
          style={{
            backgroundColor: getCustomerColor(invoice.customerName),
          }}
        >
          {getCustomerInitial(invoice.customerName)}
        </div>
        <span className="text-sm text-[#1e293b] dark:text-white truncate max-w-[160px]">
          {invoice.customerName ?? "Unknown"}
        </span>
      </div>
    ),
    issueDate: (
      <span className="text-xs text-[#64748b] dark:text-white/50">
        {formatDate(invoice.issueDate)}
      </span>
    ),
    dueDate: (
      <span
        className={`text-xs ${
          isOverdue ? "text-[#ea580c] font-medium" : "text-[#64748b] dark:text-white/50"
        }`}
      >
        {formatDate(invoice.dueDate)}
        {isOverdue && (
          <span className="ml-1 text-[10px]">({getDaysOverdue(invoice.dueDate)}d)</span>
        )}
      </span>
    ),
    status: (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
        style={{
          backgroundColor: `${statusColor(invoice.status)}15`,
          color: statusColor(invoice.status),
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: statusColor(invoice.status) }}
        />
        {statusLabel(invoice.status)}
      </span>
    ),
    total: (
      <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
        {formatCurrency(invoice.total)}
      </span>
    ),
    balanceDue: (
      <span className="text-sm text-[#1e293b] dark:text-white">
        {formatCurrency(invoice.balanceDue)}
      </span>
    ),
    amountPaid: <span className="text-xs text-[#64748b] dark:text-white/50">—</span>,
    paymentTerms: <span className="text-xs text-[#64748b] dark:text-white/50">—</span>,
  };

  const cols = COLUMNS.filter((c) => visibleColumns.includes(c.key));

  return (
    <div
      onClick={() => navigate({ to: invoicePath as string & {} })}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate({ to: invoicePath as string & {} });
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
// Invoice Mobile Card
// ============================================================================

/**
 * One invoice as a card (responsive-ui.md §4.1).
 *
 * Priority: the invoice number identifies the record, the total is the figure the user came for,
 * and the due date plus its age is what decides whether this invoice needs attention today. Issue
 * date, balance due and payment terms are dropped — they live on the detail page.
 */
function InvoiceMobileCard({ invoice }: { invoice: InvoiceListItem }) {
  const navigate = useNavigate();
  const isDraft = invoice.status === "draft";
  const invoicePath = isDraft ? `/invoices/draft/${invoice.id}` : `/invoices/${invoice.id}`;
  const daysOverdue = getDaysOverdue(invoice.dueDate);
  const isSettled = invoice.status === "paid" || invoice.status === "voided";
  const age = isSettled
    ? null
    : daysOverdue > 0
      ? { label: `${daysOverdue}d overdue`, overdue: true }
      : daysOverdue === 0
        ? { label: "due today", overdue: true }
        : { label: `due in ${-daysOverdue}d`, overdue: false };

  return (
    <button
      type="button"
      onClick={() => navigate({ to: invoicePath as string & {} })}
      className="w-full text-left p-4 rounded-xl border border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] active:bg-[#f8fafc] dark:active:bg-white/[0.04] transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{
              backgroundColor: getCustomerColor(invoice.customerName),
            }}
          >
            {getCustomerInitial(invoice.customerName)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[#1e293b] dark:text-white">
              {invoice.invoiceNumber}
            </div>
            <div className="truncate text-sm text-[#64748b] dark:text-white/50">
              {invoice.customerName ?? "Unknown"}
            </div>
          </div>
        </div>
        <div className="tabular-figures shrink-0 whitespace-nowrap text-sm font-semibold text-[#1e293b] dark:text-white">
          {formatCurrency(invoice.total)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-3 pt-2.5 border-t border-[#f1f5f9] dark:border-white/5">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{
            backgroundColor: `${statusColor(invoice.status)}15`,
            color: statusColor(invoice.status),
          }}
        >
          {statusLabel(invoice.status)}
        </span>
        <span className="text-sm text-[#64748b] dark:text-white/50">
          Due {formatDate(invoice.dueDate)}
        </span>
        {age && (
          <span
            className={`text-sm ${
              age.overdue ? "font-semibold text-[#ea580c]" : "text-[#94a3b8] dark:text-white/40"
            }`}
          >
            · {age.label}
          </span>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// Mobile toolbar — search stays visible, everything else collapses to one sheet
// ============================================================================

interface MobileFilterProps {
  activeStatuses: string[];
  dateFilter: string;
  amountMin: string;
  amountMax: string;
  overdueOnly: boolean;
  onToggleStatus: (status: string) => void;
  onDateFilterChange: (value: string) => void;
  onAmountChange: (min: string, max: string) => void;
  onToggleOverdue: () => void;
}

function MobileToolbar({
  searchQuery,
  onSearchChange,
  resultCount,
  chips,
  onRemoveChip,
  onClearAll,
  ...filterProps
}: {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  resultCount: number;
  chips: { id: string; label: string }[];
  onRemoveChip: (chipId: string) => void;
  onClearAll: () => void;
} & MobileFilterProps) {
  return (
    <div className="flex flex-col gap-2">
      <FilterBar
        activeCount={chips.length}
        trailing={
          <div className="relative min-w-0 flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-slate-500"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={`Filter ${resultCount} invoice${resultCount !== 1 ? "s" : ""}...`}
              aria-label="Filter invoices"
              className="h-11 w-full pl-10 pr-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base text-[#1e293b] dark:text-slate-100 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-[var(--color-app-header-teal)]"
            />
          </div>
        }
      >
        <MobileFilterPanel {...filterProps} onClearAll={onClearAll} />
      </FilterBar>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {/* The chip itself is the remove target — a 14px × inside a chip is not tappable, and
              two of them side by side would sit well inside each other's 44px hit area. */}
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onRemoveChip(chip.id)}
              aria-label={`Remove filter ${chip.label}`}
              className="inline-flex min-h-11 items-center gap-1.5 px-3 rounded-full text-sm font-medium bg-[#e6f7f5] dark:bg-teal-950/60 text-[var(--color-app-header-teal)] dark:text-teal-400 border border-[#b2e0db] dark:border-teal-800"
            >
              {chip.label}
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="min-h-11 px-3 text-sm font-semibold text-[var(--color-app-header-teal)] dark:text-teal-400"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Sheet body for the mobile filters. Same state and handlers as the desktop popover
 * (`InvoiceFilters`), re-laid out for touch: no nested disclosures, 44px rows, 16px inputs.
 */
function MobileFilterPanel({
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
}: MobileFilterProps & { onClearAll: () => void }) {
  const inputClass =
    "w-full h-11 pl-6 pr-3 rounded-lg border border-[#e2e8f0] dark:border-slate-700 bg-white dark:bg-slate-800 text-base text-[#1e293b] dark:text-slate-100 placeholder-[#cbd5e1] dark:placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[var(--color-app-header-teal)]";
  const rowClass =
    "flex min-h-11 items-center gap-3 text-base text-[#374151] dark:text-slate-300 cursor-pointer";
  const legendClass =
    "mb-1 text-xs font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40";

  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className={legendClass}>Status</legend>
        {STATUS_GROUPS.map((group) => (
          <label key={group.key} className={rowClass}>
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: group.color }}
            />
            <span className="flex-1">{group.label}</span>
            <input
              type="checkbox"
              checked={activeStatuses.includes(group.key)}
              onChange={() => onToggleStatus(group.key)}
              className="w-5 h-5 rounded shrink-0"
              style={{ accentColor: "var(--color-app-header-teal)" }}
            />
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend className={legendClass}>Amount</legend>
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="block mb-1 text-xs text-[#94a3b8] dark:text-slate-500">Min</span>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#94a3b8] dark:text-slate-500">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amountMin}
                onChange={(e) => onAmountChange(e.target.value.replace(/[^0-9.,]/g, ""), amountMax)}
                placeholder="0.00"
                className={inputClass}
              />
            </div>
          </label>
          <span className="pb-3 text-[#94a3b8]">—</span>
          <label className="flex-1">
            <span className="block mb-1 text-xs text-[#94a3b8] dark:text-slate-500">Max</span>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#94a3b8] dark:text-slate-500">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amountMax}
                onChange={(e) => onAmountChange(amountMin, e.target.value.replace(/[^0-9.,]/g, ""))}
                placeholder="0.00"
                className={inputClass}
              />
            </div>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className={legendClass}>Date range</legend>
        {DATE_OPTIONS.map((opt) => (
          <label key={opt.value} className={rowClass}>
            <span className="flex-1">{opt.label}</span>
            <input
              type="radio"
              name="invoiceDateFilterMobile"
              checked={dateFilter === opt.value}
              onChange={() => onDateFilterChange(opt.value)}
              className="w-5 h-5 shrink-0"
              style={{ accentColor: "var(--color-app-header-teal)" }}
            />
          </label>
        ))}
      </fieldset>

      <label className={rowClass}>
        <span className="flex-1">Overdue only</span>
        <input
          type="checkbox"
          checked={overdueOnly}
          onChange={onToggleOverdue}
          className="w-5 h-5 rounded shrink-0"
          style={{ accentColor: "var(--color-app-header-teal)" }}
        />
      </label>

      <button
        type="button"
        onClick={onClearAll}
        className="min-h-11 rounded-lg border border-[#e2e8f0] dark:border-slate-700 text-sm font-semibold text-[#64748b] dark:text-slate-300"
      >
        Clear all filters
      </button>
    </div>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 animate-pulse">
      {/* Toolbar skeleton — search plus the controls that survive at each size */}
      <div className="flex items-center gap-2">
        <div className="h-11 md:h-8 flex-1 rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
        <div className="h-11 w-28 md:hidden rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
        <div className="hidden md:block h-8 w-8 rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
        <div className="hidden md:block h-8 w-8 rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
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
              <div className="h-4 w-20 rounded bg-[#e2e8f0] dark:bg-white/10" />
              <div className="h-4 w-6 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
            </div>
            <div className="h-4 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
          </div>
          <div className="p-3 flex flex-col gap-2">
            {[1, 2].map((j) => (
              <div key={j} className="h-24 md:h-12 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
