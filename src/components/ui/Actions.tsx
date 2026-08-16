/**
 * Action primitives — buttons, icon buttons, and the responsive filter bar.
 *
 * The problem these solve: a labelled button or a filter row in a flex container has no way to get
 * smaller, so at 375px it either wraps to two lines or runs off the edge. The fix is not a smaller
 * control — it is a *different* one: an icon button with a guaranteed 44px hit area, or a single
 * "Filters (n)" button that opens a sheet.
 *
 * See `internal-docs/architecture/responsive-ui.md` §6.
 *
 * An `<AdaptiveButton>` (label collapses to icon) and a `<PageHeader>` (title plus an overflow
 * toolbar) used to live here and were deleted with zero importers, after every surface in the app
 * had been made responsive. Don't rebuild them. Routes keep their headers inline because each one
 * carries route-specific content — period selectors, running totals, tab strips, breadcrumbs —
 * that a `title`/`actions` prop pair cannot hold without growing a prop per route.
 */
import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useIsMobile } from "../../hooks/useBreakpoint";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-600/50",
  secondary:
    "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  danger: "bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-600/50",
};

// 44px is the minimum comfortable touch target; `sm` keeps a 36px box but the icon-button variant
// still expands its *hit* area to 44px via `.touch-target`.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-4 text-sm",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`${BASE} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Icon-only control with a guaranteed 44×44 hit area.
 *
 * `label` is mandatory: an icon button with no accessible name is invisible to a screen reader,
 * and 287 controls in this codebase currently sit below the touch minimum.
 */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  className = "",
  ...rest
}: {
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={`touch-target inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:opacity-40 ${VARIANT_CLASS[variant]} ${className}`}
    >
      {icon}
    </button>
  );
}

/**
 * Filter chrome. Inline on desktop; a single "Filters (n)" button opening a sheet on mobile.
 *
 * A filter row is the most common cause of a clipped toolbar in this app — chips, a search field
 * and two dropdowns cannot coexist in 375px, and today they simply run off the edge.
 */
export function FilterBar({
  activeCount,
  children,
  trailing,
}: {
  /** Drives the badge, and tells the user filters are applied while the sheet is shut. */
  activeCount: number;
  children: ReactNode;
  /** Always-visible controls, e.g. a search input. */
  trailing?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!isMobile) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {trailing}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {trailing}
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        className="shrink-0"
        aria-expanded={open}
        icon={
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 6h16M7 12h10M10 18h4" />
          </svg>
        }
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        mobile="sheet"
        size="md"
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            Show results
          </Button>
        }
      >
        <div className="flex flex-col gap-4">{children}</div>
      </Modal>
    </div>
  );
}
