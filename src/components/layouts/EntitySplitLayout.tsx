import { useState, useEffect } from "react";

interface EntitySplitLayoutProps {
  header: React.ReactNode;
  sidebar: React.ReactNode;
  content: React.ReactNode | ((isSidebarOpen: boolean) => React.ReactNode);
  /** When true, hide header/sidebar/toggle and let content fill the entire area */
  fullscreen?: boolean;
}

export function EntitySplitLayout({
  header,
  sidebar,
  content,
  fullscreen,
}: EntitySplitLayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Responsive behavior:
  // - Large screens (>1024px): Sidebar open by default, can toggle.
  // - Medium/Small screens: Sidebar closed by default (auto-hide), can toggle (float).
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(true);
      }
    };

    handleResize();

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const resolvedContent = typeof content === "function" ? content(isSidebarOpen) : content;

  // Fullscreen mode: content takes over the entire area
  if (fullscreen) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-[#111827] relative overflow-hidden">
        <div className="flex-1 h-full overflow-hidden flex flex-col">{resolvedContent}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322] relative overflow-hidden group/layout">
      {/* Header - consistently at the top */}
      <div className="shrink-0 z-30 relative bg-[#fafbfc] dark:bg-[#0c1322]">{header}</div>

      {/* Main Layout Area */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Sidebar Container */}
        <div
          className={`
            shrink-0 border-r border-[#e2e8f0] dark:border-white/10 flex flex-col bg-white dark:bg-[#111827]
            transition-all duration-300 ease-in-out z-20 h-full overflow-hidden
            ${
              isSidebarOpen
                ? "w-[min(100vw,380px)] translate-x-0 opacity-100 border-r"
                : "w-0 -translate-x-full opacity-0 border-none"
            }
            lg:relative absolute shadow-xl lg:shadow-none
          `}
        >
          {/*
            Width is pinned to the viewport rather than the (animating) parent so the panel keeps
            sliding instead of squashing. Below `lg` the container is absolutely positioned inside
            an `overflow-hidden` ancestor, so a hard 380px simply clipped off a 375px screen.
          */}
          <div className="w-[min(100vw,380px)] h-full flex flex-col min-h-0">{sidebar}</div>
        </div>

        {/* Backdrop for mobile/tablet when sidebar is floating */}
        {isSidebarOpen && (
          <div
            className="lg:hidden absolute inset-0 bg-black/20 z-10 backdrop-blur-sm"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col bg-white dark:bg-[#111827] relative min-w-0 transition-all duration-300">
          {/* Toggle Button */}
          <div className="absolute top-4 left-4 z-30">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="flex items-center justify-center w-8 h-8 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-slate-400 hover:text-slate-600 dark:text-white/40 dark:hover:text-white"
              title={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          </div>

          {/* Content Children */}
          <div className="flex-1 h-full overflow-hidden flex flex-col">{resolvedContent}</div>
        </div>
      </div>
    </div>
  );
}
