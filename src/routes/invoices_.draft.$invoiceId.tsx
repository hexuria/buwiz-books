/**
 * Invoice Detail Page — /invoices/$invoiceId
 * Mirrors the create page layout, pre-populated from the API.
 * Header: "Review" button + vertical dots popover (delete).
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useRef, useEffect } from "react";
import { getInvoice, updateInvoice, deleteInvoice, transitionInvoiceStatus } from "./api/-invoices";
import type { InvoiceDetail } from "./api/-invoices";
import {
  type LineItem,
  DiscountModal,
  CustomerCombobox,
  LineItemRow,
  formatCurrency,
  generateId,
  createEmptyLineItem,
  MarkAsPaidModal,
} from "@/components/invoices";
import { Modal } from "@/components/ui/Modal";
import {
  clearStableIdempotencyKey,
  type StableIdempotencyIntent,
  withStableIdempotencyKey,
} from "@/lib/client-idempotency";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/invoices_/draft/$invoiceId")({
  component: InvoiceDetailPage,
});

// ============================================================================
// Page Component
// ============================================================================

function InvoiceDetailPage() {
  const { invoiceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Fetch invoice data
  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () =>
      (getInvoice as (opts: { data: unknown }) => Promise<InvoiceDetail>)({
        data: { id: invoiceId },
      }),
  });

  // Form state — seeded from fetched invoice
  const [customerId, setCustomerId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([createEmptyLineItem()]);

  // Invoice-level discount
  const [overallDiscountName, setOverallDiscountName] = useState("");
  const [overallDiscountType, setOverallDiscountType] = useState<"amount" | "percent">("percent");
  const [overallDiscountValue, setOverallDiscountValue] = useState("");

  // Discount modal state
  const [discountModalOpen, setDiscountModalOpen] = useState(false);
  const [discountModalTarget, setDiscountModalTarget] = useState<string | "overall">("overall");
  const [discountModalInitial, setDiscountModalInitial] = useState<{
    name: string;
    type: "amount" | "percent";
    value: string;
  }>({ name: "", type: "percent", value: "" });

  // More menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMarkAsPaidModal, setShowMarkAsPaidModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const transitionIntentRef = useRef<StableIdempotencyIntent | null>(null);

  // Seed form state from fetched invoice
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (invoice && !seeded) {
      setCustomerId(invoice.customerId);
      setInvoiceNumber(invoice.invoiceNumber);
      setIssueDate(invoice.issueDate);
      setDueDate(invoice.dueDate);
      setNotes(invoice.notes ?? "");

      // Map API line items to component LineItem shape
      const mapped: LineItem[] = invoice.lineItems.map((li) => ({
        id: li.id || generateId(),
        description: li.description ?? "",
        quantity: li.quantity ?? "1",
        unitPrice: li.unitPrice ?? "0",
        amount: li.amount ?? "0",
        revenueAccountId: li.revenueAccountId ?? "",
        showNote: false,
        note: "",
        discountName: "",
        discountType: "percent" as const,
        discountValue: "",
      }));
      setLineItems(mapped.length > 0 ? mapped : [createEmptyLineItem()]);

      // Seed overall discount if present
      const disc = Number.parseFloat(invoice.discountAmount);
      if (disc > 0) {
        setOverallDiscountType("amount");
        setOverallDiscountValue(disc.toFixed(2));
        setOverallDiscountName("Discount");
      }
      setSeeded(true);
    }
  }, [invoice, seeded]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // Open discount modal helper
  const openDiscount = useCallback(
    (target: string) => {
      setDiscountModalTarget(target);
      if (target === "overall") {
        setDiscountModalInitial({
          name: overallDiscountName,
          type: overallDiscountType,
          value: overallDiscountValue,
        });
      } else {
        const item = lineItems.find((li) => li.id === target);
        setDiscountModalInitial({
          name: item?.discountName || "",
          type: item?.discountType || "percent",
          value: item?.discountValue || "",
        });
      }
      setDiscountModalOpen(true);
    },
    [lineItems, overallDiscountName, overallDiscountType, overallDiscountValue],
  );

  const handleDiscountSave = useCallback(
    (name: string, type: "amount" | "percent", value: string) => {
      if (discountModalTarget === "overall") {
        setOverallDiscountName(name);
        setOverallDiscountType(type);
        setOverallDiscountValue(value);
      } else {
        setLineItems((prev) =>
          prev.map((li) =>
            li.id === discountModalTarget
              ? { ...li, discountName: name, discountType: type, discountValue: value }
              : li,
          ),
        );
      }
    },
    [discountModalTarget],
  );

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      (updateInvoice as (opts: { data: unknown }) => Promise<unknown>)({
        data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
  });

  // Transition mutation (for Review → send / Mark as Paid)
  const transitionMutation = useMutation({
    mutationFn: (data: {
      invoiceId: string;
      newStatus: string;
      idempotencyKey?: string;
      bankAccountId?: string;
      paymentAmount?: string;
    }) => (transitionInvoiceStatus as (opts: { data: unknown }) => Promise<unknown>)({ data }),
    onSuccess: (_result, variables) => {
      clearStableIdempotencyKey(transitionIntentRef, variables.idempotencyKey);
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: () =>
      (deleteInvoice as (opts: { data: unknown }) => Promise<unknown>)({
        data: { id: invoiceId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      navigate({ to: "/invoices" });
    },
  });

  // Line item handlers
  const updateLineItem = useCallback((id: string, field: keyof LineItem, value: string) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: value };
        if (field === "quantity" || field === "unitPrice") {
          const qty = Number.parseFloat(updated.quantity) || 0;
          const price = Number.parseFloat(updated.unitPrice) || 0;
          updated.amount = (qty * price).toFixed(2);
        }
        return updated;
      }),
    );
  }, []);

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [...prev, createEmptyLineItem()]);
  }, []);

  const toggleNote = useCallback((id: string) => {
    setLineItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, showNote: !item.showNote } : item)),
    );
  }, []);

  const removeLineItem = useCallback((id: string) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((i) => i.id !== id) : prev));
  }, []);

  // Totals — per-line discounts + overall discount
  const subtotal = lineItems.reduce((sum, item) => sum + (Number.parseFloat(item.amount) || 0), 0);
  const perLineDiscountTotal = lineItems.reduce((sum, item) => {
    if (!item.discountValue) return sum;
    const lineTotal =
      (Number.parseFloat(item.quantity) || 0) * (Number.parseFloat(item.unitPrice) || 0);
    return (
      sum +
      (item.discountType === "percent"
        ? (lineTotal * (Number.parseFloat(item.discountValue) || 0)) / 100
        : Number.parseFloat(item.discountValue) || 0)
    );
  }, 0);
  const afterLineDiscounts = Math.max(0, subtotal - perLineDiscountTotal);
  const overallDiscountAmount =
    overallDiscountType === "percent"
      ? afterLineDiscounts * ((Number.parseFloat(overallDiscountValue) || 0) / 100)
      : Number.parseFloat(overallDiscountValue) || 0;
  const discountAmount = perLineDiscountTotal + overallDiscountAmount;
  const total = Math.max(0, afterLineDiscounts - overallDiscountAmount);

  // Calculate term days
  const termDays =
    issueDate && dueDate
      ? Math.round(
          (new Date(`${dueDate}T00:00:00`).getTime() -
            new Date(`${issueDate}T00:00:00`).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : 0;

  // Submit handler — saves via updateInvoice
  const handleSave = () => {
    if (!customerId) return;

    updateMutation.mutate({
      id: invoiceId,
      invoiceNumber,
      customerId,
      issueDate,
      dueDate,
      subtotal: subtotal.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      taxAmount: "0",
      total: total.toFixed(2),
      notes: notes || null,
      paymentTerms: termDays > 0 ? `Net ${termDays}` : undefined,
      lineItems: lineItems
        .filter((item) => item.description || Number.parseFloat(item.unitPrice) > 0)
        .map((item, idx) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          revenueAccountId: item.revenueAccountId || null,
          sortOrder: idx,
        })),
    });
  };

  // Review handler — saves first then navigates to review page
  const handleReview = () => {
    if (!customerId) return;

    // Save first, then navigate to review page
    updateMutation.mutate(
      {
        id: invoiceId,
        invoiceNumber,
        customerId,
        issueDate,
        dueDate,
        subtotal: subtotal.toFixed(2),
        discountAmount: discountAmount.toFixed(2),
        taxAmount: "0",
        total: total.toFixed(2),
        notes: notes || null,
        paymentTerms: termDays > 0 ? `Net ${termDays}` : undefined,
        lineItems: lineItems
          .filter((item) => item.description || Number.parseFloat(item.unitPrice) > 0)
          .map((item, idx) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            amount: item.amount,
            revenueAccountId: item.revenueAccountId || null,
            sortOrder: idx,
          })),
      },
      {
        onSuccess: () => {
          navigate({ to: `/invoices/draft/${invoiceId}/review` });
        },
      },
    );
  };

  // Loading skeleton
  if (isLoading || !invoice) {
    return <InvoiceDetailSkeleton />;
  }

  const isDraft = invoice.status === "draft";
  const isSent = invoice.status === "sent" || invoice.status === "viewed";
  const isPaid = invoice.status === "paid";
  const isVoided = invoice.status === "voided";
  const canEdit = isDraft;

  return (
    <div className="min-h-screen bg-[#f1f5f9] dark:bg-[#0c1322] py-8 px-4">
      {/* Header */}
      <div className="max-w-3xl mx-auto mb-6 flex items-center justify-between">
        <Link
          to={"/invoices" as string & {}}
          className="flex items-center gap-1.5 text-sm text-[#10b981] hover:text-[#059669] font-medium no-underline transition-colors"
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
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Invoices
        </Link>

        <div className="flex items-center gap-2">
          {/* Status badge for non-draft */}
          {!isDraft && <StatusBadge status={invoice.status} />}

          {/* Primary action button */}
          {isDraft && (
            <button
              type="button"
              onClick={handleReview}
              disabled={!customerId || updateMutation.isPending || transitionMutation.isPending}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
            >
              {updateMutation.isPending ? "Saving…" : "Review"}
            </button>
          )}
          {/* Mark as Paid — show for sent/overdue invoices */}
          {(isSent || invoice.status === "overdue") && (
            <button
              type="button"
              onClick={() => setShowMarkAsPaidModal(true)}
              disabled={transitionMutation.isPending}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-[#0d9488] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
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
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              Mark as Paid
            </button>
          )}

          {/* Vertical dots menu */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              className="touch-target inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#1e293b] text-[#64748b] dark:text-white/50 hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-xl z-30 overflow-hidden">
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      handleSave();
                      setMenuOpen(false);
                    }}
                    disabled={updateMutation.isPending}
                    className="w-full text-left px-4 py-2.5 text-sm text-[#1e293b] dark:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors flex items-center gap-2.5"
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
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                      <polyline points="17 21 17 13 7 13 7 21" />
                      <polyline points="7 3 7 8 15 8" />
                    </svg>
                    Save Draft
                  </button>
                )}
                {!isPaid && !isVoided && (
                  <button
                    type="button"
                    onClick={() => {
                      transitionMutation.mutate({ invoiceId, newStatus: "voided" });
                      setMenuOpen(false);
                    }}
                    className="w-full text-left px-4 py-2.5 text-sm text-[#64748b] dark:text-white/60 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors flex items-center gap-2.5"
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
                      <circle cx="12" cy="12" r="10" />
                      <path d="m15 9-6 6M9 9l6 6" />
                    </svg>
                    Void Invoice
                  </button>
                )}
                {(isDraft || isVoided) && (
                  <>
                    <div className="border-t border-[#e2e8f0] dark:border-white/10" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setShowDeleteModal(true);
                      }}
                      className="w-full text-left px-4 py-2.5 text-sm text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-colors flex items-center gap-2.5"
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
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete Invoice
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Form Card */}
      <div className="max-w-3xl mx-auto">
        <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-sm overflow-hidden">
          {/* Title */}
          <div className="px-8 py-5 bg-gradient-to-r from-[#f8fafc] to-[#f1f5f9] dark:from-[#15192a] dark:to-[#1a1f35] border-b border-[#e2e8f0] dark:border-white/10 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-[#1e293b] dark:text-white">
              Invoice {invoiceNumber}
            </h1>
            <StatusBadge status={invoice.status} />
          </div>

          {/* Metadata Fields */}
          <div className="px-8 py-6 grid grid-cols-2 gap-5">
            {/* Customer Selection */}
            <div className="col-span-2">
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Customer
              </label>
              {canEdit ? (
                <CustomerCombobox
                  customerId={customerId}
                  onSelect={(id: string) => setCustomerId(id)}
                />
              ) : (
                <div className="px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] text-sm text-[#1e293b] dark:text-white">
                  {invoice.customerName ?? "Unknown"}
                </div>
              )}
            </div>

            {/* Invoice Number */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Invoice Number
              </label>
              <input
                type="text"
                value={invoiceNumber}
                readOnly
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] text-base sm:text-sm text-[#64748b] dark:text-white/50"
              />
            </div>

            {/* Issue Date */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Invoice Date
              </label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                readOnly={!canEdit}
                className={`w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-base sm:text-sm text-[#1e293b] dark:text-white transition-all ${
                  canEdit
                    ? "bg-white dark:bg-[#0f172a] focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981]"
                    : "bg-[#f8fafc] dark:bg-[#0f172a]"
                }`}
              />
            </div>

            {/* Due Date */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Due Date
                {termDays > 0 && (
                  <span className="ml-2 text-[10px] font-normal text-[#94a3b8] dark:text-white/30">
                    ({termDays} days)
                  </span>
                )}
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                readOnly={!canEdit}
                className={`w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-base sm:text-sm text-[#1e293b] dark:text-white transition-all ${
                  canEdit
                    ? "bg-white dark:bg-[#0f172a] focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981]"
                    : "bg-[#f8fafc] dark:bg-[#0f172a]"
                }`}
              />
            </div>

            {/* Notes */}
            <div className="col-span-2">
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                readOnly={!canEdit}
                placeholder="Add any notes for the customer..."
                rows={2}
                className={`w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 transition-all resize-none ${
                  canEdit
                    ? "bg-white dark:bg-[#0f172a] focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981]"
                    : "bg-[#f8fafc] dark:bg-[#0f172a]"
                }`}
              />
            </div>
          </div>

          {/* Line Items */}
          <div className="border-t border-[#e2e8f0] dark:border-white/10">
            <div className="px-8 py-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-[#1e293b] dark:text-white">Line Items</h2>
                {canEdit && (
                  <button
                    type="button"
                    onClick={addLineItem}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#10b981] hover:text-[#059669] transition-colors"
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
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add Item
                  </button>
                )}
              </div>

              {canEdit ? (
                <div className="scroll-x scroll-x-shadow">
                  <table className="w-full border-separate border-spacing-0 min-w-[34rem]">
                    <thead>
                      <tr className="text-left text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                        <th className="pb-2 w-8" />
                        <th className="pb-2 pr-3">Item</th>
                        <th className="pb-2 w-8" />
                        <th className="pb-2 pr-3 w-20">Qty</th>
                        <th className="pb-2 pr-3 w-28">Price</th>
                        <th className="pb-2 w-24 text-right">Total</th>
                        <th className="pb-2 w-8" />
                      </tr>
                    </thead>
                    {lineItems.map((item, index) => (
                      <LineItemRow
                        key={item.id}
                        item={item}
                        index={index}
                        lineItems={lineItems}
                        setLineItems={setLineItems}
                        updateLineItem={updateLineItem}
                        removeLineItem={removeLineItem}
                        toggleNote={toggleNote}
                        onOpenDiscount={openDiscount}
                      />
                    ))}
                  </table>
                </div>
              ) : (
                /* Read-only line items */
                <div className="scroll-x scroll-x-shadow">
                  <table className="w-full min-w-[34rem]">
                    <thead>
                      <tr className="text-left text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                        <th className="pb-3 pr-4">Description</th>
                        <th className="pb-3 pr-4 text-center">Qty</th>
                        <th className="pb-3 pr-4 text-right">Price</th>
                        <th className="pb-3 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.lineItems.map((item, idx) => (
                        <tr key={item.id} className="border-t border-[#f1f5f9] dark:border-white/5">
                          <td className="py-3 pr-4 text-sm text-[#1e293b] dark:text-white">
                            {item.description || `Line ${idx + 1}`}
                          </td>
                          <td className="py-3 pr-4 text-sm text-center text-[#64748b] dark:text-white/50">
                            {item.quantity}
                          </td>
                          <td className="py-3 pr-4 text-sm text-right text-[#64748b] dark:text-white/50">
                            {formatCurrency(item.unitPrice)}
                          </td>
                          <td className="py-3 text-sm text-right font-medium text-[#1e293b] dark:text-white">
                            {formatCurrency(item.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Totals */}
            <div className="px-8 pt-4">
              <div className="scroll-x scroll-x-shadow">
                <table className="w-full border-separate border-spacing-0 min-w-[34rem]">
                  <tbody>
                    {/* Subtotal row */}
                    <tr className="text-sm">
                      {canEdit && <td className="w-8" />}
                      <td
                        className={`py-1.5 text-right text-[#64748b] dark:text-white/50 font-medium`}
                      >
                        Subtotal
                      </td>
                      {canEdit && (
                        <>
                          <td className="w-8" />
                          <td className="w-20" />
                          <td className="w-28" />
                        </>
                      )}
                      <td
                        className={`${canEdit ? "w-24" : ""} py-1.5 text-right font-semibold text-[#1e293b] dark:text-white`}
                      >
                        {formatCurrency(subtotal)}
                      </td>
                      {canEdit && <td className="w-9" />}
                    </tr>

                    {/* Discount row */}
                    {canEdit ? (
                      overallDiscountValue ? (
                        <tr className="text-sm group/overall-discount">
                          <td className="w-8 py-1 align-middle rounded-l-lg group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]">
                            <div className="flex items-center justify-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setOverallDiscountName("");
                                  setOverallDiscountValue("");
                                }}
                                className="p-0.5 rounded-full text-[#94a3b8] dark:text-white/30 hover:text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-all opacity-0 group-hover/overall-discount:opacity-100"
                                title="Remove discount"
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <circle cx="12" cy="12" r="10" />
                                  <path d="m15 9-6 6M9 9l6 6" />
                                </svg>
                              </button>
                            </div>
                          </td>
                          <td className="py-1 text-right align-middle group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]">
                            <div className="flex items-center justify-end gap-1.5">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="text-[#10b981] shrink-0"
                              >
                                <line x1="19" y1="5" x2="5" y2="19" />
                                <circle cx="6.5" cy="6.5" r="2.5" />
                                <circle cx="17.5" cy="17.5" r="2.5" />
                              </svg>
                              <span className="text-xs text-[#64748b] dark:text-white/50 font-medium truncate max-w-40">
                                {overallDiscountName || "Discount"}
                              </span>
                            </div>
                          </td>
                          <td className="w-8 group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]" />
                          <td className="w-20 group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]" />
                          <td className="w-28 py-1 pr-3 align-middle group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]">
                            <div className="relative">
                              {overallDiscountType !== "percent" && (
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[#94a3b8] dark:text-white/30 pointer-events-none">
                                  $
                                </span>
                              )}
                              <input
                                type="text"
                                value={
                                  overallDiscountType === "percent"
                                    ? `${overallDiscountValue}%`
                                    : (Number(overallDiscountValue) || 0).toFixed(2)
                                }
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/[^0-9.]/g, "");
                                  setOverallDiscountValue(raw);
                                }}
                                className={`w-full py-1 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white text-right focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all ${
                                  overallDiscountType !== "percent" ? "pl-5 pr-2" : "px-2"
                                }`}
                              />
                            </div>
                          </td>
                          <td className="w-24 py-1 text-right font-medium text-[#ef4444] group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]">
                            -{formatCurrency(overallDiscountAmount)}
                          </td>
                          <td className="w-9 rounded-r-lg group-hover/overall-discount:bg-[#F5F6F9] dark:group-hover/overall-discount:bg-[#0d1b2f]" />
                        </tr>
                      ) : (
                        <tr className="text-sm">
                          <td colSpan={5} />
                          <td colSpan={2} className="py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() => openDiscount("overall")}
                              className="flex items-center gap-1.5 text-xs font-medium text-[#10b981] hover:text-[#059669] transition-colors ml-auto"
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
                                <line x1="19" y1="5" x2="5" y2="19" />
                                <circle cx="6.5" cy="6.5" r="2.5" />
                                <circle cx="17.5" cy="17.5" r="2.5" />
                              </svg>
                              Add Discount
                            </button>
                          </td>
                        </tr>
                      )
                    ) : (
                      Number.parseFloat(invoice.discountAmount) > 0 && (
                        <tr className="text-sm">
                          <td className="py-1.5 text-right text-[#64748b] dark:text-white/50">
                            Discount
                          </td>
                          <td className="py-1.5 text-right text-[#ef4444] font-medium">
                            -{formatCurrency(invoice.discountAmount)}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>

              {/* Total row */}
              <div className="-mx-8 px-8 mt-10 border-t border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]/50 rounded-b-xl">
                <div className="scroll-x scroll-x-shadow">
                  <table className="w-full border-separate border-spacing-0 min-w-[34rem]">
                    <tbody>
                      <tr className="text-sm">
                        {canEdit && <td className="w-8" />}
                        <td className="py-4 text-right text-base font-semibold text-[#1e293b] dark:text-white">
                          Total
                        </td>
                        {canEdit && (
                          <>
                            <td className="w-8" />
                            <td className="w-20" />
                            <td className="w-28" />
                          </>
                        )}
                        <td
                          className={`${canEdit ? "w-24" : ""} py-4 text-right text-base font-bold text-[#1e293b] dark:text-white`}
                        >
                          {formatCurrency(canEdit ? total : invoice.total)}
                        </td>
                        {canEdit && <td className="w-9" />}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {(updateMutation.isError || deleteMutation.isError) && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#fef2f2] dark:bg-red-900/20 border border-[#fecaca] dark:border-red-800/40 text-sm text-[#dc2626] dark:text-red-300">
            {updateMutation.isError
              ? "Failed to update invoice. Please try again."
              : "Failed to delete invoice. Please try again."}
          </div>
        )}

        {/* Success toast */}
        {updateMutation.isSuccess && !transitionMutation.isPending && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#f0fdf4] dark:bg-emerald-900/20 border border-[#bbf7d0] dark:border-emerald-800/40 text-sm text-[#16a34a] dark:text-emerald-300">
            Invoice updated successfully.
          </div>
        )}
      </div>

      {/* Discount Modal */}
      {discountModalOpen && (
        <DiscountModal
          open={discountModalOpen}
          onClose={() => setDiscountModalOpen(false)}
          onSave={handleDiscountSave}
          initialName={discountModalInitial.name}
          initialType={discountModalInitial.type}
          initialValue={discountModalInitial.value}
        />
      )}

      {/* Mark as Paid Modal */}
      {showMarkAsPaidModal && invoice && (
        <MarkAsPaidModal
          invoiceNumber={invoice.invoiceNumber}
          total={invoice.total}
          balanceDue={invoice.balanceDue ?? invoice.total}
          isPending={transitionMutation.isPending}
          onCancel={() => setShowMarkAsPaidModal(false)}
          onConfirm={({ bankAccountId, paymentAmount }) => {
            const bal = Number.parseFloat(invoice.balanceDue ?? invoice.total);
            const amt = Number.parseFloat(paymentAmount);
            const isPartial = amt > 0 && amt < bal - 0.005;
            transitionMutation.mutate(
              withStableIdempotencyKey(transitionIntentRef, {
                invoiceId,
                newStatus: isPartial ? "partial" : "paid",
                bankAccountId,
                paymentAmount,
              }),
              {
                onSuccess: async () => {
                  await queryClient.invalidateQueries({ queryKey: ["invoices"] });
                  await queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
                  setShowMarkAsPaidModal(false);
                  if (!isPartial) navigate({ to: "/invoices" });
                },
              },
            );
          }}
        />
      )}
      {/* Delete Confirmation Modal */}
      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="Delete Invoice?"
        mobile="center"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowDeleteModal(false)}
              className="min-h-11 py-2.5 px-5 rounded-xl border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 font-medium text-sm hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setShowDeleteModal(false);
                deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className="min-h-11 py-2.5 px-5 rounded-xl bg-red-500 hover:bg-red-600 text-white font-semibold text-sm transition-all disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Yes, delete invoice"}
            </button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mx-auto mb-4">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ef4444"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
          </div>
          <p className="text-sm text-[#64748b] dark:text-white/50">
            This will permanently delete this invoice. This action cannot be undone.
          </p>
        </div>
      </Modal>
    </div>
  );
}

