/**
 * Statement Lines List — grid rows for reconciliation page
 * Extracted from reconciliations_.$reconciliationId.tsx
 */
import { useMemo } from "react";
import type {
  StatementLineItem,
  FlagItem,
  LedgerTransaction,
} from "../../routes/api/-reconciliations";
import { formatMoney } from "./reconHelpers";

/**
 * Grid columns: StatusBar | Date | Party+Description | Amount | MatchStatus | Chevron.
 *
 * Reconciliation is a compare-across-columns table (responsive-ui §4.2): the reader is checking a
 * statement line against a ledger line, so the columns are the point and the grid scrolls rather
 * than collapsing to cards. Below `md` the two action tracks widen to 44px for touch and the rest
 * tighten to compensate, which keeps the row within ~45px of a 375px viewport.
 */
const RECON_GRID_CLASS =
  "grid-cols-[4px_76px_minmax(150px,1fr)_100px_44px_44px] md:grid-cols-[4px_72px_minmax(160px,1fr)_110px_36px_36px]";

/**
 * Sum of the fixed tracks above. Grid tracks with a fixed width never shrink, so without a floor
 * the row is clipped by the pane's `overflow-hidden` ancestors instead of scrolling. The pane is a
 * scroll container already (`overflow-y: auto` forces the x axis to `auto` too), so the floor is
 * all that is needed to make the axis reachable.
 */
const RECON_GRID_MIN_WIDTH = 418;

