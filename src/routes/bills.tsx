/**
 * Bills Page — Kanban Board + List View (Bill Pay)
 */
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { listBills } from "./api/-bills";
import type { BillListItem } from "./api/-bills";
import { ICON_PATHS } from "../components/accounts/icons";
import { BillUploadModal } from "../components/bills/BillUploadModal";
import { BillUploadProgress } from "../components/bills/BillUploadProgress";
import { useBillUploadJobs } from "../lib/bill-upload-store";
import { BILL_MAPPING_CONFIG } from "../lib/bill-mapping-config";
export { BILL_MAPPING_CONFIG };
import { BillListView } from "../components/bills/BillListView";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Route Definition
// ============================================================================

interface BillsSearch {
  status?: string;
  mode?: string; // "new"
  view?: "kanban" | "list";
}

export const Route = createFileRoute("/bills")({
  component: BillsPage,
  validateSearch(search: Record<string, unknown>): BillsSearch {
    let view: "kanban" | "list" = "kanban";
    if (search.view === "list" || search.view === "kanban") {
      view = search.view;
    } else if (typeof window !== "undefined") {
      const saved = localStorage.getItem("buwiz:bills-view");
      if (saved === "list" || saved === "kanban") view = saved;
    }
    return {
      status: (search.status as string) || undefined,
      mode: (search.mode as string) || undefined,
      view,
    };
  },
});

// ============================================================================
// Kanban Column Config
// ============================================================================

