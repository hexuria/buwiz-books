import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { formatCurrency } from "../../utils/format";

interface MatchTransaction {
  id: string;
  transactionDate?: string;
  transactionType?: string;
  memo?: string | null;
  totalAmount?: string | number | null;
  partyName?: string | null;
  referenceNumber?: string | null;
  categoryName?: string | null;
}

interface MergePreview {
  eligible: boolean;
  blockers: string[];
  checks: Array<{ key: string; passed: boolean; message: string }>;
}

interface MatchConfirmModalProps {
  transactions: [MatchTransaction, MatchTransaction];
  isLoading: boolean;
  isPreviewing: boolean;
  onPreview: (canonicalTransactionId: string) => Promise<MergePreview>;
  onConfirm: (canonicalTransactionId: string, reason: string) => void;
  onCancel: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  pay_in: "Pay In",
  pay_out: "Pay Out",
  journal: "Journal",
  transfer: "Transfer",
};

export default function MatchConfirmModal({
  transactions,
  isLoading,
  isPreviewing,
  onPreview,
  onConfirm,
  onCancel,
}: MatchConfirmModalProps) {
  const [txA, txB] = transactions;
  const [canonicalId, setCanonicalId] = useState(txA.id);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setCanonicalId(txA.id);
    setReason("");
    setPreview(null);
    setPreviewError(null);
  }, [txA.id, txB.id]);

  const runPreview = async () => {
    setPreviewError(null);
    try {
      setPreview(await onPreview(canonicalId));
    } catch (error) {
      setPreview(null);
      setPreviewError(error instanceof Error ? error.message : "Merge preview failed.");
    }
  };

  // A merge in flight must not be abandoned by a backdrop tap, Escape or the close affordance.
  const handleClose = () => {
    if (!isLoading) onCancel();
  };

  return (
    <Modal
      open
      onClose={handleClose}
      title="Merge duplicate transactions"
      description="Lossless ledger action"
      mobile="fullscreen"
      size="lg"
      closeOnBackdrop={!isLoading}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="h-11 rounded-md px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-200 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
          {preview?.eligible ? (
            <button
              type="button"
              onClick={() => onConfirm(canonicalId, reason.trim())}
              disabled={isLoading || reason.trim().length < 3}
              className="h-11 rounded-md bg-teal-700 px-5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
            >
              {isLoading ? "Merging…" : "Confirm merge"}
            </button>
          ) : (
            <button
              type="button"
              onClick={runPreview}
              disabled={isPreviewing || reason.trim().length < 3}
              className="h-11 rounded-md bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-700"
            >
              {isPreviewing ? "Checking…" : "Run safety preview"}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Choose the canonical journal
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Both journals and all lines remain auditable. Reports will count only the canonical one
            until an authorized user reverses this decision.
          </p>
        </div>

        <div className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {[txA, txB].map((transaction, index) => {
            const selected = canonicalId === transaction.id;
            return (
              <label
                key={transaction.id}
                className={`grid cursor-pointer grid-cols-[auto_1fr] gap-3 p-4 transition sm:grid-cols-[auto_1fr_auto] ${
                  selected
                    ? "bg-teal-50 dark:bg-teal-950/30"
                    : "bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800"
                }`}
              >
                <input
                  type="radio"
                  name="canonical-journal"
                  value={transaction.id}
                  checked={selected}
                  onChange={() => {
                    setCanonicalId(transaction.id);
                    setPreview(null);
                    setPreviewError(null);
                  }}
                  className="mt-1 h-5 w-5 shrink-0 accent-teal-700"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    Transaction {index === 0 ? "A" : "B"} {selected ? "· canonical" : ""}
                  </span>
                  <span className="mt-1 block truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {transaction.memo || transaction.partyName || "Untitled transaction"}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">
                    <span>{transaction.transactionDate || "No date"}</span>
                    <span>{transaction.partyName || "No party"}</span>
                    <span>
                      {transaction.transactionType
                        ? TYPE_LABELS[transaction.transactionType] ||
                          transaction.transactionType.replace("_", " ")
                        : "Unknown type"}
                    </span>
                  </span>
                  {/* Below sm the amount cannot share the row without squeezing the memo, so it
                      drops under the identity block instead of into a third column. */}
                  <span className="tabular-figures mt-2 block font-mono text-sm font-semibold whitespace-nowrap text-slate-900 sm:hidden dark:text-white">
                    {formatCurrency(Number(transaction.totalAmount ?? 0))}
                  </span>
                </span>
                <span className="tabular-figures hidden font-mono text-sm font-semibold whitespace-nowrap text-slate-900 sm:block dark:text-white">
                  {formatCurrency(Number(transaction.totalAmount ?? 0))}
                </span>
              </label>
            );
          })}
        </div>

        <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
          Merge reason
          {/* text-base below sm keeps iOS Safari from zooming the viewport on focus. */}
          <textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setPreview(null);
            }}
            rows={3}
            placeholder="Explain why these journals represent the same economic event"
            className="mt-2 w-full resize-none rounded-md border border-slate-300 bg-white p-3 text-base outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 sm:text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            Stored in the permanent audit history.
          </span>
        </label>

        {previewError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
            {previewError}
          </div>
        )}
        {preview && (
          <div
            className={`rounded-md border p-3 ${
              preview.eligible
                ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
                : "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30"
            }`}
          >
            <p
              className={`text-sm font-semibold ${
                preview.eligible
                  ? "text-emerald-800 dark:text-emerald-200"
                  : "text-rose-800 dark:text-rose-200"
              }`}
            >
              {preview.eligible ? "Safety checks passed" : "Merge is blocked"}
            </p>
            <div className="mt-2 space-y-1">
              {preview.checks.map((check) => (
                <p
                  key={check.key}
                  className={`text-xs ${
                    check.passed ? "text-slate-500" : "font-medium text-rose-700 dark:text-rose-300"
                  }`}
                >
                  {check.passed ? "Passed" : "Blocked"} · {check.message}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
