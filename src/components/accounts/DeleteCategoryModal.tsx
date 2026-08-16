import React from "react";
import { Modal } from "../ui/Modal";

// ============================================================================
// Types
// ============================================================================

interface DeleteCategoryModalProps {
  /** Category name to display */
  categoryName: string;
  /** Custom title (default: "Delete Category") */
  title?: string;
  /** Custom message (default: "Are you sure you want to delete...") */
  message?: React.ReactNode;
  /** Custom confirm button label (default: "Delete") */
  confirmLabel?: string;
  /** Whether category has transactions */
  hasTransactions?: boolean;
  /** Transaction count */
  transactionCount?: number;
  /** Whether category is a system account */
  isSystem?: boolean;
  /** Delete handler */
  onConfirm: () => void;
  /** Cancel handler */
  onCancel: () => void;
  /** Loading state */
  isLoading?: boolean;
}

// ============================================================================
// Component
// ============================================================================

const WarningBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
    <p className="text-sm text-amber-800 dark:text-amber-200">{children}</p>
  </div>
);

export const DeleteCategoryModal: React.FC<DeleteCategoryModalProps> = ({
  categoryName,
  title = "Delete Category",
  message,
  confirmLabel = "Delete",
  hasTransactions = false,
  transactionCount = 0,
  isSystem = false,
  onConfirm,
  onCancel,
  isLoading = false,
}) => {
  const canDelete = !isSystem;

  // The callers mount this only while the confirmation is open, so there is no
  // `open` prop to thread through — it is open by definition.
  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      description="This action cannot be undone"
      mobile="center"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canDelete || isLoading}
            className="h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isLoading ? `${confirmLabel}...` : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/50">
          <svg
            className="h-6 w-6 text-red-600 dark:text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-300">
          {message || (
            <>
              Are you sure you want to delete <strong>{categoryName}</strong>?
            </>
          )}
        </div>
      </div>

      {isSystem && (
        <WarningBox>
          <strong>System account.</strong> This is a required system account and cannot be deleted.
        </WarningBox>
      )}

      {hasTransactions && !isSystem && (
        <WarningBox>
          <strong>Warning:</strong> This category has <strong>{transactionCount}</strong>{" "}
          transaction
          {transactionCount !== 1 ? "s" : ""}. Deleting will archive the category but preserve
          historical data.
        </WarningBox>
      )}
    </Modal>
  );
};

export default DeleteCategoryModal;