interface KanbanColumn {
  key: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

function columnIcon(name: string, color: string): React.ReactNode {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      style={{ color }}
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

const COLUMNS: KanbanColumn[] = [
  {
    key: "in_review",
    label: "In Review",
    icon: columnIcon("Transaction", "#10b981"),
    color: "#10b981",
    bgColor: "rgba(16,185,129,0.08)",
  },
  {
    key: "pending_approval",
    label: "Pending Approval",
    icon: columnIcon("PendingApproval", "#f59e0b"),
    color: "#f59e0b",
    bgColor: "rgba(245,158,11,0.08)",
  },
  {
    key: "awaiting_payment",
    label: "Awaiting Payment",
    icon: columnIcon("Clock", "#3b82f6"),
    color: "#3b82f6",
    bgColor: "rgba(59,130,246,0.08)",
  },
  {
    key: "scheduled_paid",
    label: "Scheduled & Paid",
    icon: columnIcon("Scheduled", "#10b981"),
    color: "#10b981",
    bgColor: "rgba(16,185,129,0.08)",
  },
];

// ============================================================================
// Helpers
// ============================================================================

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getDaysOverdue(dueDate: string): number {
  const now = new Date();
  const due = new Date(`${dueDate}T00:00:00`);
  const diff = Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

function getVendorInitial(name: string | null): string {
  if (!name) return "?";
  return name.charAt(0).toUpperCase();
}

function getVendorColor(name: string | null): string {
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

// ============================================================================
// Page Component
// ============================================================================

function BillsPage() {
  const { view } = Route.useSearch() as BillsSearch;
  const navigate = useNavigate();
  const [paidFilter, setPaidFilter] = useState("30");
  const [filterOpen, setFilterOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const activeJobs = useBillUploadJobs();
  const processingJobs = activeJobs.filter((j) => j.status !== "done" && j.status !== "error");
  const isListView = view === "list";

  // Persist view preference
  useEffect(() => {
    if (view) localStorage.setItem("buwiz:bills-view", view);
  }, [view]);

  const FILTER_OPTIONS = [
    { value: "30", label: "Past 30 Days" },
    { value: "90", label: "Past 90 Days" },
    { value: "180", label: "Past 6 Months" },
    { value: "365", label: "Past 1 Year" },
    { value: "all", label: "All Time" },
  ];

  // Fetch all bills — staleTime: Infinity means data stays fresh until manually
  // invalidated (e.g. after create/update). This prevents re-fetching and
  // skeleton flash on every navigation back to this page.
  const { data: bills = [], isPending } = useQuery({
    queryKey: ["bills"],
    queryFn: () =>
      (listBills as (opts: { data: unknown }) => Promise<BillListItem[]>)({
        data: {},
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Group bills into columns
  const columnBills = useMemo(() => {
    const grouped: Record<string, BillListItem[]> = {
      in_review: [],
      pending_approval: [],
      awaiting_payment: [],
      scheduled_paid: [],
    };

    for (const bill of bills) {
      if (bill.status === "scheduled" || bill.status === "paid") {
        grouped.scheduled_paid.push(bill);
      } else if (bill.status === "approved") {
        // Collapsed: "approved" maps into awaiting_payment column
        grouped.awaiting_payment.push(bill);
      } else if (grouped[bill.status]) {
        grouped[bill.status].push(bill);
      }
    }

    return grouped;
  }, [bills]);

  // Column totals
  const columnTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const [key, items] of Object.entries(columnBills)) {
      totals[key] = items.reduce((sum, b) => sum + Number.parseFloat(b.amount ?? "0"), 0);
    }
    return totals;
  }, [columnBills]);

  return (
    <>
      <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-[#e2e8f0] px-4 py-3 sm:gap-3 sm:px-8 sm:py-5 dark:border-white/10">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="shrink-0 text-[#10b981]"
              dangerouslySetInnerHTML={{ __html: ICON_PATHS.CreditCardAngle }}
            />
            <h1 className="truncate text-lg font-semibold text-[#1e293b] sm:text-xl dark:text-white">
              Bills
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {/* View Toggle — the icons stay 16px; only the hit area grows for a thumb. */}
            <div className="flex items-center rounded-lg border border-[#e2e8f0] dark:border-white/10 overflow-hidden">
              <button
                type="button"
                onClick={() =>
                  navigate({
                    to: "/bills" as string & {},
                    search: { view: "kanban" },
                  })
                }
                aria-pressed={!isListView}
                className={`flex min-h-11 min-w-11 items-center justify-center p-2 transition-colors md:min-h-0 md:min-w-0 ${
                  !isListView
                    ? "bg-[#f1f5f9] dark:bg-white/10 text-[#1e293b] dark:text-white"
                    : "text-[#94a3b8] dark:text-white/40 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                }`}
                title="Kanban View"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                  <rect x="14" y="3" width="7" height="10" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() =>
                  navigate({
                    to: "/bills" as string & {},
                    search: { view: "list" },
                  })
                }
                aria-pressed={isListView}
                className={`flex min-h-11 min-w-11 items-center justify-center p-2 transition-colors md:min-h-0 md:min-w-0 ${
                  isListView
                    ? "bg-[#f1f5f9] dark:bg-white/10 text-[#1e293b] dark:text-white"
                    : "text-[#94a3b8] dark:text-white/40 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                }`}
                title="List View"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
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
              </button>
            </div>

            <Link
              to="/bills/create"
              className="flex items-center justify-center gap-2 w-11 h-11 md:w-auto md:h-auto md:px-4 md:py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white text-sm font-medium hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all no-underline"
              aria-label="Create Bill"
              title="Create Bill"
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
                className="shrink-0"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="hidden md:inline">Create Bill</span>
            </Link>
            <button
              type="button"
              className="flex items-center justify-center gap-2 w-11 h-11 md:w-auto md:h-auto md:px-4 md:py-2 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
              onClick={() => setUploadOpen(true)}
              aria-label="Upload Bill"
              title="Upload Bill"
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
                className="shrink-0"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="hidden md:inline">Upload Bill</span>
            </button>
          </div>
        </div>

        {/* List View or Kanban Board */}
        {isListView ? (
          <div className="flex-1 overflow-y-auto">
            <BillListView bills={bills} isPending={isPending} />
          </div>
        ) : (
          /* A board is horizontal by nature, so it stays one below md rather than becoming a list.
             The columns narrow to just under the viewport so the next one peeks, and snap, which is
             what makes a sideways scroll discoverable on a phone. */
          <div className="flex-1 snap-x snap-mandatory overflow-x-auto px-4 py-4 sm:snap-none sm:px-6 sm:py-5">
            <div className="flex h-full min-w-max gap-4 sm:gap-5">
              {COLUMNS.map((col) => {
                const items = columnBills[col.key] ?? [];
                const total = columnTotals[col.key] ?? 0;

                return (
                  <div
                    key={col.key}
                    className="flex min-h-[200px] w-[86vw] max-w-[320px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-[#e2e8f0] bg-white sm:w-[320px] sm:max-w-none dark:border-white/10 dark:bg-[#111827]"
                  >
                    {/* Column header */}
                    <div
                      className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10"
                      style={{ backgroundColor: col.bgColor }}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {col.icon}
                        <span
                          className="truncate text-sm font-semibold"
                          style={{ color: col.color }}
                        >
                          {col.label}
                        </span>
                        <span className="ml-1 shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-[#e2e8f0] dark:bg-white/10 text-[#64748b] dark:text-white/50">
                          {items.length}
                        </span>
                      </div>

                      {/* Filter dropdown for Scheduled & Paid */}
                      {col.key === "scheduled_paid" && (
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setFilterOpen(!filterOpen)}
                            className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap text-[#64748b] transition-colors hover:bg-white/60 md:min-h-0 dark:text-white/50 dark:hover:bg-white/5"
                          >
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
                              <path d="M3 6h18M7 12h10M10 18h4" />
                            </svg>
                            {FILTER_OPTIONS.find((f) => f.value === paidFilter)?.label}
                          </button>

                          {filterOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-10"
                                onClick={() => setFilterOpen(false)}
                                onKeyDown={() => {}}
                                role="presentation"
                              />
                              <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-lg z-20 py-1">
                                <div className="px-3 py-1.5 text-[10px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                                  Filter By
                                </div>
                                {FILTER_OPTIONS.map((opt) => (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => {
                                      setPaidFilter(opt.value);
                                      setFilterOpen(false);
                                    }}
                                    className={`flex min-h-11 w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors md:min-h-0 ${
                                      paidFilter === opt.value
                                        ? "text-[#1e293b] dark:text-white font-medium bg-[#f8fafc] dark:bg-white/5"
                                        : "text-[#64748b] dark:text-white/50 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                                    }`}
                                  >
                                    {opt.label}
                                    {paidFilter === opt.value && (
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="#10b981"
                                        strokeWidth="2.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <polyline points="20 6 9 17 4 12" />
                                      </svg>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Column body — scrollable */}
                    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
                      {/* Skeleton cards for active background uploads */}
                      {col.key === "in_review" &&
                        processingJobs.map((job) => (
                          <BillUploadSkeleton
                            key={job.id}
                            fileName={job.fileName}
                            status={job.status}
                          />
                        ))}
                      {isPending && items.length === 0 && processingJobs.length === 0 ? (
                        <BillCardSkeleton />
                      ) : (
                        items.map((bill) => <BillCard key={bill.id} bill={bill} />)
                      )}
                    </div>

                    {/* Column footer — total (only if bills exist) */}
                    {items.length > 0 && (
                      <div className="px-4 py-2.5 border-t border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                            Total
                          </span>
                          <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                            {formatCurrency(total)}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <BillUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <BillUploadProgress />
    </>
  );
}

// ============================================================================
// Bill Card Component
// ============================================================================

function BillCard({ bill }: { bill: BillListItem }) {
  const navigate = useNavigate();
  const isOverdue =
    bill.status !== "paid" && bill.status !== "voided" && getDaysOverdue(bill.dueDate) > 0;
  const daysOverdue = getDaysOverdue(bill.dueDate);
  const initial = getVendorInitial(bill.vendorName);
  const color = getVendorColor(bill.vendorName);

  return (
    <a
      href={`/bills/${bill.id}`}
      onClick={(e) => {
        e.preventDefault();
        navigate({ to: `/bills/${bill.id}` });
      }}
      className="no-underline"
    >
      <div className="group relative p-4 rounded-lg border border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] hover:shadow-md hover:border-[#a7f3d0] dark:hover:border-[#10b981]/30 transition-all cursor-pointer">
        {/* Overdue badge */}
        {isOverdue && (
          <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#fff7ed] dark:bg-orange-900/30 text-[#ea580c] text-[10px] font-semibold">
            ⚠ Overdue
          </div>
        )}

        {/* Vendor row — the overdue badge is absolutely positioned over this band, so the name
            has to reserve room for it rather than truncate underneath it. */}
        <div className={`flex items-center gap-2.5 mb-3 ${isOverdue ? "pr-20" : ""}`}>
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ backgroundColor: color }}
          >
            {initial}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
              {bill.vendorName ?? "Unknown Vendor"}
            </div>
            {bill.billNumber && (
              <div className="truncate text-xs text-[#94a3b8] dark:text-white/40">
                #{bill.billNumber}
              </div>
            )}
          </div>
        </div>

        {/* Amount */}
        <div className="tabular-figures mb-2 text-lg font-semibold text-[#1e293b] dark:text-white">
          {formatCurrency(bill.amount)}
        </div>

        {/* Due date */}
        <div className="flex items-center gap-1.5">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke={isOverdue ? "#ea580c" : "#94a3b8"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span
            className={`text-xs ${isOverdue ? "text-[#ea580c] font-medium" : "text-[#94a3b8] dark:text-white/40"}`}
          >
            {isOverdue
              ? `${daysOverdue} day${daysOverdue > 1 ? "s" : ""} overdue`
              : `Due ${formatDate(bill.dueDate)}`}
          </span>
        </div>
      </div>
    </a>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function BillCardSkeleton() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="p-4 rounded-lg border border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] animate-pulse"
        >
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
            <div className="flex-1">
              <div className="h-3.5 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
            </div>
          </div>
          <div className="h-5 w-20 rounded bg-[#e2e8f0] dark:bg-white/10 mb-2" />
          <div className="h-3 w-28 rounded bg-[#e2e8f0] dark:bg-white/10" />
        </div>
      ))}
    </>
  );
}

// ============================================================================
// Upload Processing Skeleton
// ============================================================================

function BillUploadSkeleton({
  fileName: _fileName,
  status: _status,
}: {
  fileName: string;
  status: string;
}) {
  void _fileName;
  void _status;
  return (
    <div className="p-4 rounded-lg border border-[#a7f3d0] dark:border-[#10b981]/30 bg-white dark:bg-[#15192a] animate-pulse">
      {/* Vendor row */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-8 h-8 rounded-full bg-[#d1fae5] dark:bg-emerald-900/40" />
        <div className="flex-1">
          <div className="h-3.5 w-24 rounded bg-[#d1fae5] dark:bg-emerald-900/30" />
        </div>
      </div>
      {/* Amount */}
      <div className="h-5 w-20 rounded bg-[#d1fae5] dark:bg-emerald-900/30 mb-2" />
      {/* Date */}
      <div className="h-3 w-28 rounded bg-[#d1fae5] dark:bg-emerald-900/30" />
    </div>
  );
}
