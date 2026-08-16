/**
 * Bill Detail Page — /bills/$billId
 * split layout: document preview + metadata sidebar
 * Header bar with primary action + kebab menu
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { useOrganizationCurrency } from "@/hooks/useActiveOrganization";
import { formatCurrency as formatMoney } from "@/lib/format-currency";
import {
  getBill,
  updateBill,
  transitionBillStatus,
  deleteBill,
  rescanBoundingBoxes,
} from "./api/-bills";
import type { BillDetail } from "./api/-bills";
import { listAccounts } from "./api/-accounts";
import type { BoundingBox } from "../components/bills/InteractiveDocumentViewer";
import { VendorProfilePanel } from "../components/bills/VendorProfilePanel";
import { EditLineItemsPanel } from "../components/bills/EditLineItemsPanel";
import { listOrgMembers, createInvitation } from "./api/-org-settings";
import { ICON_PATHS } from "../components/accounts/icons";
import { ConfirmModal } from "../components/shared/ConfirmModal";
import { Modal } from "../components/ui/Modal";
import { CommentThread } from "../components/comments/CommentThread";
import { BillUploadProgress } from "../components/bills/BillUploadProgress";
import { startDocumentReplacement } from "../lib/bill-upload-store";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";
import { createLogger } from "../lib/logger";
import {
  clearStableIdempotencyKey,
  type StableIdempotencyIntent,
  withStableIdempotencyKey,
} from "../lib/client-idempotency";
const logger = createLogger("ui.bills");

const InteractiveDocumentViewer = lazy(
  () => import("../components/bills/InteractiveDocumentViewer"),
);

// ============================================================================
// Route Definition
// ============================================================================

export const Route = createFileRoute("/bills_/$billId")({
  component: BillDetailRoute,
});

function BillDetailRoute() {
  return (
    <AppErrorBoundary contextLabel="Bill">
      <BillDetailPage />
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

const STATUS_LABELS: Record<string, string> = {
  in_review: "In Review",
  pending_approval: "Pending Approval",
  approved: "Approved",
  awaiting_payment: "Awaiting Payment",
  scheduled: "Scheduled",
  paid: "Paid",
  voided: "Voided",
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  in_review: { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  pending_approval: { bg: "rgba(245,158,11,0.12)", text: "#f59e0b" },
  approved: { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  awaiting_payment: { bg: "rgba(59,130,246,0.12)", text: "#3b82f6" },
  scheduled: { bg: "rgba(14,165,233,0.12)", text: "#0ea5e9" },
  paid: { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  voided: { bg: "rgba(239,68,68,0.12)", text: "#ef4444" },
};

/** Whether the bill is in an editable status */
function isEditable(status: string): boolean {
  return status === "in_review" || status === "pending_approval";
}

/**
 * Returns the ICON_PATHS key for the *next* status so the icon-only button
 * on mobile visually hints at what the action does, matching the kanban
 * column icons on /bills.
 *
 *   in_review  → PendingApproval (amber person)   target: pending_approval
 *   in_review  (self-approve) → Clock (blue)       target: awaiting_payment
 *   pending_approval → Clock (blue)                target: awaiting_payment
 *   awaiting_payment → Scheduled (green check)     target: paid
 */
function getActionIconPath(targetStatus: string): string {
  switch (targetStatus) {
    case "pending_approval":
      return ICON_PATHS.PendingApproval ?? "";
    case "awaiting_payment":
      return ICON_PATHS.Clock ?? "";
    case "paid":
      return ICON_PATHS.Scheduled ?? "";
    default:
      return "";
  }
}

/**
 * Context-aware primary action based on bill status, approver, and current user.
 *
 * Rules:
 * - in_review + no approver         → "Send for Approval" (disabled)
 * - in_review + approver = me        → "Approve" → awaiting_payment
 * - in_review + approver = other     → "Send for Approval" → pending_approval
 * - pending_approval + I'm approver  → "Approve" → awaiting_payment
 * - pending_approval + not approver  → null (waiting on them)
 * - awaiting_payment                 → "Mark as Paid" → paid
 */
function getPrimaryAction(
  status: string,
  approverId: string | null,
  currentUserId: string | null,
): { label: string; status: string; color: string; disabled?: boolean } | null {
  switch (status) {
    case "in_review": {
      if (!approverId) {
        // No approver yet — show button disabled
        return {
          label: "Send for Approval",
          status: "pending_approval",
          color: "from-[#f59e0b] to-[#d97706]",
          disabled: true,
        };
      }
      if (approverId === currentUserId) {
        // I'm the approver — approve inline (skip sending)
        return {
          label: "Approve",
          status: "awaiting_payment",
          color: "from-[#10b981] to-[#059669]",
        };
      }
      // Someone else is the approver — send to them
      return {
        label: "Send for Approval",
        status: "pending_approval",
        color: "from-[#f59e0b] to-[#d97706]",
      };
    }
    case "pending_approval": {
      if (approverId === currentUserId) {
        return {
          label: "Approve",
          status: "awaiting_payment",
          color: "from-[#10b981] to-[#059669]",
        };
      }
      // Waiting on the other person — no primary action for me
      return null;
    }
    case "approved":
    case "awaiting_payment":
      return {
        label: "Mark as Paid",
        status: "paid",
        color: "from-[#10b981] to-[#059669]",
      };
    default:
      return null;
  }
}

// ============================================================================
// Page Component
// ============================================================================

