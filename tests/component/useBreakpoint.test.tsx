import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsCompactNav, useIsMobile, useMinWidth } from "@/hooks/useBreakpoint";

/**
 * Proves the breakpoint hooks are *reactive*, not merely correct on mount.
 *
 * This is deliberately asserted in a test rather than in a browser. The layout guards that depend
 * on it — the Activity Log modal in `transactions_.new`, the sidebar in
 * `transactions_.$transactionId` — close an overlay when the viewport grows past the point where
 * a docked equivalent takes over. That transition cannot be exercised through the CDP-driven
 * viewport override used for visual checks: it rewrites viewport metrics silently, so
 * `matchMedia(...).matches` flips while neither `change` nor `resize` is ever dispatched, and
 * every JS-gated layout stays frozen on whatever it first rendered. A passing manual check there
 * would have proved nothing, and a failing one would have been a false alarm.
 *
 * So the contract is pinned here instead: given a `change` event — which real browsers do fire on
 * a real resize or device rotation — the hook re-renders with the new value.
 */

type Listener = (event: MediaQueryListEvent) => void;

/** A controllable `matchMedia` — one entry per query, each with its own listener set. */
function installMatchMedia(initialWidth: number) {
  const registry = new Map<string, { matches: boolean; listeners: Set<Listener> }>();

  const evaluate = (query: string, width: number) => {
    const min = query.match(/min-width:\s*(\d+)px/);
    if (min) return width >= Number(min[1]);
    const max = query.match(/max-width:\s*(\d+)px/);
    if (max) return width <= Number(max[1]);
    return false;
  };

  let width = initialWidth;

  vi.stubGlobal("matchMedia", (query: string) => {
    let entry = registry.get(query);
    if (!entry) {
      entry = { matches: evaluate(query, width), listeners: new Set() };
      registry.set(query, entry);
    }
    const self = entry;
    return {
      get matches() {
        return self.matches;
      },
      media: query,
      addEventListener: (_: string, fn: Listener) => self.listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => self.listeners.delete(fn),
      // Legacy API, present so anything reaching for it does not explode.
      addListener: (fn: Listener) => self.listeners.add(fn),
      removeListener: (fn: Listener) => self.listeners.delete(fn),
      dispatchEvent: () => false,
      onchange: null,
    };
  });

  return {
    /** Move the viewport and fire `change` on every query whose result actually flipped. */
    resizeTo(next: number) {
      width = next;
      for (const [query, entry] of registry) {
        const matches = evaluate(query, next);
        if (matches === entry.matches) continue;
        entry.matches = matches;
        for (const fn of entry.listeners) {
          fn({ matches, media: query } as MediaQueryListEvent);
        }
      }
    },
    /** Nobody should be left subscribed after unmount. */
    listenerCount() {
      return [...registry.values()].reduce((sum, e) => sum + e.listeners.size, 0);
    },
  };
}

describe("useBreakpoint", () => {
  let mm: ReturnType<typeof installMatchMedia>;

  beforeEach(() => {
    mm = installMatchMedia(1280);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the real viewport on first render, not a default", () => {
    const { result } = renderHook(() => useMinWidth("lg"));
    expect(result.current).toBe(true);
  });

  it("re-renders when the query flips — the contract the layout guards depend on", () => {
    const { result } = renderHook(() => useIsCompactNav());
    expect(result.current).toBe(false); // 1280 ⇒ not compact

    act(() => mm.resizeTo(375));
    expect(result.current).toBe(true); // crossed below lg ⇒ compact

    act(() => mm.resizeTo(1280));
    expect(result.current).toBe(false); // and back again
  });

  it("does not re-render for a resize that stays inside the same band", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useIsMobile();
    });
    const before = renders;

    act(() => mm.resizeTo(1100)); // 1280 → 1100: both are ≥ md, so `useIsMobile` is unchanged

    expect(result.current).toBe(false);
    expect(renders).toBe(before);
  });

  it("separates the navigation boundary (lg) from the data boundary (md)", () => {
    const { result } = renderHook(() => ({
      compactNav: useIsCompactNav(),
      mobile: useIsMobile(),
    }));

    act(() => mm.resizeTo(900)); // tablet landscape: drawer nav, but tables are still viable
    expect(result.current).toEqual({ compactNav: true, mobile: false });

    act(() => mm.resizeTo(600)); // phone: both
    expect(result.current).toEqual({ compactNav: true, mobile: true });
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useIsCompactNav());
    expect(mm.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });
});
