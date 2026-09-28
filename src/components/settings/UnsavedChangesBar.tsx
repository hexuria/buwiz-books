/**
 * UnsavedChangesBar — the in-page "discard unsaved edits?" prompt Settings shows before a
 * navigation would drop them.
 *
 * Fixed to the bottom of the viewport so it is visible wherever the page is scrolled: the
 * navigation that raised it may have started in the header, the section list, or the browser's
 * back button. Focus lands on "Keep editing", the choice that loses nothing.
 */
import { useId } from "react";

export function UnsavedChangesBar({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const messageId = useId();
  return (
    <div
      role="alertdialog"
      aria-labelledby={messageId}
      className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-lg rounded-xl border border-[#fcd34d] dark:border-amber-900/60 bg-[#fffbeb] dark:bg-[#1c1917] p-4 shadow-lg"
    >
      <p id={messageId} className="text-sm font-medium text-[#92400e] dark:text-amber-100">
        {message}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="min-h-11 lg:min-h-0 rounded-lg bg-[#d97706] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#b45309]"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          // A raised prompt takes focus, and it lands on the choice that loses nothing.
          autoFocus
          onClick={onCancel}
          className="min-h-11 lg:min-h-0 rounded-lg border border-[#fcd34d] dark:border-amber-900/60 px-3 py-1.5 text-xs font-semibold text-[#92400e] dark:text-amber-100"
        >
          Keep editing
        </button>
      </div>
    </div>
  );
}
