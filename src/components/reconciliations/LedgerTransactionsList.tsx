/**
 * Ledger Transactions List — reconciliation page
 * Extracted from reconciliations_.$reconciliationId.tsx
 */
import { useNavigate } from "@tanstack/react-router";
import type { LedgerTransaction } from "../../routes/api/-reconciliations";
import { formatMoney } from "./reconHelpers";

/** Fields that can be edited inline on the reconciliation page */
export interface ReconInlineEdits {
  partyId?: string;
  categoryAccountId?: string;
}

/**
 * Grid columns: StatusBar | Date | Party+Description | Amount | MatchStatus | Chevron.
 *
 * Deliberately identical to the statement side (responsive-ui §4.2): the two lists are read against
 * each other, so their columns have to line up at every width. Below `md` the two action tracks
 * widen to 44px for touch and the rest tighten to compensate.
 */
const RECON_GRID_CLASS_VIEW =
  "grid-cols-[4px_76px_minmax(150px,1fr)_100px_44px_44px] md:grid-cols-[4px_72px_minmax(160px,1fr)_110px_36px_36px]";

/**
 * Sum of the fixed tracks above. Fixed grid tracks never shrink, so without this floor the row is
 * clipped by the pane's `overflow-hidden` ancestors instead of scrolling.
 */
const RECON_GRID_MIN_WIDTH = 418;

