/**
 * Modal — the one overlay primitive.
 *
 * Replaces 36 hand-rolled `fixed inset-0` blocks, none of which adapted to the viewport. The
 * presentation is chosen by content type and screen size rather than hardcoded per call site
 * (see `internal-docs/architecture/responsive-ui.md` §5):
 *
 *   mobile="fullscreen"  forms, editors, wizards, viewers   → a real screen below `md`
 *   mobile="sheet"       pick-from-list, row actions, filters → bottom sheet below `md`
 *   mobile="center"      short confirms and destructive checks → stays a centered dialog
 *
 * At `md` and above all three render as the same centered dialog, so a call site only ever
 * declares what the content *is*.
 *
 * Heights use `dvh`, never `vh`: mobile browser chrome makes `100vh` taller than the visible
 * viewport, which is what pushes footers off-screen today.
 *
 * A `ConfirmDialog` wrapper used to live here and was deleted with zero importers: every confirm
 * in the app carries its own copy, icon and button labels, so wrapping `<Modal mobile="center"
 * size="sm">` in a fixed title/message/confirmLabel shape saved nothing and hid the one decision
 * that matters (`mobile="center"`, never a sheet — see §5). Write confirms against `Modal`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsMobile, usePrefersReducedMotion } from "../../hooks/useBreakpoint";
import { useEscapeKey, useFocusTrap, useScrollLock } from "../../hooks/useOverlayBehavior";

export type ModalMobileMode = "fullscreen" | "sheet" | "center";
export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-5xl",
  full: "sm:max-w-[min(96vw,1400px)]",
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Rendered in the header. Required — it is also the accessible name of the dialog. */
  title: string;
  /** Optional line under the title. */
  description?: string;
  children: React.ReactNode;
  /** Pinned action row. On mobile it sits above the home indicator and actions go full-width. */
  footer?: React.ReactNode;
  /** How this content should present below `md`. See the table above. */
  mobile?: ModalMobileMode;
  /** Desktop width. Ignored below `md`. */
  size?: ModalSize;
  /** Set false for flows where a stray backdrop tap would lose work. */
  closeOnBackdrop?: boolean;
  /** Extra classes on the scrolling body. */
  bodyClassName?: string;
  /** Hides the header entirely — the title is still announced. Use for media viewers. */
  hideHeader?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  mobile = "fullscreen",
  size = "md",
  closeOnBackdrop = true,
  bodyClassName = "",
  hideHeader = false,
}: ModalProps) {
  const isMobile = useIsMobile();
  const reduceMotion = usePrefersReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);

  useScrollLock(open);
  useFocusTrap(open, panelRef);
  useEscapeKey(open, onClose);

  // Portals need a DOM target, so nothing renders during SSR.
  useEffect(() => setMounted(true), []);

  // Drive the entry transition off a second frame so the element has painted in its "from" state.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const asSheet = isMobile && mobile === "sheet";
  const asFullscreen = isMobile && mobile === "fullscreen";

  const drag = useSheetDrag(asSheet, onClose);

  if (!mounted || !open) return null;

  const transition = reduceMotion ? "" : "transition-all duration-200 ease-out";

  // Sheet slides up; fullscreen fades without moving (a slide reads as a page push it isn't);
  // centered dialog scales in.
  let motionClass: string;
  if (asSheet) {
    motionClass = entered ? "translate-y-0" : "translate-y-full";
  } else if (asFullscreen) {
    motionClass = entered ? "opacity-100" : "opacity-0";
  } else {
    motionClass = entered ? "opacity-100 scale-100" : "opacity-0 scale-95";
  }

  let shapeClass: string;
  if (asSheet) {
    shapeClass = "w-full max-h-[85dvh] rounded-t-2xl pb-safe";
  } else if (asFullscreen) {
    shapeClass = "w-full h-[100dvh] rounded-none";
  } else {
    shapeClass = `w-[calc(100%-2rem)] max-h-[85dvh] rounded-2xl ${SIZE_CLASS[size]}`;
  }

  const alignClass = asSheet ? "items-end" : asFullscreen ? "items-stretch" : "items-center";

  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex justify-center ${alignClass}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={closeOnBackdrop ? onClose : undefined}
        className={`absolute inset-0 h-full w-full cursor-default border-0 bg-slate-900/50 backdrop-blur-[2px] ${transition} ${
          entered ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        style={drag.style}
        className={`relative flex flex-col overflow-hidden bg-white shadow-2xl outline-none dark:bg-slate-900 ${shapeClass} ${transition} ${motionClass} ${
          asFullscreen ? "" : "sm:w-[calc(100%-2rem)]"
        }`}
      >
        {/* Grab handle — the affordance that tells a thumb this can be dragged away. */}
        {asSheet && (
          <div
            {...drag.handleProps}
            className="flex shrink-0 cursor-grab touch-none justify-center pt-3 pb-1 active:cursor-grabbing"
          >
            <div className="h-1.5 w-10 rounded-full bg-slate-300 dark:bg-slate-600" />
          </div>
        )}

        {!hideHeader && (
          <header
            className={`flex shrink-0 items-start gap-3 border-b border-slate-200 px-4 dark:border-slate-800 ${
              asFullscreen ? "pt-safe min-h-14 items-center py-2" : "py-3"
            } ${asSheet ? "border-b-0 pb-2" : ""}`}
          >
            {/* Fullscreen reads as a pushed screen, so the close affordance is a back arrow on the
                left where a thumb expects it. Everywhere else it is an X on the right. */}
            {asFullscreen && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Back"
                className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5" />
                  <path d="M12 19l-7-7 7-7" />
                </svg>
              </button>
            )}

            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                {title}
              </h2>
              {description && (
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
              )}
            </div>

            {!asFullscreen && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </header>
        )}

        <div
          className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 ${bodyClassName}`}
        >
          {children}
        </div>

        {footer && (
          <footer
            className={`flex shrink-0 gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800 ${
              isMobile ? "flex-col-reverse [&>*]:w-full pb-safe" : "flex-row justify-end"
            }`}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Drag-to-dismiss for bottom sheets.
 *
 * Only downward drags do anything, and only past 25% of the sheet's height — a short tug springs
 * back so the gesture is forgiving. Pointer events cover touch and mouse without a second path.
 */
function useSheetDrag(active: boolean, onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const startRef = useRef<number | null>(null);
  const heightRef = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!active) return;
      startRef.current = e.clientY;
      heightRef.current = e.currentTarget.parentElement?.getBoundingClientRect().height ?? 0;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [active],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (startRef.current === null) return;
    setOffset(Math.max(0, e.clientY - startRef.current));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (startRef.current === null) return;
      const travelled = e.clientY - startRef.current;
      startRef.current = null;
      const threshold = Math.max(80, heightRef.current * 0.25);
      if (travelled > threshold) onClose();
      setOffset(0);
    },
    [onClose],
  );

  useEffect(() => {
    if (!active) setOffset(0);
  }, [active]);

  return {
    style: offset > 0 ? { transform: `translateY(${offset}px)`, transition: "none" } : undefined,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