function BillDetailPage() {
  const { billId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const { currency } = useOrganizationCurrency();
  const currentUserId = session?.user?.id ?? null;
  const [activeTab, setActiveTab] = useState<"document" | "comments">("document");
  const [kebabOpen, setKebabOpen] = useState(false);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [isRescanning, setIsRescanning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  const transitionIntentRef = useRef<StableIdempotencyIntent | null>(null);

  // Right panel state machine
  type PanelMode = "details" | "vendor-profile" | "line-items";
  const [panelMode, setPanelMode] = useState<PanelMode>("details");

  // Approver combobox
  const [approverSearch, setApproverSearch] = useState("");
  const [approverOpen, setApproverOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const approverRef = useRef<HTMLDivElement>(null);
  // Optimistic approver state — enables buttons instantly
  // Synced from bill.approverId on load so it persists across transitions
  const [localApproverId, setLocalApproverId] = useState<string | null>(null);

  // Responsive sidebar — floating at <=1000px
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  // Bank account picker for "Mark as Paid"
  const [showBankPicker, setShowBankPicker] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1000px)");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setIsNarrow(e.matches);
    handler(mql);
    mql.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
    return () => mql.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
  }, []);

  // Invite mutation for loading state
  const inviteMutation = useMutation({
    mutationFn: async (email: string) => {
      await (createInvitation as (opts: { data: unknown }) => Promise<unknown>)({
        data: { email, role: "member" },
      });
    },
  });

  // Fetch org members for approver dropdown
  type OrgMember = {
    id: string;
    userId: string;
    user?: { name?: string; email?: string; image?: string };
  };
  const { data: orgMembers = [] } = useQuery({
    queryKey: ["org-members"],
    queryFn: () => (listOrgMembers as () => Promise<OrgMember[]>)(),
  });

  const { data: bill, isLoading } = useQuery({
    queryKey: ["bill", billId],
    queryFn: () =>
      (getBill as (opts: { data: unknown }) => Promise<BillDetail>)({
        data: { id: billId },
      }),
  });

  // Fetch bank + cash-on-hand accounts for the "Mark as Paid" picker
  type PaymentAccount = { id: string; name: string; accountNumber?: string; isActive?: boolean };
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ["accounts-payment"],
    queryFn: async () => {
      const all = await (listAccounts as (opts: { data: unknown }) => Promise<PaymentAccount[]>)({
        data: { subtypes: ["bank_accounts", "other_current_assets"] },
      });
      return all.filter((a) => a.isActive !== false);
    },
    enabled: showBankPicker,
  });

  const transitionMutation = useMutation({
    mutationFn: (data: {
      billId: string;
      newStatus: string;
      idempotencyKey?: string;
      bankAccountId?: string;
      paymentAmount?: string;
    }) =>
      (transitionBillStatus as (opts: { data: unknown }) => Promise<unknown>)({
        data,
      }),
    onSuccess: (_result, variables) => {
      clearStableIdempotencyKey(transitionIntentRef, variables.idempotencyKey);
      queryClient.invalidateQueries({ queryKey: ["bill", billId] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      (updateBill as (opts: { data: unknown }) => Promise<unknown>)({
        data: { id: billId, ...data },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bill", billId] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      (deleteBill as (opts: { data: unknown }) => Promise<unknown>)({
        data: { id: billId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      navigate({ to: "/bills" });
    },
  });

  // Document replacement via global store (for background progress)
  const onReplaceDocument = (file: File) => {
    startDocumentReplacement(billId, file, queryClient);
  };

  // Close kebab on outside click
  useEffect(() => {
    if (!kebabOpen) return;
    const handler = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        setKebabOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [kebabOpen]);

  // Sync localApproverId AND approverSearch text from server data on load / after transitions
  useEffect(() => {
    if (bill?.approverId) {
      setLocalApproverId(bill.approverId);
      // Resolve the approver name from org members list for the search input
      if (orgMembers.length > 0) {
        const match = orgMembers.find((m) => m.userId === bill.approverId);
        if (match) {
          setApproverSearch(match.user?.name || match.user?.email || "");
        }
      }
    }
  }, [bill?.approverId, orgMembers]);

  if (isLoading || !bill) {
    return <BillDetailSkeleton />;
  }

  const isOverdue =
    bill.status !== "paid" && bill.status !== "voided" && getDaysOverdue(bill.dueDate) > 0;
  const daysOverdue = getDaysOverdue(bill.dueDate);
  const statusColor = STATUS_COLORS[bill.status] ?? STATUS_COLORS.in_review;
  const effectiveApproverId = localApproverId || bill.approverId || null;
  const primaryAction = getPrimaryAction(bill.status, effectiveApproverId, currentUserId);
  const canEdit = isEditable(bill.status);
  const vendorIncomplete = !bill.vendorBankRouting && !bill.vendorBankAccount && canEdit;

  return (
    <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
      {/* ============= Header Bar ============= */}
      <div className="flex items-center justify-between px-4 sm:px-8 py-3 border-b border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827]">
        {panelMode === "line-items" ? (
          /* Line Items editing mode — Cancel / Save in header */
          <>
            <button
              type="button"
              onClick={() => setPanelMode("details")}
              className="text-sm text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white font-medium transition-colors"
            >
              Cancel
            </button>
            <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
              Edit Line Items
            </span>
            <button
              type="button"
              onClick={() => {
                /* save is handled by the panel itself */
              }}
              className="text-sm text-[#10b981] hover:text-[#059669] font-medium transition-colors"
            >
              Save
            </button>
          </>
        ) : (
          <>
            <Link
              to={"/bills" as string & {}}
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
              Back to Bills
            </Link>

            <div className="flex items-center gap-2">
              {/* Status badge — hidden on mobile to prevent layout overflow */}
              <span
                className="hidden md:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
                style={{ backgroundColor: statusColor.bg, color: statusColor.text }}
              >
                {STATUS_LABELS[bill.status] ?? bill.status}
              </span>

              {/* Context-aware primary action button — icon-only on mobile */}
              {primaryAction && (
                <button
                  type="button"
                  disabled={transitionMutation.isPending || primaryAction.disabled === true}
                  onClick={() => {
                    if (primaryAction.status === "paid") {
                      setShowBankPicker(true);
                    } else {
                      const transitionData = {
                        billId: bill.id,
                        newStatus: primaryAction.status,
                      };
                      transitionMutation.mutate(
                        primaryAction.status === "awaiting_payment"
                          ? withStableIdempotencyKey(transitionIntentRef, transitionData)
                          : transitionData,
                      );
                    }
                  }}
                  className={`touch-target flex items-center justify-center gap-2 w-9 h-9 sm:w-auto sm:h-auto sm:px-4 sm:py-2 rounded-lg bg-gradient-to-r ${primaryAction.color} text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed`}
                  title={primaryAction.disabled ? "Assign an approver first" : primaryAction.label}
                >
                  {/* Next-status icon — always visible, provides context on mobile */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="shrink-0"
                    dangerouslySetInnerHTML={{ __html: getActionIconPath(primaryAction.status) }}
                  />
                  <span className="hidden sm:inline">
                    {transitionMutation.isPending ? "Processing…" : primaryAction.label}
                  </span>
                </button>
              )}

              {/* Kebab menu */}
              <div className="relative" ref={kebabRef}>
                <button
                  type="button"
                  onClick={() => setKebabOpen(!kebabOpen)}
                  className="touch-target w-8 h-8 flex items-center justify-center rounded-lg text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="12" cy="19" r="2" />
                  </svg>
                </button>

                {kebabOpen && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-lg overflow-hidden z-20">
                    {/* Mark as Paid — always available for owner */}
                    {bill.status !== "paid" && bill.status !== "voided" && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowBankPicker(true);
                          setKebabOpen(false);
                        }}
                        className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 text-[#64748b] dark:text-white/60 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                        title="Mark this bill as paid"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Mark as Paid
                      </button>
                    )}
                    {/* Download */}
                    {bill.documentUrl && (
                      <a
                        href={bill.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setKebabOpen(false)}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#64748b] dark:text-white/60 hover:bg-[#f8fafc] dark:hover:bg-white/5 flex items-center gap-2 no-underline"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Download
                      </a>
                    )}
                    {/* Delete */}
                    <button
                      type="button"
                      onClick={() => {
                        setKebabOpen(false);
                        setShowDeleteConfirm(true);
                      }}
                      className="w-full text-left px-4 py-2.5 text-sm text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 flex items-center gap-2"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ============= Payment Modal (Bank Account + Amount) ============= */}
      <Modal
        open={showBankPicker}
        onClose={() => setShowBankPicker(false)}
        title="Record Payment"
        mobile="sheet"
        size="sm"
        bodyClassName="px-0 py-0"
        footer={
          <button
            type="button"
            onClick={() => setShowBankPicker(false)}
            className="min-h-11 px-3 text-sm text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white font-medium transition-colors"
          >
            Cancel
          </button>
        }
      >
        <div className="px-5 pb-3">
          <p className="text-xs text-[#64748b] dark:text-white/50">
            Balance due:{" "}
            <span className="font-semibold text-[#1e293b] dark:text-white">
              {new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
              }).format(Number.parseFloat(bill?.balanceDue ?? bill?.amount ?? "0"))}
            </span>
          </p>
        </div>

        {/* Payment amount input */}
        <div className="px-5 py-3 border-y border-[#e2e8f0] dark:border-white/10">
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Payment Amount (leave blank for full balance)
          </label>
          <input
            id="bill-payment-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            max={bill?.balanceDue ?? bill?.amount ?? undefined}
            placeholder={bill?.balanceDue ?? bill?.amount ?? "0.00"}
            className="w-full min-h-11 px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/30 focus:border-[#3b82f6]"
            onChange={(e) => {
              // Store on the element for retrieval on click
              (e.target as HTMLInputElement).dataset.value = e.target.value;
            }}
          />
        </div>

        {/* Bank account list */}
        <div className="px-5 py-2">
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
            Select Payment Account
          </label>
        </div>
        <div className="max-h-[240px] overflow-y-auto">
          {bankAccounts.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-[#94a3b8]">
              Loading payment accounts…
            </div>
          ) : (
            bankAccounts.map((acct) => (
              <button
                key={acct.id}
                type="button"
                disabled={transitionMutation.isPending}
                onClick={() => {
                  const amountInput = document.getElementById(
                    "bill-payment-amount",
                  ) as HTMLInputElement | null;
                  const rawValue = amountInput?.value;
                  const mutationData: {
                    billId: string;
                    newStatus: string;
                    bankAccountId: string;
                    paymentAmount?: string;
                  } = {
                    billId: bill.id,
                    newStatus: "paid",
                    bankAccountId: acct.id,
                  };
                  if (rawValue && rawValue.trim() !== "") {
                    mutationData.paymentAmount = rawValue.trim();
                  }
                  transitionMutation.mutate(
                    withStableIdempotencyKey(transitionIntentRef, mutationData),
                  );
                  setShowBankPicker(false);
                }}
                className="w-full min-h-11 text-left px-5 py-3 flex items-center gap-3 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors disabled:opacity-40"
              >
                <div className="w-8 h-8 rounded-lg bg-[#dbeafe] dark:bg-blue-900/30 flex items-center justify-center text-[#3b82f6] shrink-0">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                    <line x1="1" y1="10" x2="23" y2="10" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                    {acct.name}
                  </div>
                  {acct.accountNumber && (
                    <div className="text-xs text-[#94a3b8] dark:text-white/40">
                      •••• {acct.accountNumber.slice(-4)}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </Modal>

      {/* ============= Split Layout ============= */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left — Document Preview / Structured Card */}
        <div className="flex-1 overflow-y-auto p-8">
          {/* Overdue / Duplicate banner — above document viewer */}
          {isOverdue && (
            <div className="max-w-3xl mx-auto flex items-center gap-2 px-4 py-2.5 mb-4 rounded-lg bg-[#fff7ed] dark:bg-orange-900/20 border border-[#fed7aa] dark:border-orange-800/40">
              <span className="text-base">⚠️</span>
              <span className="text-sm font-medium text-[#c2410c] dark:text-orange-300">
                Overdue — {daysOverdue} day{daysOverdue > 1 ? "s" : ""} past due date
              </span>
            </div>
          )}
          {bill.documentUrl &&
          bill.ocrBoundingBoxes &&
          (bill.ocrBoundingBoxes as BoundingBox[]).length > 0 ? (
            <Suspense
              fallback={
                <div className="max-w-3xl mx-auto rounded-2xl border border-[#e2e8f0] bg-white px-4 py-6 text-sm text-[#64748b] dark:border-white/10 dark:bg-[#111827] dark:text-white/60">
                  Loading document viewer…
                </div>
              }
            >
              <InteractiveDocumentViewer
                imageUrl={bill.previewImageUrl ?? bill.documentUrl}
                documentUrl={bill.documentUrl}
                boundingBoxes={bill.ocrBoundingBoxes as BoundingBox[]}
                activeFieldId={activeFieldId}
                isRescanning={isRescanning}
                onRescan={async () => {
                  setIsRescanning(true);
                  try {
                    await (rescanBoundingBoxes as (opts: { data: unknown }) => Promise<any>)({
                      data: { billId: bill.id },
                    });
                    await queryClient.invalidateQueries({ queryKey: ["bill", billId] });
                  } finally {
                    setIsRescanning(false);
                  }
                }}
                onReplaceDocument={onReplaceDocument}
                isPreviewPending={bill.documentType === "pdf" && !bill.previewImageUrl}
              />
            </Suspense>
          ) : bill.documentUrl ? (
            <>
              {/* Re-scan toolbar for fallback viewer */}
              <div className="flex items-center justify-end gap-2 mb-2">
                <button
                  type="button"
                  disabled={isRescanning}
                  onClick={async () => {
                    setIsRescanning(true);
                    try {
                      await (rescanBoundingBoxes as (opts: { data: unknown }) => Promise<any>)({
                        data: { billId: bill.id },
                      });
                      await queryClient.invalidateQueries({ queryKey: ["bill", billId] });
                    } catch (e) {
                      logger.error("Re-scan failed", { error: e });
                    } finally {
                      setIsRescanning(false);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/10 disabled:opacity-40"
                  style={{ color: "#10b981" }}
                  title="Scan document for field detection"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={isRescanning ? "animate-spin" : ""}
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  {isRescanning ? "Scanning…" : "Scan Fields"}
                </button>
              </div>
              <DocumentViewer
                url={bill.documentUrl}
                type={bill.documentType ?? "application/pdf"}
                onReplaceDocument={onReplaceDocument}
              />
            </>
          ) : (
            <StructuredBillCard bill={bill} isOverdue={isOverdue} currency={currency} />
          )}
          <BillUploadProgress />
        </div>

        {/* Sidebar toggle — visible only at narrow widths */}
        {isNarrow && (
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-gradient-to-br from-[#10b981] to-[#059669] text-white shadow-lg hover:shadow-xl flex items-center justify-center transition-all"
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {sidebarOpen ? (
                <path d="M18 6L6 18M6 6l12 12" />
              ) : (
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M15 3v18" />
                </>
              )}
            </svg>
          </button>
        )}

        {/* Floating sidebar backdrop */}
        {isNarrow && sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/30 z-30 transition-opacity"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Right — Metadata Sidebar */}
        <div
          className={`${
            isNarrow
              ? `fixed top-0 right-0 bottom-0 z-30 w-[380px] max-w-[90vw] transform transition-transform duration-300 ease-in-out ${
                  sidebarOpen ? "translate-x-0" : "translate-x-full"
                }`
              : "w-[380px]"
          } border-l border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] flex flex-col overflow-hidden`}
        >
          {/* Panel mode: vendor-profile or line-items replaces the sidebar */}
          {panelMode === "vendor-profile" ? (
            <VendorProfilePanel
              vendorId={bill.vendorId ?? ""}
              vendorName={bill.vendorName}
              vendorEmail={bill.vendorEmail}
              vendorBankRouting={bill.vendorBankRouting}
              vendorBankAccount={bill.vendorBankAccount}
              vendorMailingAddress={bill.vendorMailingAddress ?? null}
              billId={bill.id}
              onClose={() => setPanelMode("details")}
            />
          ) : panelMode === "line-items" ? (
            <EditLineItemsPanel
              billId={bill.id}
              billAmount={bill.amount}
              lineItems={bill.lineItems}
              onClose={() => setPanelMode("details")}
              onSave={() => setPanelMode("details")}
            />
          ) : (
            <>
              {/* Rounded icon-only tabs */}
              <div className="flex items-center justify-center gap-1 p-3">
                <button
                  type="button"
                  onClick={() => setActiveTab("document")}
                  className={`touch-target w-9 h-9 flex items-center justify-center rounded-full transition-all ${
                    activeTab === "document"
                      ? "bg-[#10b981] text-white shadow-sm"
                      : "text-[#94a3b8] dark:text-white/40 hover:bg-[#f1f5f9] dark:hover:bg-white/5"
                  }`}
                  title="Bill Details"
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
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("comments")}
                  className={`touch-target w-9 h-9 flex items-center justify-center rounded-full transition-all ${
                    activeTab === "comments"
                      ? "bg-[#10b981] text-white shadow-sm"
                      : "text-[#94a3b8] dark:text-white/40 hover:bg-[#f1f5f9] dark:hover:bg-white/5"
                  }`}
                  title="Comments"
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
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              </div>

              {/* Tab content with slide animation */}
              <div className="flex-1 overflow-y-auto relative">
                <div
                  className="transition-transform duration-300 ease-in-out"
                  style={{
                    transform: activeTab === "comments" ? "translateX(-100%)" : "translateX(0)",
                  }}
                >
                  {/* Document/Bill Details tab */}
                  <div className="p-5 flex flex-col gap-5" style={{ width: "100%" }}>
                    {/* New Vendor Detected */}
                    {vendorIncomplete && (
                      <div className="p-3.5 rounded-lg bg-[#ecfdf5] dark:bg-emerald-900/20 border border-[#a7f3d0] dark:border-emerald-800/40">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-2 h-2 rounded-full bg-[#10b981]" />
                          <span className="text-sm font-semibold text-[#065f46] dark:text-emerald-300">
                            New Vendor Detected
                          </span>
                        </div>
                        <p className="text-xs text-[#047857] dark:text-emerald-400/80 mb-2.5">
                          Complete this vendor's profile to enable payments.
                        </p>
                        <button
                          type="button"
                          onClick={() => setPanelMode("vendor-profile")}
                          className="text-xs font-medium text-[#10b981] hover:text-[#059669] transition-colors"
                        >
                          Complete Vendor Profile →
                        </button>
                      </div>
                    )}

                    {/* Bill Info — 2 column grid */}
                    <SidebarSection label="Bill Info">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                        <EditableRow
                          label="Amount"
                          value={bill.amount}
                          displayValue={formatMoney(bill.amount, currency)}
                          disabled={!canEdit}
                          type="number"
                          onSave={(val) => updateMutation.mutate({ amount: val })}
                          onFocus={() => setActiveFieldId("total_amount")}
                          onBlur={() => setActiveFieldId(null)}
                        />
                        <EditableRow
                          label="Invoice No."
                          value={bill.billNumber ?? ""}
                          displayValue={bill.billNumber || "\u2014"}
                          disabled={!canEdit}
                          onSave={(val) => updateMutation.mutate({ billNumber: val })}
                          onFocus={() => setActiveFieldId("invoice_number")}
                          onBlur={() => setActiveFieldId(null)}
                        />
                        <EditableRow
                          label="Invoice Date"
                          value={bill.billDate}
                          displayValue={formatDate(bill.billDate)}
                          disabled={!canEdit}
                          type="date"
                          onSave={(val) => updateMutation.mutate({ billDate: val })}
                          onFocus={() => setActiveFieldId("invoice_date")}
                          onBlur={() => setActiveFieldId(null)}
                        />
                        <EditableRow
                          label="Due Date"
                          value={bill.dueDate}
                          displayValue={formatDate(bill.dueDate)}
                          disabled={!canEdit}
                          type="date"
                          onSave={(val) => updateMutation.mutate({ dueDate: val })}
                          onFocus={() => setActiveFieldId("due_date")}
                          onBlur={() => setActiveFieldId(null)}
                        />
                      </div>
                      {bill.scheduledPaymentDate && (
                        <InfoRow label="Scheduled" value={formatDate(bill.scheduledPaymentDate)} />
                      )}
                      {bill.paidAt && (
                        <InfoRow
                          label="Paid At"
                          value={new Date(bill.paidAt).toLocaleDateString()}
                        />
                      )}
                    </SidebarSection>

                    {/* Bookkeeping */}
                    <SidebarSection label="Bookkeeping">
                      <div className="flex flex-col gap-2.5">
                        <div
                          onFocus={() => setActiveFieldId("memo")}
                          onBlur={() => setActiveFieldId(null)}
                        >
                          <div className="text-xs text-[#94a3b8] dark:text-white/40 mb-1">Memo</div>
                          <EditableField
                            value={bill.memo ?? ""}
                            placeholder="Add memo…"
                            disabled={!canEdit}
                            onSave={(memo) => updateMutation.mutate({ memo })}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setPanelMode("line-items")}
                          className="flex items-center justify-between w-full py-2 px-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 hover:border-[#10b981] transition-colors group"
                        >
                          <span className="text-xs font-medium text-[#64748b] dark:text-white/50 group-hover:text-[#10b981] transition-colors">
                            Split Line Items
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-[#10b981] font-medium">
                            {bill.lineItems.length} item{bill.lineItems.length !== 1 ? "s" : ""}
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                          </span>
                        </button>
                      </div>
                    </SidebarSection>

                    {/* Approver */}
                    <SidebarSection label="Approver">
                      <div className="relative" ref={approverRef}>
                        <div className="relative">
                          <input
                            type="text"
                            value={approverSearch}
                            disabled={inviteMutation.isPending}
                            onChange={(e) => {
                              setApproverSearch(e.target.value);
                              setApproverOpen(true);
                              setHighlightedIdx(0);
                            }}
                            onFocus={() => setApproverOpen(true)}
                            onKeyDown={async (e) => {
                              const filtered = orgMembers.filter((m) => {
                                if (!approverSearch) return true;
                                const q = approverSearch.toLowerCase();
                                return (
                                  m.user?.name?.toLowerCase().includes(q) ||
                                  m.user?.email?.toLowerCase().includes(q)
                                );
                              });
                              const hasInvite = approverSearch.includes("@");
                              const totalItems = filtered.length + (hasInvite ? 1 : 0);

                              if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setApproverOpen(true);
                                setHighlightedIdx((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
                              } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setApproverOpen(true);
                                setHighlightedIdx((prev) => (prev > 0 ? prev - 1 : totalItems - 1));
                              } else if (e.key === "Enter") {
                                e.preventDefault();
                                if (!approverOpen) {
                                  setApproverOpen(true);
                                  return;
                                }
                                // CMD/CTRL+Enter or plain Enter on invite row
                                if (
                                  hasInvite &&
                                  (e.metaKey || e.ctrlKey || highlightedIdx === filtered.length)
                                ) {
                                  inviteMutation.mutate(approverSearch, {
                                    onSuccess: () => {
                                      setLocalApproverId(approverSearch);
                                      updateMutation.mutate({ approverId: approverSearch });
                                      setApproverOpen(false);
                                    },
                                  });
                                } else if (highlightedIdx < filtered.length) {
                                  const m = filtered[highlightedIdx];
                                  setLocalApproverId(m.userId);
                                  updateMutation.mutate({ approverId: m.userId });
                                  setApproverSearch(m.user?.name || m.user?.email || "");
                                  setApproverOpen(false);
                                }
                              } else if (e.key === "Escape") {
                                setApproverOpen(false);
                              }
                            }}
                            placeholder={
                              inviteMutation.isPending
                                ? "Inviting…"
                                : bill.approverId || localApproverId
                                  ? "Change approver…"
                                  : "Search members or enter email…"
                            }
                            className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all disabled:opacity-60"
                          />
                          {/* Loading spinner overlay */}
                          {inviteMutation.isPending && (
                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#10b981"
                                strokeWidth="2"
                                className="animate-spin"
                              >
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                              </svg>
                            </div>
                          )}
                        </div>
                        {/* Current approver display */}
                        {(bill.approverId || localApproverId) && !approverOpen && (
                          <div className="mt-2 flex items-center gap-2 text-xs text-[#64748b] dark:text-white/50">
                            <div className="w-5 h-5 rounded-full bg-[#10b981] flex items-center justify-center text-white text-[10px] font-bold">
                              {(bill.approverId || localApproverId || "?").charAt(0).toUpperCase()}
                            </div>
                            <span className="truncate">
                              {(() => {
                                const id = bill.approverId || localApproverId;
                                const found = orgMembers.find((m) => m.userId === id);
                                return found ? found.user?.name || found.user?.email : id;
                              })()}
                            </span>
                          </div>
                        )}
                        {/* Dropdown — shows 5 items before scrolling */}
                        {approverOpen &&
                          (() => {
                            const filtered = orgMembers.filter((m) => {
                              if (!approverSearch) return true;
                              const q = approverSearch.toLowerCase();
                              return (
                                m.user?.name?.toLowerCase().includes(q) ||
                                m.user?.email?.toLowerCase().includes(q)
                              );
                            });
                            const hasInvite = approverSearch.includes("@");
                            return (
                              <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-lg z-20 max-h-[200px] overflow-y-auto">
                                {filtered.length === 0 && !hasInvite && (
                                  <div className="px-3 py-3 text-xs text-[#94a3b8] dark:text-white/40 text-center">
                                    No members found
                                  </div>
                                )}
                                {filtered.map((m, idx: number) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => {
                                      setLocalApproverId(m.userId);
                                      updateMutation.mutate({ approverId: m.userId });
                                      setApproverSearch(m.user?.name || m.user?.email || "");
                                      setApproverOpen(false);
                                    }}
                                    className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                                      idx === highlightedIdx
                                        ? "bg-[#f1f5f9] dark:bg-white/10"
                                        : "hover:bg-[#f8fafc] dark:hover:bg-white/5"
                                    }`}
                                  >
                                    <div className="w-6 h-6 rounded-full bg-[#10b981]/20 flex items-center justify-center text-[10px] text-[#10b981] font-bold shrink-0">
                                      {(m.user?.name || m.user?.email || "?")
                                        .charAt(0)
                                        .toUpperCase()}
                                    </div>
                                    <div className="min-w-0">
                                      <div className="text-xs font-medium text-[#1e293b] dark:text-white truncate">
                                        {m.user?.name || "—"}
                                      </div>
                                      <div className="text-[10px] text-[#94a3b8] dark:text-white/40 truncate">
                                        {m.user?.email}
                                      </div>
                                    </div>
                                  </button>
                                ))}
                                {/* Invite option — when typed value looks like an email */}
                                {hasInvite && (
                                  <button
                                    type="button"
                                    disabled={inviteMutation.isPending}
                                    onClick={() => {
                                      inviteMutation.mutate(approverSearch, {
                                        onSuccess: () => {
                                          setLocalApproverId(approverSearch);
                                          updateMutation.mutate({ approverId: approverSearch });
                                          setApproverOpen(false);
                                        },
                                      });
                                    }}
                                    className={`w-full text-left px-3 py-2 flex items-center gap-2 border-t border-[#e2e8f0] dark:border-white/10 transition-colors ${
                                      highlightedIdx === filtered.length
                                        ? "bg-[#ecfdf5] dark:bg-emerald-900/30"
                                        : "hover:bg-[#ecfdf5] dark:hover:bg-emerald-900/20"
                                    }`}
                                  >
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="#10b981"
                                      strokeWidth="2"
                                    >
                                      <line x1="12" y1="5" x2="12" y2="19" />
                                      <line x1="5" y1="12" x2="19" y2="12" />
                                    </svg>
                                    <span className="text-xs font-medium text-[#10b981]">
                                      {inviteMutation.isPending
                                        ? "Inviting…"
                                        : `Invite ${approverSearch}`}
                                    </span>
                                    <span className="ml-auto text-[10px] text-[#94a3b8] dark:text-white/30">
                                      ⌘↵
                                    </span>
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                      </div>
                    </SidebarSection>
                  </div>
                </div>

                {/* Comments tab — slides in from right */}
                {activeTab === "comments" && (
                  <div className="absolute inset-0 animate-slide-in-right">
                    <CommentThread entityType="bill" entityId={bill.id} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ============= Delete Confirmation Modal ============= */}
      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Bill"
          subtitle="This action cannot be undone"
          message={
            <>
              Are you sure you want to delete bill <strong>{bill.billNumber || "this bill"}</strong>
              {bill.vendorName ? ` from ${bill.vendorName}` : ""}? All associated line items and
              documents will be removed.
            </>
          }
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Document Viewer
// ============================================================================

function DocumentViewer({
  url,
  type,
  onReplaceDocument,
}: {
  url: string;
  type: string;
  onReplaceDocument?: (file: File) => void;
}) {
  const [zoom, setZoom] = useState(100);
  const [hasError, setHasError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImage = type.startsWith("image/") || url.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i) != null;
  const isPdf = type === "application/pdf" || url.match(/\.pdf$/i) != null;

  // Reset error when url changes
  useEffect(() => {
    setHasError(false);
  }, [url]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onReplaceDocument) {
      onReplaceDocument(file);
    }
    e.target.value = "";
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white dark:bg-[#111827] rounded-t-xl border border-b-0 border-[#e2e8f0] dark:border-white/10">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(25, z - 25))}
            className="touch-target w-7 h-7 flex items-center justify-center rounded text-sm font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            −
          </button>
          <span className="text-xs font-medium text-[#94a3b8] dark:text-white/40 min-w-[3rem] text-center">
            {zoom}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(300, z + 25))}
            className="touch-target w-7 h-7 flex items-center justify-center rounded text-sm font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom(100)}
            className="ml-1 text-[11px] text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] transition-colors"
          >
            Reset
          </button>
        </div>
        <div className="flex items-center gap-3">
          {onReplaceDocument && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs font-medium text-[#10b981] hover:text-[#059669] transition-colors"
            >
              Replace
            </button>
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#10b981] hover:text-[#059669] font-medium no-underline transition-colors"
          >
            Open original ↗
          </a>
        </div>
      </div>

      {/* Preview area */}
      <div className="bg-[#e2e8f0] dark:bg-[#1e293b] rounded-b-xl border border-t-0 border-[#e2e8f0] dark:border-white/10 overflow-auto relative">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={onFileChange}
        />

        {hasError ? (
          <div className="flex flex-col items-center justify-center p-12 text-center min-h-[400px]">
            <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center text-red-500 mb-4">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Failed to load document
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-4">
              The file may be missing or corrupted.
            </p>
            {onReplaceDocument && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 text-sm font-medium shadow-sm hover:bg-gray-50 dark:hover:bg-white/20 transition-colors"
              >
                Upload New File
              </button>
            )}
          </div>
        ) : isImage ? (
          <div
            className="flex items-center justify-center p-6 min-h-[400px]"
            style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
          >
            <img src={url} alt="Bill document" className="max-w-full rounded shadow-lg" />
          </div>
        ) : isPdf ? (
          <iframe
            src={url}
            title="Bill document"
            className="w-full border-0"
            style={{
              height: `${Math.max(600, 600 * (zoom / 100))}px`,
            }}
          />
        ) : (
          <div className="flex items-center justify-center p-12 min-h-[400px]">
            <div className="text-center">
              <div className="text-4xl mb-3">📄</div>
              <p className="text-sm text-[#64748b] dark:text-white/50 mb-2">
                Preview not available for this file type
              </p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#10b981] hover:text-[#059669] font-medium no-underline"
              >
                Download file ↗
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Structured Bill Card (fallback when no document)
// ============================================================================

function StructuredBillCard({
  bill,
  isOverdue,
  currency,
}: {
  bill: BillDetail;
  isOverdue: boolean;
  currency: string;
}) {
  return (
    <div className="max-w-7xl mx-auto bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-sm overflow-hidden">
      {/* Invoice header */}
      <div className="px-8 py-6 bg-gradient-to-r from-[#f8fafc] to-[#f1f5f9] dark:from-[#15192a] dark:to-[#1a1f35] border-b border-[#e2e8f0] dark:border-white/10">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold"
              style={{
                backgroundColor: getVendorColor(bill.vendorName),
              }}
            >
              {getVendorInitial(bill.vendorName)}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[#1e293b] dark:text-white">
                {bill.vendorName ?? "Unknown Vendor"}
              </h2>
              {bill.vendorEmail && (
                <p className="text-sm text-[#64748b] dark:text-white/50">{bill.vendorEmail}</p>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-[#1e293b] dark:text-white">
              {formatMoney(bill.amount, currency)}
            </div>
            {bill.billNumber && (
              <div className="text-sm text-[#94a3b8] dark:text-white/40 mt-1">
                Invoice #{bill.billNumber}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dates row */}
      <div className="flex items-center gap-8 px-8 py-4 border-b border-[#f1f5f9] dark:border-white/5">
        <div>
          <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-0.5">
            Invoice Date
          </div>
          <div className="text-sm text-[#1e293b] dark:text-white">{formatDate(bill.billDate)}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-0.5">
            Due Date
          </div>
          <div
            className={`text-sm ${isOverdue ? "text-[#ea580c] font-medium" : "text-[#1e293b] dark:text-white"}`}
          >
            {formatDate(bill.dueDate)}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-0.5">
            Balance Due
          </div>
          <div className="text-sm font-semibold text-[#1e293b] dark:text-white">
            {formatMoney(bill.balanceDue, currency)}
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div className="px-8 py-5">
        <div className="scroll-x scroll-x-shadow">
          <table className="w-full min-w-[34rem]">
            <thead>
              <tr className="text-left text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                <th className="pb-3 pr-4">Description</th>
                <th className="pb-3 pr-4">Category</th>
                <th className="pb-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {bill.lineItems.map((item, idx) => (
                <tr key={item.id} className="border-t border-[#f1f5f9] dark:border-white/5">
                  <td className="py-3 pr-4 text-sm text-[#1e293b] dark:text-white">
                    {item.description || `Line ${idx + 1}`}
                  </td>
                  <td className="py-3 pr-4">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-[#f1f5f9] dark:bg-white/8 text-[#64748b] dark:text-white/50">
                      {item.accountName}
                    </span>
                  </td>
                  <td className="py-3 text-sm text-right font-medium text-[#1e293b] dark:text-white">
                    {formatMoney(item.amount, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#e2e8f0] dark:border-white/10">
                <td
                  colSpan={2}
                  className="pt-3 text-sm font-semibold text-[#1e293b] dark:text-white"
                >
                  Total
                </td>
                <td className="pt-3 text-right text-base font-bold text-[#1e293b] dark:text-white">
                  {formatMoney(bill.amount, currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Memo */}
      {bill.memo && (
        <div className="px-8 py-4 border-t border-[#f1f5f9] dark:border-white/5 bg-[#f8fafc] dark:bg-[#0f172a]/50">
          <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1">
            Memo
          </div>
          <p className="text-sm text-[#475569] dark:text-white/60">{bill.memo}</p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sidebar Sub-components
// ============================================================================

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[#94a3b8] dark:text-white/40">{label}</span>
      <span className="text-sm text-[#1e293b] dark:text-white">{value}</span>
    </div>
  );
}

// ============================================================================
// Editable Field Component
// ============================================================================

function EditableField({
  value,
  placeholder,
  disabled,
  type = "text",
  onSave,
}: {
  value: string;
  placeholder?: string;
  disabled: boolean;
  type?: "text" | "number" | "date";
  onSave: (val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (type === "text") inputRef.current.select();
    }
  }, [editing, type]);

  const save = useCallback(() => {
    setEditing(false);
    if (draft !== value) {
      onSave(draft);
    }
  }, [draft, value, onSave]);

  if (disabled || !editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        className={`text-sm text-left w-full px-2 py-1 -mx-2 rounded transition-colors ${
          disabled
            ? "text-[#1e293b] dark:text-white cursor-default"
            : "text-[#1e293b] dark:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 cursor-text"
        }`}
      >
        {value || (
          <span className="text-[#94a3b8] dark:text-white/30 italic">{placeholder ?? "—"}</span>
        )}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full text-base sm:text-sm px-2 py-1 -mx-2 rounded border border-[#10b981] bg-white dark:bg-[#1e293b] text-[#1e293b] dark:text-white outline-none"
    />
  );
}

// ============================================================================
// Editable Row (label + editable value)
// ============================================================================

function EditableRow({
  label,
  value,
  displayValue,
  disabled,
  type = "text",
  onSave,
  onFocus,
  onBlur,
}: {
  label: string;
  value: string;
  displayValue: string;
  disabled: boolean;
  type?: "text" | "number" | "date";
  onSave: (val: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (type !== "date") inputRef.current.select();
    }
  }, [editing, type]);

  const save = useCallback(() => {
    setEditing(false);
    if (draft !== value) {
      onSave(draft);
    }
  }, [draft, value, onSave]);

  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[#94a3b8] dark:text-white/40">{label}</span>
      {editing ? (
        <input
          ref={inputRef}
          type={type}
          value={draft}
          step={type === "number" ? "0.01" : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            save();
            onBlur?.();
          }}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          className="max-w-[140px] text-base sm:text-sm text-right px-2 py-0.5 rounded border border-[#10b981] bg-white dark:bg-[#1e293b] text-[#1e293b] dark:text-white outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setEditing(true);
            onFocus?.();
          }}
          className={`text-sm text-right px-2 py-0.5 -mr-2 rounded transition-colors ${
            disabled
              ? "text-[#1e293b] dark:text-white cursor-default"
              : "text-[#1e293b] dark:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 cursor-text"
          }`}
        >
          {displayValue}
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Bookkeeping Section
// ============================================================================

// ============================================================================
// Loading Skeleton
// ============================================================================

function BillDetailSkeleton() {
  return (
    <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
      {/* Header skeleton — matches actual header bar */}
      <div className="flex items-center justify-between px-8 py-3 border-b border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827]">
        <div className="h-4 w-28 rounded bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
        <div className="flex items-center gap-2">
          <div className="h-6 w-20 rounded-full bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
          <div className="h-9 w-32 rounded-lg bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
        </div>
      </div>

      {/* Split layout — mirrors the actual flex-1 flex overflow-hidden structure */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left — Document Viewer skeleton */}
        <div className="flex-1 overflow-y-auto p-8 flex flex-col gap-4">
          {/* Invoice document skeleton — resembles a real invoice */}
          <div className="max-w-3xl mx-auto w-full flex-1 rounded-xl bg-white dark:bg-[#111827] border border-[#e2e8f0] dark:border-white/10 animate-pulse flex flex-col p-10">
            {/* Invoice header — logo + company name + INVOICE title */}
            <div className="flex items-start justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#e2e8f0] dark:bg-white/10" />
                <div>
                  <div className="h-5 w-36 rounded bg-[#e2e8f0] dark:bg-white/10 mb-1.5" />
                  <div className="h-3 w-48 rounded bg-[#e2e8f0]/50 dark:bg-white/5" />
                </div>
              </div>
              <div className="h-7 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
            </div>

            {/* Bill-to + Invoice details — two columns */}
            <div className="flex justify-between mb-10">
              <div className="space-y-2">
                <div className="h-3 w-16 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                <div className="h-4 w-40 rounded bg-[#e2e8f0] dark:bg-white/10" />
                <div className="h-3 w-52 rounded bg-[#e2e8f0]/50 dark:bg-white/5" />
                <div className="h-3 w-36 rounded bg-[#e2e8f0]/50 dark:bg-white/5" />
              </div>
              <div className="space-y-2 text-right">
                <div className="flex items-center gap-2 justify-end">
                  <div className="h-3 w-20 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                  <div className="h-3 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <div className="h-3 w-24 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                  <div className="h-3 w-28 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <div className="h-3 w-16 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                  <div className="h-3 w-28 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
              </div>
            </div>

            {/* Line items table */}
            <div className="flex-1 flex flex-col">
              {/* Table header */}
              <div className="flex items-center gap-4 px-4 py-3 rounded-t-lg bg-[#f1f5f9] dark:bg-white/5 border-b border-[#e2e8f0] dark:border-white/10">
                <div className="h-3 w-2/5 rounded bg-[#cbd5e1] dark:bg-white/10" />
                <div className="h-3 w-12 rounded bg-[#cbd5e1] dark:bg-white/10 ml-auto" />
                <div className="h-3 w-16 rounded bg-[#cbd5e1] dark:bg-white/10" />
                <div className="h-3 w-20 rounded bg-[#cbd5e1] dark:bg-white/10" />
              </div>
              {/* Table rows */}
              {[0.9, 0.7, 0.8, 0.6].map((w, i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 px-4 py-3.5 border-b border-[#e2e8f0]/60 dark:border-white/5"
                >
                  <div
                    className="h-3 rounded bg-[#e2e8f0] dark:bg-white/10"
                    style={{ width: `${w * 40}%` }}
                  />
                  <div className="h-3 w-8 rounded bg-[#e2e8f0]/60 dark:bg-white/5 ml-auto" />
                  <div className="h-3 w-14 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                  <div className="h-3 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
              ))}
            </div>

            {/* Totals footer — right-aligned */}
            <div className="mt-6 flex justify-end">
              <div className="w-56 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="h-3 w-16 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                  <div className="h-3 w-20 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div className="flex items-center justify-between">
                  <div className="h-3 w-10 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                  <div className="h-3 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div className="border-t border-[#e2e8f0] dark:border-white/10 pt-2.5 flex items-center justify-between">
                  <div className="h-4 w-12 rounded bg-[#e2e8f0] dark:bg-white/10" />
                  <div className="h-4 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right — Metadata Sidebar skeleton */}
        <div className="w-[380px] border-l border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] flex flex-col overflow-hidden">
          {/* Tab icons skeleton */}
          <div className="flex items-center justify-center gap-1 p-3">
            <div className="w-9 h-9 rounded-full bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
            <div className="w-9 h-9 rounded-full bg-[#e2e8f0]/60 dark:bg-white/5 animate-pulse" />
          </div>

          {/* Sidebar content skeleton */}
          <div className="flex-1 p-5 animate-pulse">
            {/* Bill Info section */}
            <div className="mb-6">
              <div className="h-3 w-16 rounded bg-[#e2e8f0] dark:bg-white/10 mb-4" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                <div>
                  <div className="h-2.5 w-14 rounded bg-[#e2e8f0]/60 dark:bg-white/5 mb-1.5" />
                  <div className="h-4 w-20 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div>
                  <div className="h-2.5 w-18 rounded bg-[#e2e8f0]/60 dark:bg-white/5 mb-1.5" />
                  <div className="h-4 w-16 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div>
                  <div className="h-2.5 w-20 rounded bg-[#e2e8f0]/60 dark:bg-white/5 mb-1.5" />
                  <div className="h-4 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
                <div>
                  <div className="h-2.5 w-16 rounded bg-[#e2e8f0]/60 dark:bg-white/5 mb-1.5" />
                  <div className="h-4 w-24 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
              </div>
            </div>

            {/* Bookkeeping section */}
            <div className="mb-6">
              <div className="h-3 w-24 rounded bg-[#e2e8f0] dark:bg-white/10 mb-4" />
              <div className="h-16 w-full rounded-lg bg-[#e2e8f0]/60 dark:bg-white/5 mb-3" />
              <div className="h-10 w-full rounded-lg border border-[#e2e8f0] dark:border-white/10" />
            </div>

            {/* Vendor section */}
            <div className="mb-6">
              <div className="h-3 w-14 rounded bg-[#e2e8f0] dark:bg-white/10 mb-4" />
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
                <div>
                  <div className="h-4 w-28 rounded bg-[#e2e8f0] dark:bg-white/10 mb-1.5" />
                  <div className="h-3 w-36 rounded bg-[#e2e8f0]/60 dark:bg-white/5" />
                </div>
              </div>
            </div>

            {/* Approver section */}
            <div>
              <div className="h-3 w-20 rounded bg-[#e2e8f0] dark:bg-white/10 mb-4" />
              <div className="h-9 w-full rounded-lg bg-[#e2e8f0]/60 dark:bg-white/5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
