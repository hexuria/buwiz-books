/**
 * useBreakpoint — hydration-safe viewport queries.
 *
 * Prefer CSS variants (`md:flex`) over this hook. Reach for it only when the two layouts cannot
 * share a DOM tree — mounting an off-canvas drawer instead of a persistent rail, or a card list
 * instead of a `<table>`. Rendering both and hiding one with `hidden md:block` doubles the work
 * for a data table and breaks focus order, so those cases are genuinely JS-gated.
 *
 * Why not `useMediaQuery`: it seeds state to `false` and corrects in an effect, so the first
 * client render is *always* the desktop branch and every mobile consumer flashes desktop layout
 * before settling. `useSyncExternalStore` instead reads the real value during the first
 * post-hydration render, so React corrects it before paint rather than after.
 *
 * SSR has no viewport. `getServerSnapshot` must therefore return a fixed guess, and the guess is
 * mobile-first: a phone briefly seeing phone layout is correct, whereas a phone briefly seeing a
 * 1400px canvas is the bug this file exists to remove.
 */
import { useSyncExternalStore, useCallback } from "react";

/** Tailwind v4 defaults. Keep in sync with `internal-docs/architecture/responsive-ui.md` §2. */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

export type BreakpointToken = keyof typeof BREAKPOINTS;

const EMPTY_SUBSCRIBE = () => () => {};

/**
 * Subscribe to a raw media query. `matches` is correct on the first client render.
 *
 * @param query a CSS media query, e.g. `"(min-width: 768px)"`
 * @param serverValue what SSR and the hydration pass should assume
 */
export function useMediaQueryLive(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) return serverValue;
    return window.matchMedia(query).matches;
  }, [query, serverValue]);

  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);

  return useSyncExternalStore(
    typeof window === "undefined" ? EMPTY_SUBSCRIBE : subscribe,
    getSnapshot,
    getServerSnapshot,
  );
}

/** True at or above `token`. `useMinWidth("md")` ⇒ `(min-width: 768px)`. */
export function useMinWidth(token: BreakpointToken): boolean {
  // Server assumes the smallest viewport, so every `min-width` query starts false.
  return useMediaQueryLive(`(min-width: ${BREAKPOINTS[token]}px)`, false);
}

/**
 * Below `md` (768px) — the *data* boundary. Tables become cards, modals become sheets.
 */
export function useIsMobile(): boolean {
  return !useMinWidth("md");
}

/**
 * Below `lg` (1024px) — the *navigation* boundary. The sidebar is an overlay drawer here.
 */
export function useIsCompactNav(): boolean {
  return !useMinWidth("lg");
}

/** True once the real viewport is known — i.e. after hydration. Use to suppress entry animations. */
export function useHasViewport(): boolean {
  return useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );
}

/** The largest token whose min-width the viewport satisfies; `"base"` below 640px. */
export function useBreakpoint(): BreakpointToken | "base" {
  const sm = useMinWidth("sm");
  const md = useMinWidth("md");
  const lg = useMinWidth("lg");
  const xl = useMinWidth("xl");
  const xxl = useMinWidth("2xl");

  if (xxl) return "2xl";
  if (xl) return "xl";
  if (lg) return "lg";
  if (md) return "md";
  if (sm) return "sm";
  return "base";
}

/** Honours the OS "reduce motion" setting — gate sheet/drawer transitions on this. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQueryLive("(prefers-reduced-motion: reduce)", false);
}

/** True for coarse pointers (touch). Hover-only affordances must have an alternative when true. */
export function useIsTouch(): boolean {
  return useMediaQueryLive("(pointer: coarse)", false);
}
