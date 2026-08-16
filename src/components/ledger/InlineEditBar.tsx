/**
 * InlineEditBar — Floating "Editing N transaction… Cancel / Apply" bar
 *
 * Shown when rows have pending inline edits but NO checkboxes are selected.
 * Same visual position as BatchActionBar (overlays LedgerHeader).
 */

interface InlineEditBarProps {
  /** Number of transactions with pending edits */
  editCount: number;
  /** Whether the apply mutation is in progress */
  isApplying?: boolean;
  /** Cancel all pending edits */
  onCancel: () => void;
  /** Apply all pending edits */
  onApply: () => void;
}

const BAR_CLASS =
  "absolute top-0 left-0 right-0 z-50 flex items-center gap-3 px-5 py-3 border-b border-[#e5e7eb] dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm";

export default function InlineEditBar({
  editCount,
  isApplying,
  onCancel,
  onApply,
}: InlineEditBarProps) {
  return (
    <div data-testid="inline-edit-bar" className={BAR_CLASS}>
      {/* Left: Pencil icon + label */}
      <div className="flex items-center gap-2 flex-1">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-[#14b8a6] dark:text-[#2dd4bf] shrink-0"
        >
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
        <span className="text-[13px] font-semibold text-[#1e293b] dark:text-white whitespace-nowrap">
          Editing {editCount} transaction{editCount !== 1 ? "s" : ""}…
        </span>
      </div>

      {/* Right: Cancel + Apply */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onCancel}
          data-testid="inline-cancel"
          className="px-4 py-1.5 text-[13px] font-medium text-[#64748b] dark:text-slate-300 hover:text-[#1e293b] dark:hover:text-white hover:bg-[#f1f5f9] dark:hover:bg-slate-700 rounded-full transition-colors"
        >
          Cancel
        </button>

        <button
          type="button"
          onClick={onApply}
          disabled={isApplying}
          data-testid="inline-apply"
          className={`flex items-center gap-1.5 px-4 py-1.5 text-[13px] font-semibold rounded-full transition-all whitespace-nowrap ${
            isApplying
              ? "bg-[#f1f5f9] dark:bg-slate-700 text-[#cbd5e1] dark:text-slate-500 cursor-wait"
              : "bg-[#14b8a6] hover:bg-[#0d9488] dark:bg-[#2dd4bf] dark:hover:bg-[#248f82] text-white shadow-sm"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <path
              d="M20 6L9 17l-5-5"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Apply {editCount}
        </button>
      </div>
    </div>
  );
}
