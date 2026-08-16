/**
 * Invoices Page — Kanban Board + List View
 * 4-column board or expandable list grouped by status
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { listInvoices } from "./api/-invoices";
import type { InvoiceListItem } from "./api/-invoices";
import { INVOICE_MAPPING_CONFIG } from "../lib/invoice-mapping-config";
export { INVOICE_MAPPING_CONFIG };
import { InvoiceListView } from "../components/invoices/InvoiceListView";
import { formatCurrency } from "@/utils/format";
import { keys } from "@/lib/query-keys";

// ============================================================================
// Route
// ============================================================================

interface InvoicesSearch {
  view?: "kanban" | "list";
}

export const Route = createFileRoute("/invoices")({
  component: InvoicesPage,
  validateSearch(search: Record<string, unknown>): InvoicesSearch {
    let view: "kanban" | "list" = "kanban";
    if (search.view === "list" || search.view === "kanban") {
      view = search.view;
    } else if (typeof window !== "undefined") {
      const saved = localStorage.getItem("app:invoices-view");
      if (saved === "list" || saved === "kanban") view = saved;
    }
    return { view };
  },
});

// ============================================================================
// Column Config
// ============================================================================

interface KanbanColumn {
  key: string;
  label: string;
  statuses: string[];
  emptyMessage: string;
  accentColor: string;
}

const COLUMNS: KanbanColumn[] = [
  {
    key: "draft",
    label: "Draft",
    statuses: ["draft"],
    emptyMessage: "No draft invoices",
    accentColor: "#94a3b8",
  },
  {
    key: "sent",
    label: "Sent",
    statuses: ["sent", "viewed"],
    emptyMessage: "No sent invoices",
    accentColor: "#3b82f6",
  },
  {
    key: "overdue",
    label: "Overdue",
    statuses: ["overdue"],
    emptyMessage: "No overdue invoices",
    accentColor: "#f59e0b",
  },
  {
    key: "paid",
    label: "Paid",
    statuses: ["paid"],
    emptyMessage: "All caught up!",
    accentColor: "#10b981",
  },
];

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

// ============================================================================
// Page Component
// ============================================================================

function InvoicesPage() {
  const { view } = Route.useSearch() as InvoicesSearch;
  const navigate = useNavigate();

  const { data: invoicesList = [], isPending } = useQuery({
    queryKey: keys.invoices.all(),
    queryFn: () =>
      (listInvoices as (opts: { data: unknown }) => Promise<InvoiceListItem[]>)({ data: {} }),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const isListView = view === "list";

  // Persist view preference
  useEffect(() => {
    if (view) localStorage.setItem("app:invoices-view", view);
  }, [view]);

  return (
    <>
      <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-8 py-4 sm:py-5 border-b border-[#e2e8f0] dark:border-white/10">
          {/* The count sits under the title on a phone — beside it, the pair plus the controls
              overruns 375px and the header clips. */}
          <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-3">
            <h1 className="truncate text-lg sm:text-xl font-semibold text-[#1e293b] dark:text-white">
              Invoices
            </h1>
            <span className="text-sm text-[#94a3b8] dark:text-white/40 whitespace-nowrap">
              {invoicesList.length} total
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* View Toggle */}
            <div className="flex items-center rounded-lg border border-[#e2e8f0] dark:border-white/10 overflow-hidden">
              <button
                type="button"
                onClick={() =>
                  navigate({ to: "/invoices" as string & {}, search: { view: "kanban" } })
                }
                className={`flex h-11 w-11 md:h-8 md:w-8 items-center justify-center transition-colors ${
                  !isListView
                    ? "bg-[#f1f5f9] dark:bg-white/10 text-[#1e293b] dark:text-white"
                    : "text-[#94a3b8] dark:text-white/40 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                }`}
                aria-label="Kanban view"
                aria-pressed={!isListView}
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
                  navigate({ to: "/invoices" as string & {}, search: { view: "list" } })
                }
                className={`flex h-11 w-11 md:h-8 md:w-8 items-center justify-center transition-colors ${
                  isListView
                    ? "bg-[#f1f5f9] dark:bg-white/10 text-[#1e293b] dark:text-white"
                    : "text-[#94a3b8] dark:text-white/40 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                }`}
                aria-label="List view"
                aria-pressed={isListView}
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
              to={"/invoices/draft/create" as string & {}}
              aria-label="Create Invoice"
              title="Create Invoice"
              className="inline-flex items-center justify-center gap-2 w-11 h-11 md:w-auto md:h-auto md:px-4 md:py-2 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all no-underline"
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
              <span className="hidden md:inline">Create Invoice</span>
            </Link>
          </div>
        </div>

        {/* List View or Kanban Board */}
        {isListView ? (
          <div className="flex-1 overflow-y-auto">
            <InvoiceListView invoices={invoicesList} isPending={isPending} />
          </div>
        ) : (
          <div className="flex-1 scroll-x">
            <div className="flex gap-4 p-4 sm:p-6 h-full min-w-max">
              {COLUMNS.map((column) => {
                const columnInvoices = invoicesList.filter((inv) =>
                  column.statuses.includes(inv.status),
                );

                return (
                  /* Narrower on a phone so the next column peeks in — a board that scrolls with
                     no visual hint reads as a single truncated list. */
                  <div
                    key={column.key}
                    className="flex flex-col w-[280px] min-w-[280px] sm:w-[320px] sm:min-w-[320px]"
                  >
                    {/* Column Header */}
                    <div className="flex items-center gap-2 mb-3 px-1">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: column.accentColor }}
                      />
                      <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                        {column.label}
                      </span>
                      <span className="text-xs text-[#94a3b8] dark:text-white/40 bg-[#f1f5f9] dark:bg-white/8 px-1.5 py-0.5 rounded-full">
                        {columnInvoices.length}
                      </span>
                    </div>

                    {/* Column Body */}
                    <div className="flex-1 flex flex-col gap-2 overflow-y-auto rounded-xl bg-[#f1f5f9]/50 dark:bg-white/[0.03] p-2 border border-[#e2e8f0]/50 dark:border-white/5">
                      {isPending && columnInvoices.length === 0 ? (
                        <>
                          <InvoiceCardSkeleton />
                          <InvoiceCardSkeleton />
                        </>
                      ) : columnInvoices.length === 0 ? (
                        <div className="flex items-center justify-center py-12 text-xs text-[#94a3b8] dark:text-white/30">
                          {column.emptyMessage}
                        </div>
                      ) : (
                        columnInvoices.map((invoice) => (
                          <InvoiceCard key={invoice.id} invoice={invoice} />
                        ))
                      )}
                    </div>

                    {/* Column Total */}
                    {columnInvoices.length > 0 && (
                      <div className="mt-2 px-3 py-2.5 text-right">
                        <span className="text-xs font-semibold text-[#64748b] dark:text-white/40">
                          Total:{" "}
                        </span>
                        <span className="tabular-figures text-sm font-bold text-[#1e293b] dark:text-white">
                          {formatCurrency(
                            columnInvoices.reduce(
                              (sum, inv) => sum + Number.parseFloat(inv.total),
                              0,
                            ),
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Invoice Card
// ============================================================================

function InvoiceCard({ invoice }: { invoice: InvoiceListItem }) {
  const navigate = useNavigate();
  const isDraft = invoice.status === "draft";
  const invoicePath = isDraft ? `/invoices/draft/${invoice.id}` : `/invoices/${invoice.id}`;
  const isOverdue =
    invoice.status !== "paid" && invoice.status !== "voided" && getDaysOverdue(invoice.dueDate) > 0;
  const daysOverdue = getDaysOverdue(invoice.dueDate);

  return (
    <button
      type="button"
      onClick={() => navigate({ to: invoicePath as string & {} })}
      className="group w-full text-left bg-white dark:bg-[#111827] rounded-lg border border-[#e2e8f0] dark:border-white/10 p-4 hover:shadow-md hover:border-[#cbd5e1] dark:hover:border-white/20 transition-all cursor-pointer"
    >
      {/* Customer + Amount */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{
              backgroundColor: getCustomerColor(invoice.customerName),
            }}
          >
            {getCustomerInitial(invoice.customerName)}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
              {invoice.customerName ?? "Unknown Customer"}
            </div>
            <div className="text-xs text-[#94a3b8] dark:text-white/40 truncate">
              {invoice.invoiceNumber}
            </div>
          </div>
        </div>
        <div className="tabular-figures shrink-0 whitespace-nowrap text-sm font-semibold text-[#1e293b] dark:text-white">
          {formatCurrency(invoice.total)}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-[#f1f5f9] dark:border-white/5">
        <div className="text-xs text-[#94a3b8] dark:text-white/40">
          Due {formatDate(invoice.dueDate)}
        </div>
        {isOverdue && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#fef3c7] text-[#d97706] dark:bg-orange-900/30 dark:text-orange-300">
            {daysOverdue}d overdue
          </span>
        )}
        {invoice.status === "viewed" && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#dbeafe] text-[#2563eb] dark:bg-blue-900/30 dark:text-blue-300">
            Viewed
          </span>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

function InvoiceCardSkeleton() {
  return (
    <div className="bg-white dark:bg-[#111827] rounded-lg border border-[#e2e8f0] dark:border-white/10 p-4 animate-pulse">
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-8 h-8 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
        <div className="flex-1">
          <div className="h-3.5 w-24 rounded bg-[#e2e8f0] dark:bg-white/10 mb-1.5" />
          <div className="h-2.5 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
        </div>
        <div className="h-4 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
      </div>
      <div className="h-3 w-28 rounded bg-[#e2e8f0] dark:bg-white/10" />
    </div>
  );
}
