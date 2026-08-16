/**
 * Invoice Review Page — /invoices/draft/$invoiceId/review
 * Preview page with branded invoice card, sidebar customization, and send flow.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import {
  getInvoice,
  updateInvoice,
  sendInvoiceEmailFn,
  transitionInvoiceStatus,
  deleteInvoice,
} from "./api/-invoices";
import type { InvoiceDetail } from "./api/-invoices";
import { getOrgSettings, getOwnerEmail } from "./api/-org-settings";
import type { OrgSettings } from "./api/-org-settings";
import { useSession } from "@/lib/auth-client";
import { getActiveOrganizationId } from "@/lib/auth-types";
import { brandInitial } from "@/config/brand";
import { formatCurrency } from "@/components/invoices";
import { Modal } from "@/components/ui/Modal";
import {
  clearStableIdempotencyKey,
  type StableIdempotencyIntent,
  withStableIdempotencyKey,
} from "@/lib/client-idempotency";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/invoices_/draft/$invoiceId_/review")({
  component: InvoiceReviewPage,
});

// ============================================================================
// Constants
// ============================================================================

const BRAND_COLORS = [
  "#1e293b",
  "#1e3a5f",
  "#3b82f6",
  "#10b981",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
  "#059669",
  "#14b8a6",
  "#f59e0b",
];

const COVER_IMAGES = [
  "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
  "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
];

// ============================================================================
// Page Component
// ============================================================================

function InvoiceReviewPage() {
  const { invoiceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const orgId = getActiveOrganizationId(session) ?? "";

  // Fetch invoice
  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () =>
      (getInvoice as (opts: { data: unknown }) => Promise<InvoiceDetail>)({
        data: { id: invoiceId },
      }),
  });

  // Fetch org settings for email config (sender name, sender email)
  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () =>
      (getOrgSettings as (opts: { data: unknown }) => Promise<OrgSettings>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  // Fetch owner email as ultimate fallback for sender email
  const { data: ownerInfo } = useQuery({
    queryKey: ["org-owner", orgId],
    queryFn: () =>
      (
        getOwnerEmail as (opts: {
          data: unknown;
        }) => Promise<{ email: string; name: string } | null>
      )({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  // Resolve sender info with fallback chain:
  // Sender name: org email setting > org name > "Company"
  // Sender email: org email setting > owner email > ""
  const resolvedSenderName = orgSettings?.emailSenderName || orgSettings?.name || "Company";
  const resolvedSenderEmail = orgSettings?.emailSenderEmail || ownerInfo?.email || "";

  // State
  const [previewMode, setPreviewMode] = useState<"link" | "email">("link");
  const [memo, setMemo] = useState("");
  const [brandColor, setBrandColor] = useState("#1e293b");
  const [coverIndex, setCoverIndex] = useState(0);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const sendMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const transitionIntentRef = useRef<StableIdempotencyIntent | null>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (sendMenuRef.current && !sendMenuRef.current.contains(e.target as Node)) {
        setSendMenuOpen(false);
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    if (sendMenuOpen || moreMenuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [sendMenuOpen, moreMenuOpen]);

  // Mutations
  const transitionMutation = useMutation({
    mutationFn: (data: { invoiceId: string; newStatus: string; idempotencyKey?: string }) =>
      (transitionInvoiceStatus as (opts: { data: unknown }) => Promise<unknown>)({ data }),
    onSuccess: (_result, variables) => {
      clearStableIdempotencyKey(transitionIntentRef, variables.idempotencyKey);
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof Error ? err.message : "Failed to update invoice status. Please try again.";
      setErrorMsg(msg);
    },
  });

  const saveMutation = useMutation({
    mutationFn: (data: any) =>
      (updateInvoice as (opts: { data: unknown }) => Promise<unknown>)({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
  });

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

  // Handlers
  const handleSaveAndClose = () => {
    // Save memo/notes if changed, then navigate to list
    if (invoice && memo !== (invoice.notes ?? "")) {
      saveMutation.mutate(
        {
          id: invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          subtotal: invoice.subtotal,
          discountAmount: invoice.discountAmount,
          taxAmount: invoice.taxAmount,
          total: invoice.total,
          notes: memo || null,
          lineItems: invoice.lineItems.map((li, idx) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            amount: li.amount,
            sortOrder: idx,
          })),
        },
        { onSuccess: () => navigate({ to: "/invoices" }) },
      );
    } else {
      navigate({ to: "/invoices" });
    }
  };

  const handleSendClick = async () => {
    // Check if org settings are loaded before allowing send
    if (!orgSettings?.name) {
      setShowVerifyModal(true);
      return;
    }

    // Profile exists — send the email
    if (!invoice?.customerEmail) {
      setErrorMsg(
        "Customer email is required to send an invoice. Please update the customer record.",
      );
      return;
    }

    setSendingEmail(true);
    try {
      await (sendInvoiceEmailFn as (opts: { data: unknown }) => Promise<unknown>)({
        data: {
          invoiceId,
          to: invoice.customerEmail,
          memo: memo || undefined,
          fromCompany: resolvedSenderName,
          fromEmail: resolvedSenderEmail || undefined,
        },
      });
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      navigate({ to: "/invoices" });
    } catch {
      setErrorMsg("Failed to send invoice email. Please check your email settings and try again.");
    } finally {
      setSendingEmail(false);
    }
  };

  const handleCreateWithoutSending = () => {
    // Save Without Sending — keep as draft, just save memo and go back
    setSendMenuOpen(false);
    if (invoice && memo !== (invoice.notes ?? "")) {
      saveMutation.mutate(
        {
          id: invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          subtotal: invoice.subtotal,
          discountAmount: invoice.discountAmount,
          taxAmount: invoice.taxAmount,
          total: invoice.total,
          notes: memo || null,
          lineItems: invoice.lineItems.map((li, idx) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            amount: li.amount,
            sortOrder: idx,
          })),
        },
        { onSuccess: () => navigate({ to: "/invoices" }) },
      );
    } else {
      navigate({ to: "/invoices" });
    }
  };

  const handleDuplicate = () => {
    // Navigate to create page — TODO: pre-fill from existing invoice
    setMoreMenuOpen(false);
    navigate({ to: "/invoices/draft/create" });
  };

  const handleDelete = () => {
    setMoreMenuOpen(false);
    setShowDeleteConfirm(true);
  };

  // Seed memo from invoice notes
  useEffect(() => {
    if (invoice?.notes && !memo) {
      setMemo(invoice.notes);
    }
  }, [invoice, memo]);

  // Loading
  if (isLoading || !invoice) {
    return <ReviewSkeleton />;
  }

  const coverStyle = COVER_IMAGES[coverIndex] || COVER_IMAGES[0];

  return (
    <div className="min-h-screen bg-[#e8edf4] dark:bg-[#0c1322]">
      {/* Error toast */}
      {errorMsg && (
        <div
          className="fixed top-4 left-1/2 z-[99999] -translate-x-1/2"
          style={{ maxWidth: "480px", width: "calc(100% - 2rem)" }}
        >
          <div className="flex items-start gap-3 px-5 py-4 rounded-2xl bg-[#1e293b] text-white shadow-2xl border border-white/10">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ef4444"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 mt-0.5"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="flex-1 text-sm leading-relaxed">{errorMsg}</p>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="shrink-0 text-white/50 hover:text-white transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#111827]/80 backdrop-blur-md border-b border-[#e2e8f0] dark:border-white/10">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-6 h-14 flex items-center justify-between">
          {/* Left — Back to Edit */}
          <Link
            to={`/invoices/draft/${invoiceId}` as string & {}}
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
            Back to Edit
          </Link>

          {/* Right — Actions */}
          <div className="flex items-center gap-2.5">
            {/* Save & Close */}
            <button
              type="button"
              onClick={handleSaveAndClose}
              disabled={saveMutation.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all"
            >
              {saveMutation.isPending ? "Saving…" : "Cancel"}
            </button>

            {/* More menu (3 dots) */}
            <div ref={moreMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setMoreMenuOpen(!moreMenuOpen)}
                className="touch-target inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#1e293b] text-[#64748b] dark:text-white/50 hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>

              {moreMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-xl z-30 overflow-hidden">
                  <button
                    type="button"
                    onClick={handleDuplicate}
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
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    Duplicate
                  </button>
                  <div className="border-t border-[#e2e8f0] dark:border-white/10" />
                  <button
                    type="button"
                    onClick={handleDelete}
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
                    Delete
                  </button>
                </div>
              )}
            </div>

            {/* Send split button */}
            <div ref={sendMenuRef} className="relative flex">
              <button
                type="button"
                onClick={handleSendClick}
                disabled={sendingEmail || transitionMutation.isPending}
                className="inline-flex items-center gap-2 pl-5 pr-3 py-2.5 rounded-l-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                {sendingEmail ? "Sending…" : "Send"}
              </button>
              <button
                type="button"
                onClick={() => setSendMenuOpen(!sendMenuOpen)}
                className="inline-flex items-center px-2 py-2.5 rounded-r-lg bg-gradient-to-r from-[#059669] to-[#047857] text-white border-l border-white/20 hover:from-[#047857] hover:to-[#065f46] transition-all"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>

              {sendMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-xl z-30 overflow-hidden">
                  <button
                    type="button"
                    onClick={handleCreateWithoutSending}
                    disabled={transitionMutation.isPending}
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
                    Save Without Sending
                  </button>
                  <div className="border-t border-[#e2e8f0] dark:border-white/10" />
                  <button
                    type="button"
                    onClick={() => {
                      setSendMenuOpen(false);
                      transitionMutation.mutate(
                        withStableIdempotencyKey(transitionIntentRef, {
                          invoiceId,
                          newStatus: "sent",
                        }),
                        {
                          onSuccess: async () => {
                            await queryClient.invalidateQueries({ queryKey: ["invoices"] });
                            navigate({ to: "/invoices" });
                          },
                        },
                      );
                    }}
                    disabled={transitionMutation.isPending}
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
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    Mark as Sent
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-6">
        {/* Left — Invoice Preview Card */}
        <div className="flex-1 min-w-0">
          <InvoicePreviewCard
            invoice={invoice}
            brandColor={brandColor}
            coverStyle={coverStyle}
            memo={memo}
            senderName={resolvedSenderName}
            senderEmail={resolvedSenderEmail}
          />
        </div>

        {/* Right — Sidebar */}
        <div className="w-80 shrink-0 space-y-5">
          {/* Preview Toggle */}
          <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 p-5">
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-3">Preview</h3>
            <div className="flex bg-[#f1f5f9] dark:bg-[#0f172a] rounded-lg p-1">
              <button
                type="button"
                onClick={() => setPreviewMode("link")}
                className={`flex-1 text-center text-xs font-medium py-2 rounded-md transition-all ${
                  previewMode === "link"
                    ? "bg-[#10b981] text-white shadow-sm"
                    : "text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white"
                }`}
              >
                Payment Link
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("email")}
                className={`flex-1 text-center text-xs font-medium py-2 rounded-md transition-all ${
                  previewMode === "email"
                    ? "bg-[#10b981] text-white shadow-sm"
                    : "text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white"
                }`}
              >
                Email
              </button>
            </div>

            {previewMode === "link" && (
              <div className="mt-4 p-3 bg-[#f8fafc] dark:bg-[#0f172a] rounded-lg border border-[#e2e8f0] dark:border-white/10">
                <p className="text-[11px] text-[#94a3b8] dark:text-white/30 mb-2">
                  Payment link for customers
                </p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={`${typeof window !== "undefined" ? window.location.origin : ""}/invoices/pay/${invoice.id}`}
                    className="flex-1 text-base sm:text-xs text-[#1e293b] dark:text-white bg-white dark:bg-[#111827] border border-[#e2e8f0] dark:border-white/10 rounded px-2 py-1.5 font-mono truncate"
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const url = `${window.location.origin}/invoices/pay/${invoice.id}`;
                      navigator.clipboard.writeText(url);
                    }}
                    className="shrink-0 px-2 py-1.5 rounded bg-[#10b981] text-white text-xs font-medium hover:bg-[#059669] transition-colors"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-[10px] text-[#94a3b8] dark:text-white/30 mt-2">
                  Share this link with your customer so they can view and pay this invoice.
                </p>
              </div>
            )}

            {previewMode === "email" && (
              <div className="mt-4 p-3 bg-[#f8fafc] dark:bg-[#0f172a] rounded-lg border border-[#e2e8f0] dark:border-white/10">
                <p className="text-[11px] text-[#94a3b8] dark:text-white/30 mb-2">Email preview</p>
                <div className="space-y-2">
                  <div className="text-xs text-[#64748b] dark:text-white/50">
                    <span className="font-medium text-[#1e293b] dark:text-white">Subject:</span>{" "}
                    Invoice {invoice.invoiceNumber}
                  </div>
                  <div className="text-xs text-[#64748b] dark:text-white/50 leading-relaxed">
                    You have a new invoice for {formatCurrency(invoice.total)} due{" "}
                    {new Date(`${invoice.dueDate}T00:00:00`).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                    .
                  </div>
                  <div className="mt-3 text-center">
                    <span className="inline-block px-4 py-1.5 bg-[#10b981] text-white text-xs font-medium rounded-md">
                      View Invoice
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Invoice Customization */}
          <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 p-5">
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-3 flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#10b981]"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              Invoice Customization
            </h3>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              Memo
            </label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Add a note for your customer..."
              rows={5}
              className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all resize-none"
            />
          </div>

          {/* Branding */}
          <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 p-5">
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-4 flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#10b981]"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              Branding
            </h3>

            {/* Background Color */}
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-2">
              Background Color
            </label>
            <div className="flex flex-wrap gap-2 mb-5">
              {BRAND_COLORS.map((color, idx) => (
                <button
                  key={`brand-${idx}-${color}`}
                  type="button"
                  onClick={() => setBrandColor(color)}
                  className={`touch-target w-9 h-9 rounded-full transition-all ${
                    brandColor === color
                      ? "ring-2 ring-offset-2 ring-[#10b981] dark:ring-offset-[#111827]"
                      : "hover:scale-110"
                  }`}
                  style={{ background: color }}
                />
              ))}
            </div>

            {/* Cover */}
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-2">
              Cover
            </label>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {COVER_IMAGES.map((cover, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCoverIndex(idx)}
                  className={`w-20 h-16 rounded-lg shrink-0 transition-all ${
                    coverIndex === idx
                      ? "ring-2 ring-[#10b981] ring-offset-2 dark:ring-offset-[#111827]"
                      : "hover:scale-105"
                  }`}
                  style={{ background: cover }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Verify Business Modal — Modal portals to body, escaping the sidebar's overflow */}
      <Modal
        open={showVerifyModal}
        onClose={() => setShowVerifyModal(false)}
        title="Verify your business to send invoices!"
        mobile="center"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowVerifyModal(false)}
              className="min-h-11 py-3 px-5 rounded-xl border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 font-medium text-sm hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-all"
            >
              I&apos;ll do this later
            </button>
            <button
              type="button"
              onClick={() => {
                setShowVerifyModal(false);
                navigate({ to: `/organization/${orgId}/settings` as string & {} });
              }}
              className="min-h-11 py-3 px-5 rounded-xl bg-gradient-to-r from-[#10b981] to-[#059669] text-white font-semibold text-sm hover:shadow-lg transition-all"
            >
              Set Up Business Profile
            </button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-[#fef3c7] flex items-center justify-center mx-auto mb-4">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <p className="text-sm text-[#64748b] dark:text-white/60 leading-relaxed">
            Set up your company profile with your business name, address, and logo to start sending
            invoices to your customers.
          </p>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete Invoice?"
        mobile="center"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="min-h-11 py-2.5 px-5 rounded-xl border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 font-medium text-sm hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setShowDeleteConfirm(false);
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
// Invoice Preview Card
// ============================================================================

function InvoicePreviewCard({
  invoice,
  brandColor,
  coverStyle,
  memo,
  senderName,
  senderEmail,
}: {
  invoice: InvoiceDetail;
  brandColor: string;
  coverStyle: string;
  memo: string;
  senderName: string;
  senderEmail: string;
}) {
  const formattedDate = new Date(`${invoice.issueDate}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const formattedDueDate = new Date(`${invoice.dueDate}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="bg-white dark:bg-[#111827] rounded-2xl shadow-lg overflow-hidden border border-[#e2e8f0] dark:border-white/10">
      {/* Branded Header */}
      <div className="relative px-8 py-7" style={{ background: coverStyle }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {/* Company Logo Placeholder */}
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold"
              style={{ backgroundColor: `${brandColor}cc` }}
            >
              {(senderName || brandInitial).charAt(0).toUpperCase()}
            </div>
            <h2 className="text-xl font-bold text-white drop-shadow-sm">
              {senderName || "Company"}
            </h2>
          </div>
          <div className="text-right text-white/90">
            <p className="text-sm font-medium">#{invoice.invoiceNumber}</p>
            <p className="text-xs opacity-80">{formattedDate}</p>
          </div>
        </div>
      </div>

      {/* Amount + Due Date */}
      <div className="px-8 py-6 border-b border-[#e2e8f0] dark:border-white/10">
        <p className="text-4xl font-bold text-[#1e293b] dark:text-white mb-2">
          {formatCurrency(invoice.total)}
        </p>
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
          Due {formattedDueDate}
        </div>
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
                <tr key={item.id || idx} className="border-t border-[#f1f5f9] dark:border-white/5">
                  <td className="py-3.5 pr-4 text-sm text-[#1e293b] dark:text-white">
                    {item.description || `Item ${idx + 1}`}
                  </td>
                  <td className="py-3.5 pr-4 text-sm text-center text-[#64748b] dark:text-white/50">
                    {item.quantity}
                  </td>
                  <td className="py-3.5 pr-4 text-sm text-right text-[#64748b] dark:text-white/50">
                    {formatCurrency(item.unitPrice)}
                  </td>
                  <td className="py-3.5 text-sm text-right font-semibold text-[#1e293b] dark:text-white">
                    {formatCurrency(item.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {Number.parseFloat(invoice.discountAmount) > 0 && (
                <tr className="border-t border-[#e2e8f0] dark:border-white/10">
                  <td
                    colSpan={3}
                    className="py-3 text-right text-sm text-[#64748b] dark:text-white/50"
                  >
                    Discount
                  </td>
                  <td className="py-3 text-right text-sm font-medium text-[#ef4444]">
                    -{formatCurrency(invoice.discountAmount)}
                  </td>
                </tr>
              )}
              <tr className="border-t-2 border-[#e2e8f0] dark:border-white/10">
                <td colSpan={3} className="py-4 text-right text-sm font-semibold text-[#10b981]">
                  Total
                </td>
                <td className="py-4 text-right text-lg font-bold text-[#10b981]">
                  {formatCurrency(invoice.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Memo */}
      {memo && (
        <div className="px-8 py-5 border-b border-[#e2e8f0] dark:border-white/10 bg-[#fefce8] dark:bg-yellow-900/10">
          <p className="text-xs font-semibold text-[#92400e] dark:text-yellow-300/80 mb-1">Memo</p>
          <p className="text-sm text-[#78350f] dark:text-yellow-200/70 whitespace-pre-wrap leading-relaxed">
            {memo}
          </p>
        </div>
      )}

      {/* From / To Addresses */}
      <div className="px-8 py-6 grid grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
            From
          </h4>
          <p className="text-sm font-medium text-[#1e293b] dark:text-white">
            {senderName || "Company"}
          </p>
          <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">{senderEmail || ""}</p>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
            To
          </h4>
          <p className="text-sm font-medium text-[#1e293b] dark:text-white">
            {invoice.customerName ?? "Customer"}
          </p>
          <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">
            {invoice.customerEmail ?? ""}
          </p>
        </div>
      </div>

      {/* Review & Pay CTA */}
      <div className="px-8 pb-8 pt-2">
        <div className="text-center p-5 bg-[#f8fafc] dark:bg-[#0f172a] rounded-xl">
          <span className="inline-flex items-center gap-2 px-8 py-3 rounded-xl bg-gradient-to-r from-[#10b981] to-[#059669] text-white font-semibold text-sm shadow-lg cursor-default">
            Review & Pay
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function ReviewSkeleton() {
  return (
    <div className="min-h-screen bg-[#e8edf4] dark:bg-[#0c1322]">
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#111827]/80 backdrop-blur-md border-b border-[#e2e8f0] dark:border-white/10">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-6 h-14 flex items-center justify-between">
          <div className="h-4 w-24 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse" />
          <div className="flex gap-2">
            <div className="h-9 w-20 bg-[#e2e8f0] dark:bg-white/10 rounded-lg animate-pulse" />
            <div className="h-9 w-24 bg-[#e2e8f0] dark:bg-white/10 rounded-lg animate-pulse" />
          </div>
        </div>
      </header>
      <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-6">
        <div className="flex-1 h-[700px] bg-white dark:bg-[#111827] rounded-2xl animate-pulse" />
        <div className="w-80 space-y-5">
          <div className="h-40 bg-white dark:bg-[#111827] rounded-xl animate-pulse" />
          <div className="h-48 bg-white dark:bg-[#111827] rounded-xl animate-pulse" />
          <div className="h-52 bg-white dark:bg-[#111827] rounded-xl animate-pulse" />
        </div>
      </div>
    </div>
  );
}
