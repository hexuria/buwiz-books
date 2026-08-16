/**
 * MarkAsPaidModal — payment recording dialog.
 * Used from both the draft invoice page and the sent invoice detail page.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listFinancialAccounts } from "../../routes/api/-financial-accounts";
import { formatCurrency } from "./index";
import { Modal } from "../ui/Modal";

import type { ServerFnResult } from "@/lib/server-fn-client";

type BankOption = Pick<
  ServerFnResult<typeof listFinancialAccounts>[number],
  "id" | "accountName" | "lastFour"
>;

// ============================================================================
// Types
// ============================================================================

export interface MarkAsPaidModalProps {
  invoiceNumber: string;
  total: string;
  balanceDue: string;
  onConfirm: (opts: {
    paymentDate: string;
    memo: string;
    bankAccountId: string;
    paymentAmount: string;
  }) => void;
  onCancel: () => void;
  isPending?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function MarkAsPaidModal({
  invoiceNumber,
  total,
  balanceDue,
  onConfirm,
  onCancel,
  isPending = false,
}: MarkAsPaidModalProps) {
  const today = new Date().toISOString().split("T")[0];
  const [paymentDate, setPaymentDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  // Load company financial accounts (checking, savings, etc.)
  const { data: banks = [], isLoading: banksLoading } = useQuery<BankOption[]>({
    queryKey: ["financial-accounts-modal"],
    queryFn: () => listFinancialAccounts({ data: {} }),
  });

  const balance = Number.parseFloat(balanceDue || total || "0");
  const entered = Number.parseFloat(paymentAmount || "0");
  const isPartial = paymentAmount !== "" && entered > 0 && entered < balance - 0.005;
  const effectiveAmount = paymentAmount !== "" && entered > 0 ? paymentAmount : balance.toFixed(2);

  const canSubmit = confirmed && bankAccountId && !isPending;

  const handleConfirm = () => {
    if (!canSubmit) return;
    onConfirm({
      paymentDate,
      memo,
      bankAccountId,
      paymentAmount: effectiveAmount,
    });
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!isPending) onCancel();
      }}
      title="Mark as Paid"
      description={`Invoice ${invoiceNumber}`}
      mobile="fullscreen"
      size="sm"
      // The original had no dismissable backdrop — recording a payment is not something a stray
      // tap should abandon halfway through a form.
      closeOnBackdrop={false}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="h-11 px-4 rounded-xl border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 font-medium text-sm hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canSubmit}
            className="h-11 px-5 rounded-xl bg-gradient-to-r from-[#0d9488] to-[#059669] text-white font-semibold text-sm hover:shadow-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? (
              <span className="flex items-center justify-center gap-2">
                <svg
                  className="animate-spin"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Recording…
              </span>
            ) : (
              "Mark as Paid"
            )}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Amount summary */}
        <div className="bg-[#f0fdf4] dark:bg-emerald-900/20 rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-[#065f46] dark:text-emerald-300 font-medium">
            Balance Due
          </span>
          <span className="tabular-figures text-lg font-bold text-[#059669] dark:text-emerald-400">
            {formatCurrency(balanceDue || total)}
          </span>
        </div>

        {/* Payment Date */}
        <div>
          <label className="block text-xs font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Payment Date
          </label>
          <input
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            className="w-full h-11 px-3 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/40 focus:border-[#0d9488] transition-all"
          />
        </div>

        {/* Deposit Account */}
        <div>
          <label className="block text-xs font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Deposit Account <span className="text-[#ef4444]">*</span>
          </label>
          {banksLoading ? (
            <div className="h-11 rounded-xl bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
          ) : banks.length === 0 ? (
            <div className="px-3 py-2.5 rounded-xl border border-[#fde68a] bg-[#fef3c7] dark:bg-yellow-900/20 dark:border-yellow-500/30 text-sm text-[#92400e] dark:text-yellow-300">
              No bank accounts found. Add one in{" "}
              <a href="/entities/banks" className="underline font-medium">
                Banks & Cards
              </a>{" "}
              first.
            </div>
          ) : (
            <select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              className="w-full h-11 px-3 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/40 focus:border-[#0d9488] transition-all"
            >
              <option value="">Select deposit account…</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.accountName}
                  {b.lastFour ? ` (••••${b.lastFour})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Payment Amount (optional — for partial) */}
        <div>
          <label className="block text-xs font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Payment Amount{" "}
            <span className="text-[#94a3b8] dark:text-white/30 font-normal normal-case">
              (leave blank for full balance)
            </span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#94a3b8] dark:text-white/30">
              $
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              max={balance}
              placeholder={balance.toFixed(2)}
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              className="w-full h-11 pl-7 pr-3 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/40 focus:border-[#0d9488] transition-all"
            />
          </div>
          {isPartial && (
            <p className="text-xs text-[#f59e0b] dark:text-amber-400 mt-1 flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L1 21h22L12 2zm0 3.5L20.5 19h-17L12 5.5zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z" />
              </svg>
              This will be recorded as a partial payment
            </p>
          )}
        </div>

        {/* Internal Memo */}
        <div>
          <label className="block text-xs font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Internal Memo{" "}
            <span className="text-[#94a3b8] dark:text-white/30 font-normal normal-case">
              (optional)
            </span>
          </label>
          <textarea
            rows={2}
            placeholder="Add a note…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/40 focus:border-[#0d9488] transition-all resize-none"
          />
        </div>

        {/* Confirmation checkbox */}
        <label className="flex items-start gap-2.5 cursor-pointer group">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="touch-target mt-0.5 w-5 h-5 rounded accent-[#0d9488] cursor-pointer shrink-0"
          />
          <span className="text-xs text-[#64748b] dark:text-white/50 leading-relaxed group-hover:text-[#1e293b] dark:group-hover:text-white/70 transition-colors">
            By selecting "Mark as Paid" you are confirming that this payment was collected outside
            of this platform. This action cannot be undone.
          </span>
        </label>
      </div>
    </Modal>
  );
}
