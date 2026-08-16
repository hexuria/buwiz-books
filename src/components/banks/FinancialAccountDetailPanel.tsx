/**
 * FinancialAccountDetailPanel — Right-panel detail view for a financial account
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getFinancialAccount, deleteFinancialAccount } from "../../routes/api/-financial-accounts";
import { useState } from "react";
import { Modal } from "../ui/Modal";

interface FinancialAccountDetailPanelProps {
  accountId: string;
  onEdit: () => void;
  onDeleted: () => void;
}

const TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  checking: { icon: "🏦", label: "Checking", color: "#3b82f6" },
  savings: { icon: "🏦", label: "Savings", color: "#10b981" },
  credit_card: { icon: "💳", label: "Credit Card", color: "#f59e0b" },
  money_market: { icon: "🏦", label: "Money Market", color: "#10b981" },
  investment: { icon: "📈", label: "Investment", color: "#8b5cf6" },
  other: { icon: "🏛️", label: "Other", color: "#64748b" },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  connected: { label: "Connected", color: "#10b981", bg: "#10b98115" },
  stale: { label: "Stale", color: "#f59e0b", bg: "#f59e0b15" },
  disconnected: { label: "Disconnected", color: "#64748b", bg: "#64748b15" },
  pending: { label: "Pending", color: "#10b981", bg: "#10b98115" },
};

export function FinancialAccountDetailPanel({
  accountId,
  onEdit,
  onDeleted,
}: FinancialAccountDetailPanelProps) {
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data: account, isLoading } = useQuery({
    queryKey: ["financial-accounts", accountId],
    queryFn: () =>
      (getFinancialAccount as (opts: { data: unknown }) => Promise<any>)({
        data: { id: accountId },
      }),
  });

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await (deleteFinancialAccount as (opts: { data: unknown }) => Promise<any>)({
        data: { id: accountId },
      });
      queryClient.invalidateQueries({ queryKey: ["financial-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["financial-accounts", accountId] });
      onDeleted();
    } catch {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-6 h-6 border-2 border-[#10b981] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#94a3b8] dark:text-white/40">
        Account not found
      </div>
    );
  }

  const typeConfig = TYPE_CONFIG[account.accountType] || TYPE_CONFIG.other;
  const statusConfig = STATUS_CONFIG[account.connectionStatus || "disconnected"];

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Action Buttons Row */}
      {/* `pl-16` clears the layout's absolutely-positioned sidebar toggle, which is a 44px target
          below `lg`; `flex-wrap` keeps the buttons on-screen at 375px once that gutter is gone. */}
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 pl-16 pt-4 pb-3 border-b border-[#e2e8f0] dark:border-white/10 sm:px-8 sm:pl-16">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#f1f5f9] dark:bg-white/5 text-[#475569] dark:text-white/70 hover:bg-[#e2e8f0] dark:hover:bg-white/10 transition-colors"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-3 py-1.5 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Avatar, Name & Info */}
      <div className="px-4 py-5 border-b border-[#e2e8f0] dark:border-white/10 sm:px-8">
        <div className="flex items-center gap-3 sm:gap-4">
          {account.institutionLogoUrl ? (
            <img
              src={account.institutionLogoUrl}
              alt={account.accountName}
              className="w-14 h-14 rounded-xl object-cover shrink-0"
            />
          ) : (
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center text-lg font-bold text-white shrink-0"
              style={{
                backgroundColor: typeConfig.color,
              }}
            >
              {account.accountName
                .split(/\s+/)
                .slice(0, 2)
                .map((w: string) => w[0])
                .join("")
                .toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-lg sm:text-xl font-semibold text-[#1e293b] dark:text-white truncate">
              {account.accountName}
            </h2>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {account.institutionName && (
                <span className="text-sm text-[#64748b] dark:text-white/50">
                  {account.institutionName}
                </span>
              )}
              {account.lastFour && (
                <span className="text-xs font-mono text-[#94a3b8] dark:text-white/40 px-1.5 py-0.5 rounded bg-[#f1f5f9] dark:bg-white/5">
                  •••{account.lastFour}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* View Insights Link */}
      <div className="px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10 sm:px-8">
        <Link
          to={`/entities/banks/${accountId}` as string & {}}
          className="flex items-center justify-between w-full px-4 py-3 rounded-xl bg-gradient-to-r from-[#f0fdfa] to-[#ecfdf5] dark:from-slate-800 dark:to-slate-800 border border-[#d1fae5] dark:border-slate-700 hover:border-[#14b8a6] transition-colors no-underline group"
        >
          <div className="flex items-center gap-2.5">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#14b8a6"
              strokeWidth="2"
            >
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
            <span className="text-sm font-medium text-[#0d9488]">View Insights</span>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2"
            className="group-hover:translate-x-0.5 transition-transform"
          >
            <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>

      {/* Info Grid */}
      <div className="px-4 py-6 space-y-5 sm:px-8">
        {/* Two columns halve to ~155px at 375px, which wraps every value onto three lines —
            one column below `sm`, the paired grid from there up. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InfoField label="Account Type">
            <span
              className="inline-flex items-center gap-1.5 text-sm font-medium px-2 py-0.5 rounded-full"
              style={{ backgroundColor: `${typeConfig.color}15`, color: typeConfig.color }}
            >
              {typeConfig.icon} {typeConfig.label}
            </span>
          </InfoField>

          <InfoField label="Status">
            <span
              className="inline-flex items-center gap-1.5 text-sm font-medium px-2 py-0.5 rounded-full"
              style={{ backgroundColor: statusConfig.bg, color: statusConfig.color }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: statusConfig.color }}
              />
              {statusConfig.label}
            </span>
          </InfoField>

          <InfoField label="Last Four">
            <span className="text-sm text-[#1e293b] dark:text-white font-mono">
              {account.lastFour ? `•••${account.lastFour}` : "—"}
            </span>
          </InfoField>

          <InfoField label="Statement Password">
            {account.statementPasswordSet ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-[#1e293b] dark:text-white">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Set&nbsp;
                <span className="font-mono text-[#94a3b8] dark:text-white/40">••••••</span>
              </span>
            ) : (
              <span className="text-sm text-[#94a3b8] dark:text-white/40">Not set</span>
            )}
          </InfoField>

          <InfoField label="Source">
            <span className="text-sm text-[#1e293b] dark:text-white">
              {account.isManual ? "Manual Entry" : account.integrationSource || "—"}
            </span>
          </InfoField>

          <InfoField label="Linked Ledger Category">
            <span className="text-sm text-[#1e293b] dark:text-white">
              {account.ledgerAccountName || "Not linked"}
            </span>
            {account.ledgerAccountType && (
              <span className="ml-2 text-xs font-medium text-[#94a3b8] dark:text-white/40 uppercase">
                ({account.ledgerAccountType})
              </span>
            )}
          </InfoField>

          <InfoField label="Created">
            <span className="text-sm text-[#1e293b] dark:text-white">
              {new Date(account.createdAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          </InfoField>
        </div>
      </div>

      {/* Delete confirmation — `mobile="center"` per §5: a destructive check must never be a
          sheet, where a downward flick sits next to the delete button. */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete Account?"
        mobile="center"
        size="sm"
        closeOnBackdrop={!deleting}
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="h-11 rounded-lg px-4 text-sm font-medium text-[#64748b] dark:text-white/60 hover:bg-[#f1f5f9] dark:hover:bg-white/10 transition-colors disabled:opacity-50"
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              data-autofocus
              onClick={handleDelete}
              disabled={deleting}
              className="h-11 rounded-lg px-4 text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </>
        }
      >
        <p className="text-sm text-[#64748b] dark:text-white/60">
          This will deactivate <strong>{account.accountName}</strong>. You can restore it later.
        </p>
      </Modal>
    </div>
  );
}

// Helper component for info grid fields
function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="break-words">{children}</div>
    </div>
  );
}
