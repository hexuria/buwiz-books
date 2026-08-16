/**
 * Plumbing shared by every overlay: scroll lock, focus trap, escape handling.
 *
 * These were re-implemented (or, more often, omitted) across the 36 hand-rolled `fixed inset-0`
 * blocks this replaces. Extracting them is what makes the overlay primitive worth adopting —
 * the visual shell is the easy part; the parts below are the ones everyone skips.
 */
import { useEffect, useRef } from "react";

/**
 * Prevents the page behind an overlay from scrolling, and restores the exact scroll position on
 * close.
 *
 * `overflow: hidden` on `<body>` is not enough: iOS Safari happily scrolls it anyway, which is why
 * a modal on an iPhone drags the page underneath it. Pinning the body with `position: fixed` and a
 * negative `top` is the approach that actually holds, at the cost of having to put the scroll
 * position back by hand.
 *
 * Nested overlays share one lock — a counter keeps the inner one from restoring scroll while the
 * outer one is still open.
 */
let lockCount = 0;
let savedScrollY = 0;

export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;

    if (lockCount === 0) {
      savedScrollY = window.scrollY;
      const { body } = document;
      // Compensate for the scrollbar disappearing, or the page shifts sideways as it locks.
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      body.style.position = "fixed";
      body.style.top = `-${savedScrollY}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    }
    lockCount += 1;

    return () => {
      lockCount -= 1;
      if (lockCount > 0) return;
      const { body } = document;
      body.style.position = "";
      body.style.top = "";
      body.style.left = "";
      body.style.right = "";
      body.style.width = "";
      body.style.paddingRight = "";
      window.scrollTo(0, savedScrollY);
    };
  }, [active]);
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keeps Tab inside the overlay and hands focus back to whatever opened it.
 *
 * Without this, tabbing out of a modal lands on the page behind it — which on mobile is invisible,
 * so the user's keyboard focus simply vanishes.
 */
export function useFocusTrap(active: boolean, containerRef: React.RefObject<HTMLElement | null>) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (!container) return;

    // Focus the first control, falling back to the container so screen readers announce the dialog.
    const initial =
      container.querySelector<HTMLElement>("[data-autofocus]") ??
      container.querySelector<HTMLElement>(FOCUSABLE) ??
      container;
    // A frame's delay lets entry transitions start before focus scrolls anything into view.
    const raf = requestAnimationFrame(() => initial.focus({ preventScroll: true }));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [active, containerRef]);
}

/**
 * Escape closes the topmost overlay only.
 *
 * The listener is registered on `document` in the capture phase so it fires before a nested
 * combobox swallows the key, but a module-level stack ensures only the last-opened overlay reacts.
 */
const escapeStack: Array<() => void> = [];

export function useEscapeKey(active: boolean, onEscape: () => void) {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const entry = () => handlerRef.current();
    escapeStack.push(entry);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeStack[escapeStack.length - 1] !== entry) return;
      e.stopPropagation();
      entry();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = escapeStack.indexOf(entry);
      if (i !== -1) escapeStack.splice(i, 1);
    };
  }, [active]);
}
