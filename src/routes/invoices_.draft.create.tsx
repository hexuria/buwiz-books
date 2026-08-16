/**
 * Invoice Creation Page — /invoices/draft/create
 * form with customer combobox + New Customer modal,
 * and product combobox in line items + New Product modal.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { createInvoice, getNextInvoiceNumber } from "./api/-invoices";
import {
  type LineItem,
  DiscountModal,
  CustomerCombobox,
  LineItemRow,
  formatCurrency,
  todayISO,
  addDays,
  createEmptyLineItem,
} from "@/components/invoices";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/invoices_/draft/create")({
  component: InvoiceCreatePage,
});

// ============================================================================
// Page Component
// ============================================================================

function InvoiceCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Form state
  const [customerId, setCustomerId] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(addDays(todayISO(), 30));
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

  // Fetch next invoice number
  const { data: invoiceNumber = "INV-0001" } = useQuery({
    queryKey: ["nextInvoiceNumber"],
    queryFn: () =>
      (getNextInvoiceNumber as (opts: { data: unknown }) => Promise<string>)({
        data: {},
      }),
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: any) =>
      (createInvoice as (opts: { data: unknown }) => Promise<unknown>)({
        data,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      navigate({ to: "/invoices" });
    },
  });

  // Line item handlers
  const updateLineItem = useCallback((id: string, field: keyof LineItem, value: string) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: value };
        // Auto-calculate amount
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

  // Submit handler
  const handleSubmit = () => {
    if (!customerId) return;

    createMutation.mutate({
      invoiceNumber,
      customerId,
      issueDate,
      dueDate,
      subtotal: subtotal.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      taxAmount: "0",
      total: total.toFixed(2),
      notes: notes || undefined,
      paymentTerms: "Net 30",
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

  // Calculate term days
  const termDays = Math.round(
    (new Date(`${dueDate}T00:00:00`).getTime() - new Date(`${issueDate}T00:00:00`).getTime()) /
      (1000 * 60 * 60 * 24),
  );

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
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!customerId || createMutation.isPending}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
        >
          {createMutation.isPending ? "Saving…" : "Save Invoice"}
        </button>
      </div>

      {/* Form Card */}
      <div className="max-w-3xl mx-auto">
        <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-sm overflow-hidden">
          {/* Title */}
          <div className="px-8 py-5 bg-gradient-to-r from-[#f8fafc] to-[#f1f5f9] dark:from-[#15192a] dark:to-[#1a1f35] border-b border-[#e2e8f0] dark:border-white/10">
            <h1 className="text-lg font-semibold text-[#1e293b] dark:text-white">New Invoice</h1>
          </div>

          {/* Metadata Fields */}
          <div className="px-8 py-6 grid grid-cols-2 gap-5">
            {/* Customer Selection — Combobox */}
            <div className="col-span-2">
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Customer
              </label>
              <CustomerCombobox
                customerId={customerId}
                onSelect={(id: string) => setCustomerId(id)}
              />
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
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
              />
            </div>

            {/* Due Date */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Due Date
                <span className="ml-2 text-[10px] font-normal text-[#94a3b8] dark:text-white/30">
                  ({termDays} days)
                </span>
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
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
                placeholder="Add any notes for the customer..."
                rows={2}
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all resize-none"
              />
            </div>
          </div>

          {/* Line Items */}
          <div className="border-t border-[#e2e8f0] dark:border-white/10">
            <div className="px-8 py-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-[#1e293b] dark:text-white">Line Items</h2>
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
              </div>

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
            </div>

            {/* Totals */}
            <div className="px-8 pt-4">
              <div className="scroll-x scroll-x-shadow">
                <table className="w-full border-separate border-spacing-0 min-w-[34rem]">
                  <tbody>
                    {/* Subtotal row */}
                    <tr className="text-sm">
                      <td className="w-8" />
                      <td className="py-1.5 text-right text-[#64748b] dark:text-white/50 font-medium">
                        Subtotal
                      </td>
                      <td className="w-8" />
                      <td className="w-20" />
                      <td className="w-28" />
                      <td className="w-24 py-1.5 text-right font-semibold text-[#1e293b] dark:text-white">
                        {formatCurrency(subtotal)}
                      </td>
                      <td className="w-9" />
                    </tr>

                    {/* Overall Discount row */}
                    {overallDiscountValue ? (
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
                    )}
                  </tbody>
                </table>
              </div>

              {/* Total row — negative margins to extend full width past px-8 padding */}
              <div className="-mx-8 px-8 mt-10 border-t border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]/50 rounded-b-xl">
                <div className="scroll-x scroll-x-shadow">
                  <table className="w-full border-separate border-spacing-0 min-w-[34rem]">
                    <tbody>
                      <tr className="text-sm">
                        <td className="w-8" />
                        <td className="py-4 text-right text-base font-semibold text-[#1e293b] dark:text-white">
                          Total
                        </td>
                        <td className="w-8" />
                        <td className="w-20" />
                        <td className="w-28" />
                        <td className="w-24 py-4 text-right text-base font-bold text-[#1e293b] dark:text-white">
                          {formatCurrency(total)}
                        </td>
                        <td className="w-9" />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {createMutation.isError && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#fef2f2] dark:bg-red-900/20 border border-[#fecaca] dark:border-red-800/40 text-sm text-[#dc2626] dark:text-red-300">
            Failed to create invoice. Please try again.
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
    </div>
  );
}
