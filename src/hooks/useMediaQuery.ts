/**
 * useMediaQuery — SSR-safe hook for responsive breakpoint detection
 *
 * Usage:
 *   const isMobile = useMediaQuery("(max-width: 640px)");
 *   const isTablet = useMediaQuery("(max-width: 768px)");
 *   const isMedium = useMediaQuery("(max-width: 1024px)");
 */
import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
