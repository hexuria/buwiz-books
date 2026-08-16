import { ArrowClockwise, ArrowDown } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface PullToRefreshProps {
  children: ReactNode;
  onRefresh: () => Promise<unknown> | unknown;
  disabled?: boolean;
  threshold?: number;
  className?: string;
}

const MAX_PULL_DISTANCE = 112;

/**
 * Adds a mobile pull-to-refresh gesture without changing the page's scroll model.
 *
 * The gesture only starts at the top of the document and ignores form controls, links, and
 * buttons. Consumers own the refresh operation, so the same indicator can be reused by any page
 * that already has a query invalidation or reload function.
 */
export function PullToRefresh({
  children,
  onRefresh,
  disabled = false,
  threshold = 72,
  className = "",
}: PullToRefreshProps) {
  const refreshThreshold = Math.max(1, threshold);
  const rootRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  const refreshingRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const distanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const scrollTop = () =>
      typeof window === "undefined"
        ? 0
        : Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop);

    const resetGesture = () => {
      startRef.current = null;
      distanceRef.current = 0;
      setIsPulling(false);
    };

    const isInteractiveTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      Boolean(target.closest("button, input, textarea, select, a, [contenteditable='true']"));

    const runRefresh = async () => {
      if (disabled || refreshingRef.current) return;

      refreshingRef.current = true;
      setIsRefreshing(true);
      setPullDistance(refreshThreshold);
      try {
        await onRefreshRef.current();
      } finally {
        refreshingRef.current = false;
        setIsRefreshing(false);
        setPullDistance(0);
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      if (disabled || refreshingRef.current || event.touches.length !== 1) return;
      if (scrollTop() > 0 || isInteractiveTarget(event.target)) return;

      const touch = event.touches[0];
      startRef.current = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchMove = (event: TouchEvent) => {
      const start = startRef.current;
      if (!start || refreshingRef.current || event.touches.length !== 1) return;
      if (scrollTop() > 0) {
        resetGesture();
        setPullDistance(0);
        return;
      }

      const touch = event.touches[0];
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (deltaY <= 0 || Math.abs(deltaX) > Math.abs(deltaY)) {
        resetGesture();
        setPullDistance(0);
        return;
      }

      if (event.cancelable) event.preventDefault();
      const distance = Math.min(MAX_PULL_DISTANCE, deltaY * 0.5);
      distanceRef.current = distance;
      setIsPulling(true);
      setPullDistance(distance);
    };

    const onTouchEnd = () => {
      if (!startRef.current) return;
      const shouldRefresh = distanceRef.current >= refreshThreshold;
      resetGesture();
      if (shouldRefresh) {
        void runRefresh();
      } else {
        setPullDistance(0);
      }
    };

    const onTouchCancel = () => {
      resetGesture();
      if (!refreshingRef.current) setPullDistance(0);
    };

    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    root.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [disabled, refreshThreshold]);

  const progress = Math.min(1, pullDistance / refreshThreshold);
  const indicatorVisible = isRefreshing || pullDistance > 0;
  const indicatorMessage = isRefreshing
    ? "Refreshing…"
    : progress >= 1
      ? "Release to refresh"
      : "Pull to refresh";
  const indicatorOffset = isRefreshing ? 12 : Math.max(4, pullDistance - 42);

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      data-pull-to-refresh="true"
      style={{ overscrollBehaviorY: "contain" }}
    >
      {indicatorVisible && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center">
          <div
            role="status"
            aria-live="polite"
            className={`flex items-center gap-2 rounded-full border border-emerald-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-emerald-800 shadow-[0_10px_25px_-14px_rgba(16,36,26,0.5)] backdrop-blur dark:border-emerald-400/20 dark:bg-[#111820]/95 dark:text-emerald-200 ${isPulling ? "" : "transition-[opacity,transform] duration-200 ease-out"}`}
            style={{
              opacity: Math.max(0.25, Math.min(1, progress + 0.15)),
              transform: `translate3d(0, ${indicatorOffset}px, 0)`,
            }}
          >
            {isRefreshing ? (
              <ArrowClockwise size={15} weight="bold" className="animate-spin" />
            ) : (
              <ArrowDown
                size={15}
                weight="bold"
                className="transition-transform duration-100"
                style={{ transform: `rotate(${progress * 180}deg)` }}
              />
            )}
            {indicatorMessage}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
