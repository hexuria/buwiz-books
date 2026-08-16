/**
 * ManageCloseModal — Book-close management
 *
 * Org name → lock icon + date picker → footer actions. "Open All Periods" is a two-step
 * action: the first press arms an inline confirmation, the second one commits.
 */
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

interface ManageCloseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (closedDate: string | null) => void;
  orgName?: string;
  initialClosedDate?: string | null;
  /** Pre-fill date from current date range when no close date exists */
  suggestedDate?: string | null;
}

export default function ManageCloseModal({
  isOpen,
  onClose,
  onSave,
  orgName = "My Organization",
  initialClosedDate = null,
  suggestedDate = null,
}: ManageCloseModalProps) {
  const [closedDate, setClosedDate] = useState(initialClosedDate ?? suggestedDate ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { showToast } = useToast();

  const hasExistingClose = !!initialClosedDate;

  const handleSave = () => {
    onSave(closedDate || null);
    if (closedDate) {
      showToast("Books closed successfully", { icon: "success" });
    }
    onClose();
  };

  const handleOpenAll = () => {
    if (hasExistingClose && !confirmOpen) {
      setConfirmOpen(true);
      return;
    }
    setClosedDate("");
    onSave(null);
    showToast("All periods have been opened", { icon: "success" });
    setConfirmOpen(false);
    onClose();
  };

  const ghostButton =
    "h-11 w-full rounded-lg px-4 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 sm:w-auto dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200";

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Manage Close"
      description="Lock every period on or before a date."
      mobile="fullscreen"
      size="sm"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={handleOpenAll}
            data-testid={confirmOpen ? "confirm-open-all-btn" : "open-all-periods-btn"}
            className={
              confirmOpen
                ? "h-11 w-full rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-600 sm:w-auto"
                : "h-11 w-full rounded-lg px-4 text-sm font-medium text-sky-500 transition-colors hover:bg-slate-100 sm:w-auto dark:text-teal-400 dark:hover:bg-slate-700"
            }
          >
            {confirmOpen ? "Open" : "Open All Periods"}
          </button>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={confirmOpen ? () => setConfirmOpen(false) : onClose}
              data-testid={confirmOpen ? "cancel-open-all-btn" : "cancel-btn"}
              className={ghostButton}
            >
              Cancel
            </button>
            {!confirmOpen && (
              <button
                type="button"
                onClick={handleSave}
                data-testid="apply-close-btn"
                className="h-11 w-full rounded-lg bg-sky-500 px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 sm:w-auto dark:bg-teal-400"
              >
                Save
              </button>
            )}
          </div>
        </div>
      }
    >
      <div data-testid="manage-close-modal" className="space-y-5">
        {/* Organization row */}
        <div className="flex items-center gap-3 border-b border-slate-200 pb-5 dark:border-slate-700">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-emerald-500">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v12M6 12h12" />
            </svg>
          </div>
          <span className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-white">
            {orgName}
          </span>
        </div>

        {/* Close date row */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-slate-500 dark:text-slate-400"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <label
              htmlFor="manage-close-date"
              className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              Closed through
            </label>
            {/* text-base below sm: anything smaller makes iOS Safari zoom on focus and stay there. */}
            <input
              id="manage-close-date"
              type="date"
              data-testid="close-date-input"
              value={closedDate}
              onChange={(e) => {
                setClosedDate(e.target.value);
                setConfirmOpen(false);
              }}
              placeholder="No closed date"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base text-slate-900 outline-none placeholder-slate-400 focus:border-sky-500 sm:text-sm dark:border-slate-600 dark:bg-slate-700 dark:text-white dark:placeholder-slate-500 dark:focus:border-teal-400"
            />
          </div>
        </div>

        {confirmOpen && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
          >
            Are you sure you would like to open all prior periods?
          </p>
        )}
      </div>
    </Modal>
  );
}