export default function LedgerTransactionsList({
  transactions,
  hoveredId,
  linkedId,
  onHover,
  onMatch,
  onStatusClick,
  selectedStatementLineId,
  isFinalized,
  isEditMode = false,
  pendingEdits,
  reconcileTargetTxnId = null,
  onReconcileStart,
  onReconcileCancel,
}: {
  transactions: LedgerTransaction[];
  hoveredId: string | null;
  linkedId: string | null;
  onHover: (id: string | null) => void;
  onMatch: (journalLineId: string) => void;
  onUnmatch?: (statementLineId: string) => void;
  onStatusClick?: (txn: LedgerTransaction) => void;
  selectedStatementLineId: string | null;
  isFinalized: boolean;
  isEditMode?: boolean;
  pendingEdits?: Map<string, ReconInlineEdits>;
  reconcileTargetTxnId?: string | null;
  onReconcileStart?: (txnId: string) => void;
  onReconcileCancel?: () => void;
}) {
  const navigate = useNavigate();

  if (transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-4">
        <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center mb-3">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-gray-400"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <div className="text-[15px] font-semibold text-gray-900 dark:text-white mb-1">
          Not Found
        </div>
      </div>
    );
  }

  return (
    <div style={{ minWidth: RECON_GRID_MIN_WIDTH }}>
      {transactions.map((txn) => {
        const isHighlighted = hoveredId === txn.id || linkedId === txn.id;
        const canMatch = !isFinalized && selectedStatementLineId && !txn.isMatched;
        const _edits = pendingEdits?.get(txn.id);
        const isReconcileTarget = reconcileTargetTxnId === txn.id;

        // Parse date
        const d = new Date(`${txn.transactionDate}T00:00:00`);
        const month = d.toLocaleDateString("en-US", { month: "short" });
        const day = d.toLocaleDateString("en-US", { day: "numeric" });
        const year = d.toLocaleDateString("en-US", { year: "numeric" });

        // Derive party initials + color
        const name = txn.partyName || txn.description || txn.accountName;
        const partyInitials =
          name
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w[0])
            .join("")
            .toUpperCase() || "?";
        const colors = [
          "#ef4444",
          "#f97316",
          "#f59e0b",
          "#84cc16",
          "#22c55e",
          "#14b8a6",
          "#06b6d4",
          "#3b82f6",
          "#6366f1",
          "#a855f7",
          "#ec4899",
          "#f43f5e",
        ];
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
          hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const partyColor = colors[Math.abs(hash) % colors.length];

        // Amount display
        const debitAmt = txn.debit ? Number.parseFloat(txn.debit) : 0;
        const creditAmt = txn.credit ? Number.parseFloat(txn.credit) : 0;
        const displayAmount = debitAmt > 0 ? debitAmt : creditAmt;
        const isCredit = creditAmt > 0 && debitAmt === 0;

        // Resolved display values (pending edits override)
        const displayPartyName = txn.partyName;

        return (
          <div
            key={txn.id}
            className={`group flex items-center border-b transition-colors duration-100 ${
              isHighlighted
                ? txn.isMatched
                  ? "bg-emerald-50/80 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/40"
                  : "bg-orange-50/80 dark:bg-orange-950/30 border-orange-100 dark:border-orange-900/40"
                : txn.isMatched
                  ? "bg-emerald-50/40 dark:bg-emerald-950/10 border-emerald-100/50 dark:border-emerald-900/20 hover:bg-emerald-50/70 dark:hover:bg-emerald-950/25"
                  : "bg-orange-50/40 dark:bg-orange-950/10 border-orange-100/50 dark:border-orange-900/20 hover:bg-orange-50/70 dark:hover:bg-orange-950/25"
            } ${canMatch && isEditMode ? "cursor-pointer" : ""} ${
              isReconcileTarget
                ? "ring-2 ring-cyan-500 ring-inset bg-cyan-50/50 dark:bg-cyan-950/30"
                : ""
            }`}
            onMouseEnter={() => onHover(txn.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => isEditMode && canMatch && onMatch(txn.id)}
          >
            <div className={`grid items-center flex-1 min-w-0 ${RECON_GRID_CLASS_VIEW}`}>
              {/* Status bar */}
              <div className="self-stretch">
                {isHighlighted && (
                  <div
                    className={`w-1 h-full ${txn.isMatched ? "bg-emerald-400" : "bg-orange-400"}`}
                  />
                )}
              </div>

              {/* Date */}
              <div className="py-3 md:py-2.5 px-2 text-center">
                <div className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100 leading-tight">
                  {month} {day}
                </div>
                <div className="text-[11px] md:text-[10px] text-[#94a3b8] dark:text-slate-500">
                  {year}
                </div>
              </div>

              {/* Party + Description */}
              <div className="flex items-center gap-2.5 py-3 md:py-2.5 px-2 min-w-0">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] md:text-[10px] font-bold shrink-0"
                  style={{ backgroundColor: partyColor }}
                >
                  {partyInitials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm md:text-[13px] font-medium text-[#1e293b] dark:text-slate-100 truncate">
                    {displayPartyName || txn.description || txn.accountName}
                  </div>
                  {!isEditMode && (
                    <div className="flex items-center gap-2 mt-0.5">
                      {txn.transactionNumber && (
                        <span className="text-[11px] md:text-[9px] text-[#94a3b8] dark:text-slate-500 font-mono truncate">
                          #{txn.transactionNumber}
                        </span>
                      )}
                      {txn.source && (
                        <span className="inline-flex px-1.5 py-0 rounded bg-gray-100 dark:bg-white/5 text-[11px] md:text-[9px] text-[#94a3b8] dark:text-slate-500">
                          {txn.source}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Amount — money never truncates or wraps */}
              <div className="py-3 md:py-2.5 px-2 text-right">
                <span
                  className={`text-sm md:text-[13px] font-semibold tabular-nums whitespace-nowrap ${
                    isCredit
                      ? "text-[#16a34a] dark:text-emerald-400"
                      : "text-[#1e293b] dark:text-slate-100"
                  }`}
                >
                  {isCredit ? "+" : ""}
                  {formatMoney(displayAmount)}
                </span>
              </div>

              {/* Match status / Status toggle */}
              <div className="flex items-center justify-center">
                {txn.isMatched ? (
                  isEditMode ? (
                    /* Unlink — click to unmatch */
                    <button
                      type="button"
                      aria-label="Unmatch this transaction"
                      className="w-8 h-8 touch-target rounded-full bg-orange-500/15 flex items-center justify-center cursor-pointer hover:bg-orange-500/25"
                      title="Click to unmatch"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStatusClick?.(txn);
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                          stroke="#f5a623"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                          stroke="#f5a623"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle cx="19" cy="19" r="4.5" fill="#e8675a" />
                        <path
                          d="M17.25 17.25l3.5 3.5M20.75 17.25l-3.5 3.5"
                          stroke="white"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  ) : (
                    /* ShieldTick — Reconciled (view mode) */
                    <div className="w-6 h-6 rounded-full bg-emerald-500/15 flex items-center justify-center">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        fill="none"
                        viewBox="0 0 24 24"
                        className="text-emerald-600 dark:text-emerald-400"
                      >
                        <path
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="m9 11.5 2 2L15.5 9m4.5 3c0 4.909-5.354 8.479-7.302 9.615-.221.13-.332.194-.488.227a1.1 1.1 0 0 1-.42 0c-.156-.033-.267-.098-.488-.227C9.354 20.479 4 16.909 4 12V7.218c0-.8 0-1.2.13-1.543a2 2 0 0 1 .548-.79c.276-.242.65-.383 1.398-.664l5.362-2.01c.208-.078.312-.117.419-.133a1 1 0 0 1 .286 0c.107.016.21.055.419.133l5.362 2.01c.748.281 1.122.422 1.398.665a2 2 0 0 1 .547.789c.131.343.131.743.131 1.543z"
                        />
                      </svg>
                    </div>
                  )
                ) : canMatch && isEditMode ? (
                  <div className="w-5 h-5 rounded-full border-[1.5px] border-dashed border-emerald-400/50 dark:border-emerald-400/30 flex items-center justify-center group-hover:border-emerald-500 group-hover:bg-emerald-50 dark:group-hover:bg-emerald-500/10 transition-colors">
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="text-emerald-500/50 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </div>
                ) : isEditMode ? (
                  /* Unsettled row in edit mode — reconcile link button only */
                  <button
                    type="button"
                    className={`w-6 h-6 touch-target rounded-full flex items-center justify-center transition-all ${
                      isReconcileTarget
                        ? "bg-emerald-500 text-white shadow-sm"
                        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 cursor-pointer"
                    }`}
                    title={isReconcileTarget ? "Cancel reconcile" : "Reconcile with statement"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isReconcileTarget) {
                        onReconcileCancel?.();
                      } else {
                        onReconcileStart?.(txn.id);
                      }
                    }}
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
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                  </button>
                ) : (
                  /* Unsettled row in view mode — clock icon */
                  <div
                    className="w-6 h-6 rounded-full bg-amber-500/10 flex items-center justify-center"
                    title="Unsettled"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="text-amber-600 dark:text-amber-400"
                    >
                      <path
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 6v6l4 2m6-2c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10"
                      />
                    </svg>
                  </div>
                )}
              </div>

              {/* Chevron. The hover reveal keeps its base `opacity-0 group-hover:opacity-100` pair
                  on purpose — styles.css unhides exactly that pair under `@media (hover: none)`,
                  so rewriting it with breakpoint variants is what would strand it on touch. */}
              <button
                type="button"
                aria-label="View transaction"
                className="flex items-center justify-center touch-target opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                title="View Transaction"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate({ to: `/transactions/${txn.journalHeaderId}` as string & {} });
                }}
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
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
