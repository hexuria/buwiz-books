/**
 * ReconfigureModal — Reconfigure statement details for a reconciliation
 *
 * The Statement Date is read-only because it defines the reconciliation period
 * and changing it would break the monthly boundary. Only the ending balance
 * and optional deposits/withdrawals can be modified.
 */
import { useState, useEffect, type FC } from "react";
import { Modal } from "../ui/Modal";

export interface ReconfigureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    periodEnd: string;
    statementEndingBalance: string;
    deposits?: string;
    withdrawals?: string;
  }) => void;
  isPending?: boolean;
  bankAccountName: string;
  bankAccountNumber?: string | null;
  accountType?: string | null;
  /** Current values for pre-filling */
  currentPeriodEnd: string;
  currentStatementEndingBalance?: string | null;
  /** If a bank statement image exists (kept for API compat, unused in modal) */
  statementImageUrl?: string | null;
}

/** Format YYYY-MM-DD as a human-readable date */
function formatStatementDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** text-base below sm: iOS Safari zooms the viewport on any smaller input and never zooms back. */
const AMOUNT_INPUT_CLASS =
  "w-full min-h-11 pl-7 pr-3 py-2.5 text-base sm:text-[13px] text-right text-gray-800 dark:text-white bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400/40 focus:border-emerald-400 transition-colors tabular-figures";

const LABEL_CLASS = "block text-xs font-medium text-gray-500 dark:text-white/50 mb-1.5";

export const ReconfigureModal: FC<ReconfigureModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  isPending = false,
  bankAccountName,
  bankAccountNumber,
  accountType,
  currentPeriodEnd,
  currentStatementEndingBalance,
  statementImageUrl: _statementImageUrl,
}) => {
  const isCreditCard = accountType === "credit_card";
  const inflowLabel = isCreditCard ? "Charges" : "Deposits";
  const outflowLabel = isCreditCard ? "Payments" : "Withdrawals";

  // Bank icon based on type
  const bankIcon = isCreditCard ? "💳" : "🏦";

  // Form state — statementDate is fixed from currentPeriodEnd, not editable
  const [endingBalance, setEndingBalance] = useState("");
  const [deposits, setDeposits] = useState("");
  const [withdrawals, setWithdrawals] = useState("");

  // Sync form with props when opening
  useEffect(() => {
    if (isOpen) {
      setEndingBalance(currentStatementEndingBalance || "");
      setDeposits("");
      setWithdrawals("");
    }
  }, [isOpen, currentStatementEndingBalance]);

  const handleSubmit = () => {
    onSubmit({
      periodEnd: currentPeriodEnd,
      statementEndingBalance: endingBalance,
      deposits: deposits || undefined,
      withdrawals: withdrawals || undefined,
    });
  };

  // Truncated account name for display
  const displayName = bankAccountNumber
    ? `${bankAccountName} ${bankAccountNumber}`
    : bankAccountName;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={`${bankIcon} ${displayName}`}
      description="Enter Statement Details"
      mobile="fullscreen"
      size="md"
      closeOnBackdrop={!isPending}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="h-11 px-5 text-sm font-medium text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 transition-colors rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending || !currentPeriodEnd}
            className="h-11 px-5 text-sm font-semibold text-white bg-[#1a6b3c] hover:bg-[#15572f] rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? "Saving…" : "Reconfigure"}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Statement Date (read-only) */}
        <div>
          <span className={LABEL_CLASS}>Statement Date</span>
          <div className="flex min-h-11 items-center gap-2 px-3 py-2.5 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-gray-400 dark:text-white/30 shrink-0"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span className="text-sm text-gray-800 dark:text-white font-medium">
              {formatStatementDate(currentPeriodEnd)}
            </span>
          </div>
        </div>

        {/* Statement Ending Balance */}
        <div>
          <label htmlFor="reconfigure-ending-balance" className={LABEL_CLASS}>
            Statement Ending Balance
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-white/30">
              $
            </span>
            <input
              id="reconfigure-ending-balance"
              type="text"
              inputMode="decimal"
              value={endingBalance}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.-]/g, "");
                setEndingBalance(val);
              }}
              placeholder="0.00"
              className={AMOUNT_INPUT_CLASS}
            />
          </div>
        </div>

        {/* Deposits / Charges (Optional) */}
        <div>
          <label htmlFor="reconfigure-inflow" className={LABEL_CLASS}>
            {inflowLabel}{" "}
            <span className="text-gray-400 dark:text-white/30 font-normal">(Optional)</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-white/30">
              $
            </span>
            <input
              id="reconfigure-inflow"
              type="text"
              inputMode="decimal"
              value={deposits}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.-]/g, "");
                setDeposits(val);
              }}
              placeholder=""
              className={AMOUNT_INPUT_CLASS}
            />
          </div>
        </div>

        {/* Withdrawals / Payments (Optional) */}
        <div>
          <label htmlFor="reconfigure-outflow" className={LABEL_CLASS}>
            {outflowLabel}{" "}
            <span className="text-gray-400 dark:text-white/30 font-normal">(Optional)</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-white/30">
              $
            </span>
            <input
              id="reconfigure-outflow"
              type="text"
              inputMode="decimal"
              value={withdrawals}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.-]/g, "");
                setWithdrawals(val);
              }}
              placeholder=""
              className={AMOUNT_INPUT_CLASS}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ReconfigureModal;
