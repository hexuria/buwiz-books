import React from "react";
import { Modal } from "../ui/Modal";

// ============================================================================
// Types
// ============================================================================

interface ConfirmModalProps {
  /** Modal title */
  title: string;
  /** Subtitle shown below title */
  subtitle?: string;
  /** Main body message (can include JSX) */
  message: React.ReactNode;
  /** Confirm button label */
  confirmLabel?: string;
  /** Cancel button label */
  cancelLabel?: string;
  /** Confirm handler */
  onConfirm: () => void;
  /** Cancel handler */
  onCancel: () => void;
  /** Loading state */
  isLoading?: boolean;
  /** Disable confirmation until required input is valid */
  confirmDisabled?: boolean;
  /** Whether the confirm action is destructive (red styling) */
  destructive?: boolean;
  /** Optional custom icon to override the default trash/check icon */
  icon?: React.ReactNode;
}

// ============================================================================
// Component
// ============================================================================

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  subtitle = "This action cannot be undone",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  isLoading = false,
  confirmDisabled = false,
  destructive = true,
  icon,
}) => {
  const accentColor = destructive ? "#dc2626" : "#2a9d8f";
  const accentBg = destructive ? "#fee2e2" : "#d1fae5";
  const confirmBlocked = isLoading || confirmDisabled;

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      mobile="center"
      size="sm"
      // The icon sits beside the title, which the shared header cannot express, so the header is
      // rendered here instead. `title` still supplies the dialog's accessible name.
      hideHeader
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmBlocked}
            style={{ background: confirmBlocked ? "#94a3b8" : accentColor }}
            className="h-11 rounded-lg px-4 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed"
          >
            {isLoading ? "Processing..." : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <div
          style={{ background: accentBg }}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
        >
          {icon ? (
            icon
          ) : destructive ? (
            <svg
              style={{ color: accentColor }}
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          ) : (
            <svg
              style={{ color: accentColor }}
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          )}
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {subtitle && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="mt-4 text-sm text-slate-700 dark:text-slate-300">{message}</div>
    </Modal>
  );
};

export default ConfirmModal;
