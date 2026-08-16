/**
 * EntityDetailLayout — the shell behind the five entity detail routes.
 *
 * `entities.$entityType.$partyId`, `entities.banks_.$bankId`, `locations_.$locationId`,
 * `departments_.$departmentId` and `accounts_/category/$categoryId` all rendered the same
 * hand-copied two-column shell: a `max-w-[1119px]` top bar over a `flex gap-6` body holding a
 * `max-w-[735px]` card and a fixed 360px side column. Five copies meant five places to fix, and
 * none of them worked below `lg` — the side column was `hidden lg:flex`, so its details, comments
 * and sharing controls were simply unreachable on a phone.
 *
 * This is a separate component from `EntitySplitLayout` rather than an extension of it. That one
 * is the *list* shell: a header slot over a 380px collapsible drawer that overlays the content
 * below `lg`, driven by its own open/closed state. This one is a detail canvas with a back
 * affordance and a passive metadata column. They share no slots, no state and no breakpoint
 * behaviour; folding them together would mean one component with two disjoint modes.
 *
 * See `internal-docs/architecture/responsive-ui.md` §2, §5, §6.
 */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Modal } from "../ui/Modal";
import { IconButton } from "../ui/Actions";

export interface EntityDetailBack {
  /** Always the accessible name, even when the text is truncated by a narrow bar. */
  label: string;
  /** Router destination. Supply this or `onClick`, not both. */
  to?: string;
  onClick?: () => void;
  /** Per-route accent for the hover state — each detail page has its own colour. */
  hoverClassName?: string;
}

export interface EntityDetailLayoutProps {
  back: EntityDetailBack;
  children: ReactNode;
  /**
   * Secondary metadata — identity fields, comments, sharing. A fixed column at `lg` and up; below
   * that it moves behind a toolbar button and presents as a sheet.
   */
  side?: ReactNode;
  /** Accessible name and sheet title for `side`. */
  sideTitle?: string;
  /** Route-owned: drops the main panel's max width so it fills the row. */
  isMaximized?: boolean;
  /** Renders `children` directly rather than inside the card. Used by the status shells below. */
  plain?: boolean;
}

export function EntityDetailLayout({
  back,
  children,
  side,
  sideTitle = "Details",
  isMaximized = false,
  plain = false,
}: EntityDetailLayoutProps) {
  const [sideOpen, setSideOpen] = useState(false);

  return (
    <div className="app-page-bg flex h-full flex-col overflow-hidden">
      {/* ── Top bar ── */}
      <div className="relative shrink-0">
        <div
          className={`mx-auto flex min-h-[65px] w-full items-center justify-between gap-2 px-3 py-3 sm:px-6 ${
            isMaximized ? "" : "max-w-[1119px]"
          }`}
        >
          <BackControl {...back} />

          {side && (
            <IconButton
              label={sideTitle}
              onClick={() => setSideOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={sideOpen}
              className="lg:hidden"
              icon={
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
              }
            />
          )}
        </div>
      </div>

      {/* ── Body: one column below `lg`, two at and above ── */}
      <div className="flex w-full min-h-0 flex-1 items-stretch justify-center gap-6 overflow-hidden px-3 pb-4 sm:px-6 sm:pb-6">
        <div
          className={
            plain
              ? "flex min-w-0 max-h-full flex-1 flex-col"
              : `relative flex min-w-0 max-h-full flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-app-card)] shadow-[0_4px_24px_rgba(0,0,0,0.08)] transition-all ${
                  isMaximized ? "" : "lg:max-w-[735px]"
                }`
          }
        >
          {children}
        </div>

        {side && (
          <div className="hidden w-[360px] max-w-[360px] min-w-[360px] shrink-0 lg:flex">
            {side}
          </div>
        )}
      </div>

      {/* Below `lg` the same panel is a sheet. `Modal` renders nothing while closed, so the
          side content is only ever mounted twice for as long as the sheet is open. */}
      {side && (
        <Modal
          open={sideOpen}
          onClose={() => setSideOpen(false)}
          title={sideTitle}
          mobile="sheet"
          size="sm"
          bodyClassName="p-0"
        >
          <div className="h-[62dvh] min-h-[320px]">{side}</div>
        </Modal>
      )}
    </div>
  );
}

function BackControl({ label, to, onClick, hoverClassName = "" }: EntityDetailBack) {
  const className = `-mx-2 inline-flex min-h-[44px] min-w-0 shrink items-center gap-1.5 rounded-lg border-none bg-transparent px-2 text-sm font-medium text-slate-700 no-underline transition-colors dark:text-slate-300 ${hoverClassName}`;

  const inner = (
    <>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden="true"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      <span className="truncate">{label}</span>
    </>
  );

  if (to) {
    return (
      <Link to={to as string & {}} aria-label={label} className={className}>
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`${className} cursor-pointer`}
    >
      {inner}
    </button>
  );
}

/**
 * Loading and not-found go through the same shell so the back affordance never disappears — a
 * detail route that 404s used to strand the user on a bare centred message with a text link.
 */
export function EntityDetailStatus({
  back,
  isMaximized,
  children,
}: {
  back: EntityDetailBack;
  isMaximized?: boolean;
  children: ReactNode;
}) {
  return (
    <EntityDetailLayout back={back} isMaximized={isMaximized} plain>
      <div className="flex flex-1 items-center justify-center px-4 text-center">{children}</div>
    </EntityDetailLayout>
  );
}

export function EntityDetailLoading({
  back,
  message,
}: {
  back: EntityDetailBack;
  message: string;
}) {
  return (
    <EntityDetailStatus back={back}>
      <div className="animate-pulse text-[#94a3b8] dark:text-slate-500">{message}</div>
    </EntityDetailStatus>
  );
}

export function EntityDetailNotFound({
  back,
  title,
  action,
}: {
  back: EntityDetailBack;
  title: string;
  /** The route's own recovery control, kept because it need not target the same place as `back`. */
  action?: { label: string; onClick: () => void; className?: string };
}) {
  return (
    <EntityDetailStatus back={back}>
      <div>
        <p className="text-lg font-semibold text-[#1e293b] dark:text-white">{title}</p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className={`mt-3 inline-flex min-h-[44px] items-center px-2 text-sm hover:underline ${
              action.className ?? "text-blue-600"
            }`}
          >
            {action.label}
          </button>
        )}
      </div>
    </EntityDetailStatus>
  );
}