export default function StatementLinesList({
  lines,
  flags,
  hoveredId,
  linkedId,
  selectedId,
  onHover,
  onSelect,
  isFinalized,
  isEditMode = false,
  onCreateTransaction,
  onUnmatch,
  unmatchedLedgerByAmount,
  onQuickMatch,
  onNavigateToTransaction,
}: {
  lines: StatementLineItem[];
  flags: FlagItem[];
  hoveredId: string | null;
  linkedId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  isFinalized: boolean;
  isEditMode?: boolean;
  onCreateTransaction?: (statementLineId: string) => void;
  onUnmatch?: (statementLineId: string) => void;
  unmatchedLedgerByAmount?: Map<string, LedgerTransaction>;
  onQuickMatch?: (statementLineId: string, journalLineId: string) => void;
  onNavigateToTransaction?: (journalHeaderId: string) => void;
}) {
  const flagsByLine = useMemo(() => {
    const map = new Map<string, FlagItem[]>();
    for (const f of flags) {
      if (f.statementLineId) {
        const arr = map.get(f.statementLineId) ?? [];
        arr.push(f);
        map.set(f.statementLineId, arr);
      }
    }
    return map;
  }, [flags]);

  if (lines.length === 0) {
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
      {lines.map((line) => {
        const isHighlighted = hoveredId === line.id || linkedId === line.id;
        const isSelected = selectedId === line.id;
        const lineFlags = flagsByLine.get(line.id);
        const amount = Number.parseFloat(line.amount);
        const isDeposit = amount > 0;

        // Parse date for display
        const d = new Date(`${line.transactionDate}T00:00:00`);
        const month = d.toLocaleDateString("en-US", { month: "short" });
        const day = d.toLocaleDateString("en-US", { day: "numeric" });
        const year = d.toLocaleDateString("en-US", { year: "numeric" });

        // Derive party initials + color from description
        const partyName = line.description.split(/\s+/).slice(0, 3).join(" ");
        const partyInitials =
          partyName
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w[0])
            .join("")
            .toUpperCase() || "?";
        // Stable color from string
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
        for (let i = 0; i < partyName.length; i++) {
          hash = partyName.charCodeAt(i) + ((hash << 5) - hash);
        }
        const partyColor = colors[Math.abs(hash) % colors.length];

        // Match-status-based row color (green = matched, orange = unmatched)
        const isMatchedRow = line.matchStatus === "matched" || line.matchStatus === "ignored";

        return (
          <div
            key={line.id}
            data-statement-line-id={line.id}
            className={`group flex items-center cursor-pointer border-b transition-colors duration-100 ${
              isSelected
                ? "bg-[#eff6ff] dark:bg-blue-950/60 border-[#dbeafe] dark:border-blue-900/40"
                : isHighlighted
                  ? isMatchedRow
                    ? "bg-emerald-50/80 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/40"
                    : "bg-orange-50/80 dark:bg-orange-950/30 border-orange-100 dark:border-orange-900/40"
                  : isMatchedRow
                    ? "bg-emerald-50/40 dark:bg-emerald-950/10 border-emerald-100/50 dark:border-emerald-900/20 hover:bg-emerald-50/70 dark:hover:bg-emerald-950/25"
                    : "bg-orange-50/40 dark:bg-orange-950/10 border-orange-100/50 dark:border-orange-900/20 hover:bg-orange-50/70 dark:hover:bg-orange-950/25"
            }`}
            onMouseEnter={() => onHover(line.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => !isFinalized && onSelect(line.id)}
          >
            {/* Grid row */}
            <div className={`grid items-center flex-1 min-w-0 ${RECON_GRID_CLASS}`}>
              {/* Status indicator bar */}
              <div className="self-stretch">
                {isSelected && <div className="w-1 h-full bg-blue-500" />}
                {!isSelected && isHighlighted && (
                  <div
                    className={`w-1 h-full ${isMatchedRow ? "bg-emerald-400" : "bg-orange-400"}`}
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
                    {line.description}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {lineFlags && lineFlags.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[11px] md:text-[9px] font-medium">
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                          <line
                            x1="4"
                            y1="22"
                            x2="4"
                            y2="15"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                        {lineFlags.length}
                      </span>
                    )}
                    {line.matchConfidence && (
                      <span className="text-[11px] md:text-[9px] text-[#94a3b8] dark:text-slate-500 tabular-nums">
                        {Math.round(Number.parseFloat(line.matchConfidence) * 100)}% conf
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Amount — money never truncates or wraps */}
              <div className="py-3 md:py-2.5 px-2 text-right">
                <span
                  className={`text-sm md:text-[13px] font-semibold tabular-nums whitespace-nowrap ${
                    isDeposit
                      ? "text-[#16a34a] dark:text-emerald-400"
                      : "text-[#1e293b] dark:text-slate-100"
                  }`}
                >
                  {isDeposit ? "+" : ""}
                  {formatMoney(line.amount)}
                </span>
              </div>

              {/* Match status icon — interactive in Edit mode */}
              <div className="flex items-center justify-center">
                {line.matchStatus === "matched" ? (
                  isEditMode ? (
                    <button
                      type="button"
                      aria-label="Unmatch this statement line"
                      className="w-7 h-7 touch-target rounded-full bg-orange-500/15 flex items-center justify-center cursor-pointer hover:bg-orange-500/25"
                      title="Click to unmatch"
                      onClick={(e) => {
                        if (onUnmatch) {
                          e.stopPropagation();
                          onUnmatch(line.id);
                        }
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
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="text-[#1e8e3e] dark:text-emerald-400"
                    >
                      <title>Matched</title>
                      <path
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="m9 11.5 2 2L15.5 9m4.5 3c0 4.909-5.354 8.479-7.302 9.615-.221.13-.332.194-.488.227a1.1 1.1 0 0 1-.42 0c-.156-.033-.267-.098-.488-.227C9.354 20.479 4 16.909 4 12V7.218c0-.8 0-1.2.13-1.543a2 2 0 0 1 .548-.79c.276-.242.65-.383 1.398-.664l5.362-2.01c.208-.078.312-.117.419-.133a1 1 0 0 1 .286 0c.107.016.21.055.419.133l5.362 2.01c.748.281 1.122.422 1.398.665a2 2 0 0 1 .547.789c.131.343.131.743.131 1.543z"
                      />
                    </svg>
                  )
                ) : line.matchStatus === "ignored" ? (
                  <div className="w-5 h-5 rounded-full bg-gray-200/50 dark:bg-white/5 flex items-center justify-center">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="text-gray-400"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </div>
                ) : (
                  (() => {
                    // Smart toggle: if a match candidate exists, show link icon (clickable to re-match)
                    const amountKey = Math.abs(Number.parseFloat(line.amount)).toFixed(2);
                    const matchCandidate = unmatchedLedgerByAmount?.get(amountKey);

                    if (matchCandidate && isEditMode) {
                      const canQuickMatch = !!onQuickMatch;
                      return (
                        <button
                          type="button"
                          // `aria-disabled`, not `disabled`: the title explains *why* the control
                          // is inert here, and a disabled button never gets the hover that shows it.
                          aria-disabled={!canQuickMatch}
                          aria-label="Match this statement line to its ledger candidate"
                          className={`w-7 h-7 touch-target rounded-full bg-emerald-500/15 flex items-center justify-center transition-all ${
                            canQuickMatch ? "cursor-pointer hover:bg-emerald-500/30" : ""
                          }`}
                          title={
                            canQuickMatch
                              ? `Click to match: ${matchCandidate.description || matchCandidate.partyName || "Ledger transaction"}`
                              : "Match candidate available — switch to Edit mode to re-link"
                          }
                          onClick={(e) => {
                            if (canQuickMatch) {
                              e.stopPropagation();
                              onQuickMatch(line.id, matchCandidate.id);
                            }
                          }}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-emerald-600 dark:text-emerald-400"
                          >
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                        </button>
                      );
                    }

                    return isEditMode ? (
                      <div
                        className="w-7 h-7 rounded-full bg-amber-500/10 flex items-center justify-center"
                        title="Unmatched"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          className="text-amber-600 dark:text-amber-400"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      </div>
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        fill="none"
                        viewBox="0 0 24 24"
                        className="text-[#f9ab00] dark:text-amber-400"
                      >
                        <title>Unmatched</title>
                        <path
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M12 6v6l4 2m6-2c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10"
                        />
                      </svg>
                    );
                  })()
                )}
              </div>

              {/* Action: Create transaction (only if NO match candidate), or view chevron.
                  The hover reveal keeps its base `opacity-0 group-hover:opacity-100` pair on
                  purpose — styles.css unhides exactly that pair under `@media (hover: none)`, so
                  rewriting it with breakpoint variants is what would strand it on touch. */}
              <div className="flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {line.matchStatus !== "matched" &&
                line.matchStatus !== "ignored" &&
                !isFinalized &&
                !unmatchedLedgerByAmount?.has(
                  Math.abs(Number.parseFloat(line.amount)).toFixed(2),
                ) &&
                onCreateTransaction ? (
                  <button
                    type="button"
                    aria-label="Create transaction from this line"
                    title="Create transaction from this line"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateTransaction(line.id);
                    }}
                    className="w-6 h-6 touch-target rounded-full bg-[var(--color-app-header-teal)] hover:bg-[var(--color-app-header-teal)]/90 flex items-center justify-center text-white shadow-sm transition-all hover:scale-110"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label="View transaction"
                    title="View transaction"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onNavigateToTransaction) {
                        // Matched rows: navigate via matchedJournalHeaderId
                        if (
                          (line.matchStatus === "matched" || line.matchStatus === "ignored") &&
                          line.matchedJournalHeaderId
                        ) {
                          onNavigateToTransaction(line.matchedJournalHeaderId);
                          return;
                        }
                        // Unmatched rows with a match candidate: navigate to candidate's transaction
                        const amountKey = Math.abs(Number.parseFloat(line.amount)).toFixed(2);
                        const candidate = unmatchedLedgerByAmount?.get(amountKey);
                        if (candidate?.journalHeaderId) {
                          onNavigateToTransaction(candidate.journalHeaderId);
                          return;
                        }
                      }
                      onSelect(line.id);
                    }}
                    className="w-6 h-6 touch-target rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center justify-center transition-colors cursor-pointer"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
