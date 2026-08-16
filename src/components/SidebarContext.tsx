/**
 * SidebarContext — shared collapse state for the desktop sidebar rail.
 *
 * Scope narrowed once the shell gained a real mobile mode. Below `lg` the sidebar is an overlay
 * drawer (see AppSidebar), which takes its own width and ignores `collapsed` entirely — so this
 * state only decides between the 240px panel and the 60px icon rail on desktop.
 *
 * The auto-collapse band is therefore `lg`–`xl` (1024–1280px), where a 240px panel is a quarter
 * of the viewport but the rail is still the right pattern. At `xl` and above it expands. The
 * previous rule collapsed at ≤1024px, which is now exactly the range where the rail is not
 * rendered at all.
 */
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { useMinWidth } from "../hooks/useBreakpoint";

interface SidebarContextValue {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  toggle: () => {},
});

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const isWide = useMinWidth("xl");
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse follows the breakpoint, but must not undo a deliberate toggle: without this,
  // expanding the rail on a 1200px screen was reverted by the next effect run.
  const lastAutoRef = useRef<boolean | null>(null);
  useEffect(() => {
    const auto = !isWide;
    if (lastAutoRef.current === auto) return;
    lastAutoRef.current = auto;
    setCollapsed(auto);
  }, [isWide]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle }}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
