/**
 * Invoice Detail Page — /invoices/$invoiceId
 * Read-only view for sent, overdue, paid, and voided invoices.
 * Includes actions: Record Payment, Void, Resend Email.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { getInvoice, transitionInvoiceStatus, sendInvoiceEmailFn } from "./api/-invoices";
import type { InvoiceDetail } from "./api/-invoices";
import { getOrgSettings } from "./api/-org-settings";
import type { OrgSettings } from "./api/-org-settings";
import { listAccounts } from "./api/-accounts";
import { useSession } from "@/lib/auth-client";
import { brand, brandInitial } from "@/config/brand";
import { formatCurrency } from "@/lib/format-currency";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";
import { getActiveOrganizationId } from "@/lib/auth-types";
import { useOrganizationCurrency } from "@/hooks/useActiveOrganization";
import { keys } from "@/lib/query-keys";
import {
  clearStableIdempotencyKey,
  type StableIdempotencyIntent,
  withStableIdempotencyKey,
} from "@/lib/client-idempotency";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/invoices_/$invoiceId")({
  component: InvoiceDetailRoute,
});

function InvoiceDetailRoute() {
  return (
    <AppErrorBoundary contextLabel="Invoice">
      <InvoiceDetailReadOnly />
    </AppErrorBoundary>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: string }> = {
  sent: {
    label: "Sent",
    bg: "rgba(59,130,246,0.12)",
    text: "#3b82f6",
    icon: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  },
  viewed: {
    label: "Viewed",
    bg: "rgba(16,185,129,0.12)",
    text: "#10b981",
    icon: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z",
  },
  overdue: {
    label: "Overdue",
    bg: "rgba(245,158,11,0.12)",
    text: "#f59e0b",
    icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  partial: {
    label: "Partial",
    bg: "rgba(14,165,233,0.12)",
    text: "#0ea5e9",
    icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1",
  },
  paid: {
    label: "Paid",
    bg: "rgba(16,185,129,0.12)",
    text: "#10b981",
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  voided: {
    label: "Voided",
    bg: "rgba(239,68,68,0.12)",
    text: "#ef4444",
    icon: "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636",
  },
};

// ============================================================================
// Page Component
// ============================================================================

function InvoiceDetailReadOnly() {
  const { invoiceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: session } = useSession();
  const orgId = getActiveOrganizationId(session) ?? "";
  const { currency } = useOrganizationCurrency();

  // Fetch invoice
  const { data: invoice, isLoading } = useQuery({
    queryKey: keys.invoices.detail(invoiceId),
    queryFn: () =>
      (getInvoice as (opts: { data: unknown }) => Promise<InvoiceDetail>)({
        data: { id: invoiceId },
      }),
  });

  // Fetch org settings (for resend & display)
  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () =>
      (getOrgSettings as (opts: { data: unknown }) => Promise<OrgSettings>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  // State
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [resending, setResending] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>("");
  const [paymentAmountInput, setPaymentAmountInput] = useState<string>("");
  const transitionIntentRef = useRef<StableIdempotencyIntent | null>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenuOpen(false);
      }
    }
    if (actionMenuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [actionMenuOpen]);

  // Fetch bank/cash accounts for payment modal
  type PaymentAccount = { id: string; name: string; accountNumber?: string; isActive?: boolean };
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ["accounts-payment"],
    queryFn: async () => {
      const all = await (listAccounts as (opts: { data: unknown }) => Promise<PaymentAccount[]>)({
        data: { subtypes: ["bank_accounts", "other_current_assets"] },
      });
      return all.filter((a) => a.isActive !== false);
    },
    enabled: showPaymentModal,
  });

  // Mutations
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
      queryClient.invalidateQueries({ queryKey: keys.invoices.detail(invoiceId) });
      queryClient.invalidateQueries({ queryKey: keys.invoices.all() });
    },
  });

  // Handlers
  const handleRecordPayment = () => {
    if (!selectedBankAccountId) return;
    setShowPaymentModal(false);
    const mutationData: {
      invoiceId: string;
      newStatus: string;
      bankAccountId: string;
      paymentAmount?: string;
    } = {
      invoiceId,
      newStatus: "paid",
      bankAccountId: selectedBankAccountId,
    };
    // If user entered a custom amount (partial payment)
    if (paymentAmountInput && invoice) {
      const balance = Number.parseFloat(invoice.balanceDue ?? invoice.total);
      const entered = Number.parseFloat(paymentAmountInput);
      if (entered > 0 && entered < balance - 0.005) {
        mutationData.newStatus = "partial";
      }
      mutationData.paymentAmount = paymentAmountInput;
    }
    transitionMutation.mutate(withStableIdempotencyKey(transitionIntentRef, mutationData), {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: keys.invoices.all() });
        await queryClient.invalidateQueries({ queryKey: keys.invoices.detail(invoiceId) });
        setSelectedBankAccountId("");
        setPaymentAmountInput("");
        // Stay on page for partial, navigate away for full payment
        if (mutationData.newStatus === "paid") {
          navigate({ to: "/invoices" });
        }
      },
    });
  };

  const closePaymentModal = () => {
    setShowPaymentModal(false);
    setSelectedBankAccountId("");
    setPaymentAmountInput("");
  };

  const handleVoid = () => {
    setShowVoidConfirm(false);
    transitionMutation.mutate(
      { invoiceId, newStatus: "voided" },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: keys.invoices.all() });
          navigate({ to: "/invoices" });
        },
      },
    );
  };

  const handleResend = async () => {
    if (!invoice?.customerEmail) {
      showToast("Customer email is required to resend.", { icon: "error" });
      return;
    }
    setResending(true);
    try {
      await (sendInvoiceEmailFn as (opts: { data: unknown }) => Promise<unknown>)({
        data: {
          invoiceId,
          to: invoice.customerEmail,
          fromCompany: orgSettings?.name ?? brand.appName,
        },
      });
      showToast("Invoice resent successfully!", { icon: "send" });
    } catch {
      showToast("Failed to resend invoice. Please try again.", { icon: "error" });
    } finally {
      setResending(false);
    }
  };

  // Loading
  if (isLoading || !invoice) {
    return <DetailSkeleton />;
  }

  // Redirect drafts to the edit page
  if (invoice.status === "draft") {
    navigate({ to: `/invoices/draft/${invoiceId}` as string & {} });
    return null;
  }

  const statusCfg = STATUS_CONFIG[invoice.status] ?? STATUS_CONFIG.sent;
  const canRecordPayment = ["sent", "viewed", "overdue", "partial"].includes(invoice.status);
  const canVoid = invoice.status !== "voided" && invoice.status !== "paid";
  const canResend = ["sent", "viewed", "overdue"].includes(invoice.status);

  return (
    <div className="min-h-full bg-[#e8edf4] dark:bg-[#0c1322]">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#111827]/80 backdrop-blur-md border-b border-[#e2e8f0] dark:border-white/10">
        <div className="max-w-[1200px] mx-auto px-3 sm:px-6 h-14 flex items-center justify-between">
          {/* Left — Back to Invoices */}
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

          {/* Right — Status + Actions */}
          <div className="flex items-center gap-3">
            {/* Status Badge */}
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold"
              style={{ backgroundColor: statusCfg.bg, color: statusCfg.text }}
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
                <path d={statusCfg.icon} />
              </svg>
              {statusCfg.label}
            </span>

            {/* Actions dropdown */}
            {(canRecordPayment || canVoid || canResend) && (
              <div ref={actionMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setActionMenuOpen(!actionMenuOpen)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
                >
                  Actions
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>

                {actionMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-xl z-30 overflow-hidden">
                    {canRecordPayment && (
                      <button
                        type="button"
                        onClick={() => {
                          setActionMenuOpen(false);
                          setShowPaymentModal(true);
                        }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#1e293b] dark:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors flex items-center gap-2.5"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
                        </svg>
                        Record Payment
                      </button>
                    )}
                    {canResend && (
                      <button
                        type="button"
                        onClick={() => {
                          setActionMenuOpen(false);
                          handleResend();
                        }}
                        disabled={resending}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#1e293b] dark:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors flex items-center gap-2.5 disabled:opacity-50"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#3b82f6"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                        {resending ? "Resending…" : "Resend Email"}
                      </button>
                    )}
                    {canVoid && (
                      <>
                        <div className="border-t border-[#e2e8f0] dark:border-white/10" />
                        <button
                          type="button"
                          onClick={() => {
                            setActionMenuOpen(false);
                            setShowVoidConfirm(true);
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
                            <circle cx="12" cy="12" r="10" />
                            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                          </svg>
                          Void Invoice
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-[1200px] mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-6">
        {/* Left — Invoice Card */}
        <div className="flex-1 min-w-0">
          <div className="bg-white dark:bg-[#111827] rounded-2xl shadow-lg overflow-hidden border border-[#e2e8f0] dark:border-white/10">
            {/* Branded Header */}
            <div
              className="relative px-8 py-7"
              style={{
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              }}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold bg-white/20">
                    {(orgSettings?.name ?? brandInitial).charAt(0).toUpperCase()}
                  </div>
                  <h2 className="text-xl font-bold text-white drop-shadow-sm">
                    {orgSettings?.name ?? brand.appName}
                  </h2>
                </div>
                <div className="text-right text-white/90">
                  <p className="text-sm font-medium">#{invoice.invoiceNumber}</p>
                  <p className="text-xs opacity-80">{formatDate(invoice.issueDate)}</p>
                </div>
              </div>
            </div>

            {/* Amount + Due Date */}
            <div className="px-8 py-6 border-b border-[#e2e8f0] dark:border-white/10">
              <p className="text-4xl font-bold text-[#1e293b] dark:text-white mb-2">
                {formatCurrency(invoice.total, currency)}
              </p>
              {invoice.status === "paid" ? (
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#f0fdf4] dark:bg-emerald-900/20 text-[#10b981] text-xs font-medium">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Paid in Full
                </div>
              ) : (
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#f0fdf4] dark:bg-emerald-900/20 text-[#10b981] text-xs font-medium">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  Due {formatDate(invoice.dueDate)}
                </div>
              )}

              {Number.parseFloat(invoice.balanceDue) > 0 &&
                invoice.status !== "paid" &&
                invoice.status !== "voided" && (
                  <p className="text-sm text-[#64748b] dark:text-white/50 mt-2">
                    Balance Due:{" "}
                    <span className="font-semibold text-[#1e293b] dark:text-white">
                      {formatCurrency(invoice.balanceDue, currency)}
                    </span>
                  </p>
                )}
            </div>

            {/* Line Items */}
            <div className="px-8 py-6 border-b border-[#e2e8f0] dark:border-white/10">
              <div className="scroll-x scroll-x-shadow">
                <table className="w-full min-w-[34rem]">
                  <thead>
                    <tr className="text-left text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                      <th className="pb-3 pr-4">Item</th>
                      <th className="pb-3 pr-4 text-center">Qty</th>
                      <th className="pb-3 pr-4 text-right">Price</th>
                      <th className="pb-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lineItems.map((item, idx) => (
                      <tr
                        key={item.id || idx}
                        className="border-t border-[#f1f5f9] dark:border-white/5"
                      >
                        <td className="py-3.5 pr-4 text-sm text-[#1e293b] dark:text-white">
                          {item.description || `Item ${idx + 1}`}
                        </td>
                        <td className="py-3.5 pr-4 text-sm text-center text-[#64748b] dark:text-white/50">
                          {item.quantity}
                        </td>
                        <td className="py-3.5 pr-4 text-sm text-right text-[#64748b] dark:text-white/50">
                          {formatCurrency(item.unitPrice, currency)}
                        </td>
                        <td className="py-3.5 text-sm text-right font-semibold text-[#1e293b] dark:text-white">
                          {formatCurrency(item.amount, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {Number.parseFloat(invoice.discountAmount ?? "0") > 0 && (
                      <tr className="border-t border-[#e2e8f0] dark:border-white/10">
                        <td
                          colSpan={3}
                          className="py-3 text-right text-sm text-[#64748b] dark:text-white/50"
                        >
                          Discount
                        </td>
                        <td className="py-3 text-right text-sm font-medium text-[#ef4444]">
                          -{formatCurrency(invoice.discountAmount ?? "0", currency)}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-[#e2e8f0] dark:border-white/10">
                      <td
                        colSpan={3}
                        className="py-4 text-right text-sm font-semibold text-[#10b981]"
                      >
                        Total
                      </td>
                      <td className="py-4 text-right text-lg font-bold text-[#10b981]">
                        {formatCurrency(invoice.total, currency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div className="px-8 py-5 border-b border-[#e2e8f0] dark:border-white/10 bg-[#fefce8] dark:bg-yellow-900/10">
                <p className="text-xs font-semibold text-[#92400e] dark:text-yellow-300/80 mb-1">
                  Memo
                </p>
                <p className="text-sm text-[#78350f] dark:text-yellow-200/70 whitespace-pre-wrap leading-relaxed">
                  {invoice.notes}
                </p>
              </div>
            )}

            {/* From / To */}
            <div className="px-8 py-6 grid grid-cols-2 gap-6">
              <div>
                <h4 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
                  From
                </h4>
                <p className="text-sm font-medium text-[#1e293b] dark:text-white">
                  {orgSettings?.name ?? brand.appName}
                </p>
                {orgSettings?.emailSenderEmail && (
                  <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">
                    {orgSettings.emailSenderEmail}
                  </p>
                )}
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
                  To
                </h4>
                <p className="text-sm font-medium text-[#1e293b] dark:text-white">
                  {invoice.customerName ?? "Customer"}
                </p>
                {invoice.customerEmail && (
                  <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">
                    {invoice.customerEmail}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right — Sidebar */}
        <div className="w-80 shrink-0 space-y-5">
          {/* Payment Summary */}
          <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 p-5">
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-4 flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
              </svg>
              Payment Summary
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-[#64748b] dark:text-white/50">Total</span>
                <span className="font-medium text-[#1e293b] dark:text-white">
                  {formatCurrency(invoice.total, currency)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748b] dark:text-white/50">Amount Paid</span>
                <span className="font-medium text-[#10b981]">
                  {formatCurrency(invoice.amountPaid, currency)}
                </span>
              </div>
              <div className="border-t border-[#e2e8f0] dark:border-white/10 pt-3 flex justify-between text-sm">
                <span className="font-medium text-[#1e293b] dark:text-white">Balance Due</span>
                <span
                  className={`font-bold ${Number.parseFloat(invoice.balanceDue) <= 0 ? "text-[#10b981]" : "text-[#ef4444]"}`}
                >
                  {formatCurrency(invoice.balanceDue, currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 p-5">
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-4 flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Timeline
            </h3>
            <div className="space-y-4">
              {/* Created */}
              <TimelineEntry
                label="Created"
                date={formatShortDate(invoice.createdAt)}
                color="#94a3b8"
                isFirst
              />
              {/* Sent */}
              {invoice.sentAt && (
                <TimelineEntry
                  label="Sent"
                  date={formatShortDate(invoice.sentAt)}
                  color="#3b82f6"
                />
              )}
              {/* Paid */}
              {invoice.paidAt && (
                <TimelineEntry
                  label="Paid"
                  date={formatShortDate(invoice.paidAt)}
                  color="#10b981"
                />
              )}
              {/* Voided */}
              {invoice.status === "voided" && (
                <TimelineEntry
                  label="Voided"
                  date={formatShortDate(invoice.updatedAt)}
                  color="#ef4444"
                />
              )}
            </div>
          </div>

          {/* Invoice Details */}
          <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 p-5">
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-4 flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              Details
            </h3>
            <div className="space-y-3">
              <DetailRow label="Invoice #" value={invoice.invoiceNumber} />
              <DetailRow label="Issue Date" value={formatDate(invoice.issueDate)} />
              <DetailRow label="Due Date" value={formatDate(invoice.dueDate)} />
              {invoice.paymentTerms && <DetailRow label="Terms" value={invoice.paymentTerms} />}
            </div>
          </div>
        </div>
      </div>

      {/* Record Payment Modal */}
      <Modal
        open={showPaymentModal}
        onClose={closePaymentModal}
        title="Record Payment"
        mobile="fullscreen"
        size="sm"
        // A stray backdrop tap would discard the account and amount already entered.
        closeOnBackdrop={false}
        footer={
          <>
            <button
              type="button"
              onClick={closePaymentModal}
              className="min-h-11 py-3 px-5 rounded-xl border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 font-medium text-sm hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRecordPayment}
              disabled={transitionMutation.isPending || !selectedBankAccountId}
              className="min-h-11 py-3 px-5 rounded-xl bg-gradient-to-r from-[#10b981] to-[#059669] text-white font-semibold text-sm hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {transitionMutation.isPending ? "Recording…" : "Confirm Payment"}
            </button>
          </>
        }
      >
        <div className="w-16 h-16 rounded-full bg-[#f0fdf4] flex items-center justify-center mx-auto mb-4">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#10b981"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
          </svg>
        </div>
        <p className="text-sm text-[#64748b] dark:text-white/60 mb-6 leading-relaxed text-center">
          Invoice <strong>{invoice.invoiceNumber}</strong> — Balance due:{" "}
          <strong>{formatCurrency(invoice.balanceDue ?? invoice.total, currency)}</strong>
        </p>

        {/* Bank Account Selection */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Deposit Account *
          </label>
          <select
            value={selectedBankAccountId}
            onChange={(e) => setSelectedBankAccountId(e.target.value)}
            className="w-full min-h-11 px-3 py-2.5 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/50 transition-all"
          >
            <option value="">Select payment account…</option>
            {bankAccounts.map((acct) => (
              <option key={acct.id} value={acct.id}>
                {acct.name}
                {acct.accountNumber ? ` (•••${acct.accountNumber.slice(-4)})` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Payment Amount (for partial payments) */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Payment Amount
          </label>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            max={invoice.balanceDue ?? invoice.total}
            placeholder={`${Number.parseFloat(invoice.balanceDue ?? invoice.total).toFixed(2)} (full balance)`}
            value={paymentAmountInput}
            onChange={(e) => setPaymentAmountInput(e.target.value)}
            className="w-full min-h-11 px-3 py-2.5 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/50 transition-all"
          />
          <p className="text-xs text-[#94a3b8] dark:text-white/40 mt-1">
            Leave empty to record full balance. Enter a smaller amount for partial payment.
          </p>
        </div>
      </Modal>

      {/* Void Confirm Modal */}
      <Modal
        open={showVoidConfirm}
        onClose={() => setShowVoidConfirm(false)}
        title="Void Invoice?"
        mobile="center"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowVoidConfirm(false)}
              className="min-h-11 py-3 px-5 rounded-xl border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 font-medium text-sm hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleVoid}
              disabled={transitionMutation.isPending}
              className="min-h-11 py-3 px-5 rounded-xl bg-gradient-to-r from-[#ef4444] to-[#dc2626] text-white font-semibold text-sm hover:shadow-lg transition-all disabled:opacity-50"
            >
              {transitionMutation.isPending ? "Voiding…" : "Void Invoice"}
            </button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-[#fef2f2] flex items-center justify-center mx-auto mb-4">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ef4444"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <p className="text-sm text-[#64748b] dark:text-white/60 leading-relaxed">
            This will permanently void invoice <strong>{invoice.invoiceNumber}</strong>. This action
            cannot be undone.
          </p>
        </div>
      </Modal>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function TimelineEntry({
  label,
  date,
  color,
  isFirst,
}: {
  label: string;
  date: string;
  color: string;
  isFirst?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-center">
        {!isFirst && <div className="w-px h-3 bg-[#e2e8f0] dark:bg-white/10" />}
        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      </div>
      <div className={!isFirst ? "-mt-0.5" : ""}>
        <p className="text-xs font-semibold text-[#1e293b] dark:text-white">{label}</p>
        <p className="text-[11px] text-[#94a3b8] dark:text-white/40">{date}</p>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-[#64748b] dark:text-white/50">{label}</span>
      <span className="font-medium text-[#1e293b] dark:text-white">{value}</span>
    </div>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function DetailSkeleton() {
  return (
    <div className="min-h-full bg-[#e8edf4] dark:bg-[#0c1322]">
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#111827]/80 backdrop-blur-md border-b border-[#e2e8f0] dark:border-white/10">
        <div className="max-w-[1200px] mx-auto px-3 sm:px-6 h-14 flex items-center justify-between">
          <div className="h-4 w-32 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse" />
          <div className="flex gap-2">
            <div className="h-8 w-20 bg-[#e2e8f0] dark:bg-white/10 rounded-full animate-pulse" />
            <div className="h-9 w-24 bg-[#e2e8f0] dark:bg-white/10 rounded-lg animate-pulse" />
          </div>
        </div>
      </header>
      <div className="max-w-[1200px] mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-6">
        <div className="flex-1 h-[700px] bg-white dark:bg-[#111827] rounded-2xl animate-pulse" />
        <div className="w-80 space-y-5">
          <div className="h-36 bg-white dark:bg-[#111827] rounded-xl animate-pulse" />
          <div className="h-44 bg-white dark:bg-[#111827] rounded-xl animate-pulse" />
          <div className="h-32 bg-white dark:bg-[#111827] rounded-xl animate-pulse" />
        </div>
      </div>
    </div>
  );
}