// ============================================================================
// Status Badge
// ============================================================================

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  overdue: "Overdue",
  partial: "Partially Paid",
  paid: "Paid",
  voided: "Voided",
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: "rgba(148,163,184,0.12)", text: "#94a3b8" },
  sent: { bg: "rgba(59,130,246,0.12)", text: "#3b82f6" },
  viewed: { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  overdue: { bg: "rgba(245,158,11,0.12)", text: "#f59e0b" },
  partial: { bg: "rgba(14,165,233,0.12)", text: "#0ea5e9" },
  paid: { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  voided: { bg: "rgba(239,68,68,0.12)", text: "#ef4444" },
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.draft;
  return (
    <span
      className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function InvoiceDetailSkeleton() {
  return (
    <div className="min-h-screen bg-[#f1f5f9] dark:bg-[#0c1322] py-8 px-4">
      <div className="max-w-3xl mx-auto mb-6 flex items-center justify-between">
        <div className="h-4 w-28 rounded bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
        <div className="h-10 w-24 rounded-lg bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
      </div>
      <div className="max-w-3xl mx-auto bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden animate-pulse">
        <div className="px-8 py-5 bg-[#f8fafc] dark:bg-[#15192a] border-b border-[#e2e8f0] dark:border-white/10">
          <div className="h-6 w-40 rounded bg-[#e2e8f0] dark:bg-white/10" />
        </div>
        <div className="px-8 py-6 grid grid-cols-2 gap-5">
          <div className="col-span-2 h-10 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
          <div className="h-10 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
          <div className="h-10 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
          <div className="h-10 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
          <div className="col-span-2 h-16 rounded-lg bg-[#f1f5f9] dark:bg-white/5" />
        </div>
        <div className="border-t border-[#e2e8f0] dark:border-white/10 px-8 py-4 space-y-3">
          <div className="h-4 w-full rounded bg-[#f1f5f9] dark:bg-white/5" />
          <div className="h-4 w-full rounded bg-[#f1f5f9] dark:bg-white/5" />
          <div className="h-4 w-2/3 rounded bg-[#f1f5f9] dark:bg-white/5" />
        </div>
      </div>
    </div>
  );
}
