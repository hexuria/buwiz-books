/**
 * Responsive table primitives.
 *
 *   <TableScroll>      Wrap an existing `<table>`. Adds the horizontal scroll container, the
 *                      mandatory `min-width`, sticky header support and a scroll affordance.
 *                      Cheap to adopt — no change to the markup inside.
 *
 *   <RowActionsMenu>   The `⋯` overflow for a row: bottom sheet on mobile, popover on desktop.
 *
 * Strategy per table is a judgement call, documented in
 * `internal-docs/architecture/responsive-ui.md` §4. The short version: if the user reads *across*
 * a row to compare figures (trial balance, statements, reconciliation), keep the grid and scroll
 * it. If the user scans *down* to find one record and open it, use cards.
 *
 * A column-driven `<DataTable>` used to live here and was deleted with zero importers, after every
 * list surface in the app had been made responsive. Don't rebuild it. The surfaces here are
 * grouped or hierarchical rather than flat — collapsible status groups, recursive account trees,
 * per-row thumbnails, inline comboboxes sharing the row grid — so each one hand-applies the card
 * pattern from §4 against its own row shape. A single column definition cannot express that, and
 * five separate attempts to adopt one each declined it for a different structural reason.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useIsMobile } from "../../hooks/useBreakpoint";

// ─── TableScroll ─────────────────────────────────────────────────────────────

/**
 * Horizontal scroll container for a real `<table>`.
 *
 * `minWidth` is not optional by accident. Without it a table inside a narrow flex parent squashes
 * its columns to illegibility instead of overflowing, which is the current behaviour at all 21
 * `<table>` sites in this codebase — none of them has a scroll wrapper.
 *
 * `bleed` lets the scroll region run to the screen edge while the page keeps its gutter, so the
 * last column is not visually stranded behind padding.
 */
export function TableScroll({
  children,
  minWidth = 720,
  bleed = true,
  className = "",
}: {
  children: ReactNode;
  /** Width below which the table scrolls rather than squashes. */
  minWidth?: number;
  /** Extend to the viewport edge on mobile. */
  bleed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`scroll-x scroll-x-shadow ${bleed ? "-mx-4 px-4 sm:mx-0 sm:px-0" : ""} ${className}`}
    >
      <div style={{ minWidth }}>{children}</div>
    </div>
  );
}

export interface RowAction<T> {
  label: string;
  onSelect: (row: T) => void;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: (row: T) => boolean;
}

// ─── Row actions ─────────────────────────────────────────────────────────────

/**
 * The `⋯` overflow.
 *
 * On mobile it opens a bottom sheet with full-width 48px rows; on desktop a small popover. A row
 * of individual icon buttons is never right on a phone — they are too small, too close together,
 * and on touch there is no hover to reveal them in the first place.
 */
export function RowActionsMenu<T>({ row, actions }: { row: T; actions: Array<RowAction<T>> }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const run = useCallback(
    (action: RowAction<T>) => {
      setOpen(false);
      action.onSelect(row);
    },
    [row],
  );

  if (actions.length === 0) return null;

  const trigger = (
    <button
      ref={btnRef}
      type="button"
      aria-label="More actions"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="5" r="1.75" />
        <circle cx="12" cy="12" r="1.75" />
        <circle cx="12" cy="19" r="1.75" />
      </svg>
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Modal open={open} onClose={() => setOpen(false)} title="Actions" mobile="sheet" size="sm">
          <div className="flex flex-col">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={action.disabled?.(row)}
                onClick={() => run(action)}
                className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors disabled:opacity-40 ${
                  action.destructive
                    ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                }`}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </Modal>
      </>
    );
  }

  return (
    <div className="relative inline-block">
      {trigger}
      {open && (
        <>
          {/* Click-away. Transparent, below the menu, above everything else. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="fixed inset-0 z-40 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-1 min-w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                disabled={action.disabled?.(row)}
                onClick={(e) => {
                  e.stopPropagation();
                  run(action);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-40 ${
                  action.destructive
                    ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
                }`}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
