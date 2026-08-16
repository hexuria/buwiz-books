/**
 * LedgerHeader — Top bar with Ledger title, View/Edit mode toggle (centered), and maximize button
 * header with green gradient background and pill toggle for View vs Edit mode
 */
interface LedgerHeaderProps {
  mode: "view" | "edit";
  onModeChange: (mode: "view" | "edit") => void;
  onMaximize?: () => void;
  isMaximized?: boolean;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}

export default function LedgerHeader({
  mode,
  onModeChange,
  onMaximize,
  isMaximized,
  panelOpen,
  onTogglePanel,
}: LedgerHeaderProps) {
  return (
    <div className="flex items-center px-5 py-3 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] rounded-t-lg">
      {/* Left: Ledger icon + title */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onTogglePanel}
          className="flex items-center justify-center w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg hover:bg-white/10 transition-colors text-white/70 hover:text-white"
          title={panelOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <h1 className="text-[15px] font-semibold text-white">Ledger</h1>
      </div>

      {/* Center: View / Edit pill toggle */}
      <div className="flex-1 flex justify-center">
        <div className="flex items-center p-1 bg-white/10 rounded-full">
          <button
            type="button"
            onClick={() => onModeChange("view")}
            data-testid="mode-toggle-view"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] font-medium transition-all ${
              mode === "view"
                ? "bg-white/20 text-white shadow-sm"
                : "text-white/50 hover:text-white hover:bg-white/10"
            }`}
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
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            View
          </button>
          <button
            type="button"
            onClick={() => onModeChange("edit")}
            data-testid="mode-toggle-edit"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] font-medium transition-all ${
              mode === "edit"
                ? "bg-white/20 text-white shadow-sm"
                : "text-white/50 hover:text-white hover:bg-white/10"
            }`}
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
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
            Edit
          </button>
        </div>
      </div>

      {/* Right: Maximize/Minimize button */}
      <button
        type="button"
        onClick={onMaximize}
        data-testid="header-maximize"
        className="w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors shrink-0"
        title={isMaximized ? "Minimize" : "Maximize"}
      >
        {isMaximized ? (
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
            <path d="M4 14h6v6" />
            <path d="M20 10h-6V4" />
            <path d="M14 10l7-7" />
            <path d="M3 21l7-7" />
          </svg>
        ) : (
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
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        )}
      </button>
    </div>
  );
}
