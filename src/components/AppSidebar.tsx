/**
 * AppSidebar — global navigation sidebar
 *
 * Theme-aware: adapts to light/dark/system theme via ThemeContext.
 * Includes an intuitive theme toggle in the bottom section.
 *
 * Behaviour:
 *  • Normal:       240px wide, icons + labels visible
 *  • Mini (collapsed): 60px wide, only icons — tooltip on hover
 *  • Floating expand: when collapsed and hovered, overlays at 240px
 */

import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTheme } from "./ThemeContext";
import type { ThemeMode } from "./ThemeContext";
import { signOut, useSession } from "../lib/auth-client";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { useActiveOrganization } from "../hooks/useActiveOrganization";
import { useIsCompactNav } from "../hooks/useBreakpoint";
import { useScrollLock } from "../hooks/useOverlayBehavior";

// ─── Nav Item Config ─────────────────────────────────────────────────────────

interface NavItem {
  icon: React.ReactNode;
  label: string;
  href?: string;
  badge?: number | string;
  children?: NavItem[];
  dividerLabel?: string;
}

const NAV_ITEMS: NavItem[] = [
  /* HUG-10: Home — hidden until dashboard is implemented
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
    label: "Home",
    href: "/",
  },
  */
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
    label: "Inbox",
    href: "/inbox",
  },
  {
    // Sits next to Inbox rather than inside Accounting: this page configures the checks that
    // produce Inbox findings, and its findings panel links back into the Inbox. Filing it as the
    // sixth child of a collapsible group put the configuration four clicks from its own output.
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
    label: "Review Agents",
    href: "/review-agents",
  },
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        <line x1="12" y1="6" x2="12" y2="18" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    ),
    label: "Accounting",
    children: [
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <line x1="12" y1="6" x2="12" y2="18" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        ),
        label: "Ledger",
        href: "/transactions",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 13h6m7 0h6M12 7v14m0-14a2.5 2.5 0 0 0 2.5-2.5M12 7a2.5 2.5 0 0 1-2.5-2.5M4 21h16M4 4.5h5.5m0 0a2.5 2.5 0 0 1 5 0m0 0H20M8.88 14.336C8.48 15.871 7.12 17 5.5 17s-2.98-1.13-3.38-2.664c-.033-.125-.05-.188-.05-.438a3 3 0 0 1 .105-.653c.08-.237.167-.371.34-.64L5.5 8l2.986 4.606c.173.268.26.402.34.639.05.145.107.5.106.653-.002.25-.018.313-.051.438m13 0C21.48 15.871 20.12 17 18.5 17s-2.98-1.13-3.38-2.664c-.033-.125-.05-.188-.05-.438-.002-.154.055-.508.105-.653.08-.237.167-.371.34-.64L18.5 8l2.986 4.606c.173.268.26.402.34.639.05.145.107.5.106.653-.002.25-.018.313-.051.438" />
          </svg>
        ),
        label: "Reconciliations",
        href: "/reconciliations",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
        ),
        label: "Category Manager",
        href: "/accounts",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 7V3m8 4V3M5 11h14M5 21h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" />
          </svg>
        ),
        label: "Payroll",
        href: "/payroll",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        ),
        label: "2307s",
        href: "/tax/certificates",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
          </svg>
        ),
        label: "Departments",
        href: "/departments",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
        ),
        label: "Locations",
        href: "/locations",
      },
    ],
  },
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    label: "Financials",
    href: "/financials",
  },
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="7" height="16" rx="1" />
        <rect x="14" y="8" width="7" height="12" rx="1" />
        <path d="M6.5 8h0M6.5 12h0M6.5 16h0M17.5 12h0M17.5 16h0" />
      </svg>
    ),
    label: "Business Groups",
    href: "/business-groups",
    badge: "Enterprise",
  },
  /* HUG-17: Custom Reports — hidden until implemented
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
    label: "Custom Reports",
  },
  */
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    label: "Bills",
    href: "/bills",
  },
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    label: "Invoices",
    href: "/invoices",
  },
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
    label: "Documents",
    href: "/documents",
  },
  {
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    label: "Entities",
    children: [
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
            <line x1="1" y1="10" x2="23" y2="10" />
          </svg>
        ),
        label: "Banks & Cards",
        href: "/entities/banks",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
        label: "Vendors",
        href: "/entities/vendors",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        ),
        label: "Customers",
        href: "/entities/customers",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        ),
        label: "Employees",
        href: "/entities/employees",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        ),
        label: "Shareholders",
        href: "/entities/shareholders",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="2" y1="10" x2="22" y2="10" />
          </svg>
        ),
        label: "Lenders",
        href: "/entities/lenders",
      },
      {
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 21h18" />
            <path d="M5 21V7l7-4 7 4v14" />
            <path d="M9 21v-4h6v4" />
            <path d="M9 10h1" />
            <path d="M14 10h1" />
            <path d="M9 14h1" />
            <path d="M14 14h1" />
          </svg>
        ),
        label: "Government",
        href: "/entities/government",
      },
    ],
  },
];

// ─── Theme Toggle Icons ──────────────────────────────────────────────────────

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

const THEME_OPTIONS: { mode: ThemeMode; icon: React.ReactNode; label: string }[] = [
  { mode: "light", icon: <SunIcon />, label: "Light" },
  { mode: "dark", icon: <MoonIcon />, label: "Dark" },
  { mode: "system", icon: <MonitorIcon />, label: "System" },
];

// ─── Component ───────────────────────────────────────────────────────────────

export interface AppSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: React.ReactNode;
}

export default function AppSidebar({ collapsed, onToggleCollapse, children }: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [hovered, setHovered] = useState(false);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    Entities: true,
    Accounting: true,
  });
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { data: session } = useSession();
  const { data: safeActiveOrg } = useActiveOrganization();
  const activeOrg = safeActiveOrg
    ? { id: safeActiveOrg.id, name: safeActiveOrg.name, slug: safeActiveOrg.slug ?? "" }
    : null;

  // Below `lg` the sidebar stops being furniture and becomes an overlay drawer. A 60px icon-only
  // rail is 16% of a 375px screen and, with twenty destinations and no labels, unlearnable — so
  // the compact branch always shows labels and always takes its width from the overlay, not the
  // layout.
  const compactNav = useIsCompactNav();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // A drawer that survives navigation hides the page the user just asked for.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useScrollLock(compactNav && drawerOpen);

  // Visual width of the sidebar rail
  const railWidth = collapsed ? 60 : 240;
  const showExpanded = compactNav ? drawerOpen : collapsed && hovered;
  const showLabels = compactNav ? true : !collapsed || showExpanded;
  const drawerWidth = 280;

  // Theme-aware color classes — use Tailwind dark: variants so the inline <script>
  // in <head> can set .dark before React hydrates, preventing FOUC.
  const sidebarBg = "bg-[#f8fafc] dark:bg-[#0f172a]";
  const borderColor = "border-[#e2e8f0] dark:border-white/10";
  const textPrimary = "text-[#1e293b] dark:text-white";
  const textSecondary = "text-[#64748b] dark:text-white/50";
  const textMuted = "text-[#94a3b8] dark:text-white/40";
  const activeItemBg = "bg-[#e2e8f0] dark:bg-white/10";
  const hoverItemBg = "hover:bg-[#f1f5f9] dark:hover:bg-teal-900/20";
  const hoverTextColor = "hover:text-[#1e293b] dark:hover:text-white";
  const mainBg = "bg-white dark:bg-[#0f172a]";

  return (
    // `h-dvh`, not `h-screen`: mobile browser chrome makes `100vh` taller than the visible
    // viewport, which pushes any pinned footer below the fold.
    <div className={`flex h-dvh overflow-hidden ${mainBg}`}>
      {/* Drawer backdrop — compact only. */}
      {compactNav && drawerOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 cursor-default border-0 bg-slate-900/50 backdrop-blur-[2px]"
        />
      )}

      {/* ── Sidebar rail ──────────────────────────────────── */}
      <div
        className={compactNav ? "fixed inset-y-0 left-0 z-50" : "shrink-0 relative"}
        style={compactNav ? { width: drawerWidth } : { width: railWidth }}
        onMouseEnter={() => !compactNav && collapsed && setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // A closed drawer is translated off-screen but still in the layer — without `inert` its
        // twenty links stay tabbable and screen-reader-visible behind the page.
        inert={compactNav && !drawerOpen}
      >
        <div
          className={`absolute inset-y-0 left-0 flex flex-col ${sidebarBg} overflow-y-auto overflow-x-hidden border-r ${borderColor} ${compactNav ? "pt-safe pb-safe" : ""}`}
          style={{
            width: compactNav ? drawerWidth : showExpanded ? 240 : railWidth,
            zIndex: showExpanded ? 50 : 1,
            transition: compactNav
              ? "transform 220ms cubic-bezier(0.4,0,0.2,1)"
              : "width 200ms cubic-bezier(0.4,0,0.2,1)",
            transform: compactNav && !drawerOpen ? "translateX(-100%)" : "translateX(0)",
            boxShadow: showExpanded ? "4px 0 24px rgba(0,0,0,0.15)" : "none",
          }}
        >
          {/* ── Brand / Org header ──── */}
          <div className={`flex items-center gap-3 px-2 py-4 border-b ${borderColor}`}>
            <div className="flex-1 min-w-0">
              <OrganizationSwitcher collapsed={!showLabels} activeOrg={activeOrg} />
            </div>
            <button
              type="button"
              onClick={onToggleCollapse}
              className={`w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded flex items-center justify-center ${textMuted} hover:${textPrimary} ${hoverItemBg} transition-colors shrink-0 mr-2`}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  transform: collapsed && !showExpanded ? "rotate(180deg)" : "none",
                  transition: "transform 200ms",
                }}
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </div>

          {/* ── Navigation items ──── */}
          <nav className="flex-1 py-1.5 flex flex-col gap-0.5">
            {NAV_ITEMS.map((item) =>
              item.children ? (
                <SectionItem
                  key={item.label}
                  item={item}
                  pathname={pathname}
                  mini={!showLabels}
                  isOpen={openSections[item.label] ?? true}
                  onToggle={() =>
                    setOpenSections((prev) => ({
                      ...prev,
                      [item.label]: !(prev[item.label] ?? true),
                    }))
                  }
                  activeItemBg={activeItemBg}
                  hoverItemBg={hoverItemBg}
                  hoverTextColor={hoverTextColor}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                />
              ) : (
                <NavLink
                  key={item.label}
                  item={item}
                  pathname={pathname}
                  mini={!showLabels}
                  activeItemBg={activeItemBg}
                  hoverItemBg={hoverItemBg}
                  hoverTextColor={hoverTextColor}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                />
              ),
            )}
          </nav>

          {/* ── User profile ──── */}
          <Link
            to="/profile"
            className={`flex items-center ${showLabels ? "gap-2.5 px-4" : "justify-center px-0"} py-3 border-t ${borderColor} cursor-pointer transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/5 no-underline`}
            style={{ textDecoration: "none" }}
          >
            {session?.user?.image ? (
              <img
                src={session.user.image}
                alt=""
                className="w-8 h-8 rounded-full shrink-0 object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-[#6366f1] to-[#4f46e5] text-white text-[11px] font-bold`}
              >
                {(
                  session?.user?.name?.charAt(0) ||
                  session?.user?.email?.charAt(0) ||
                  "?"
                ).toUpperCase()}
              </div>
            )}
            {showLabels && (
              <div className="flex-1 min-w-0 overflow-hidden">
                <div className={`text-[12px] font-medium ${textPrimary} truncate`}>
                  {session?.user?.name ?? "User"}
                </div>
                <div className={`text-[10px] ${textMuted} truncate`}>
                  {session?.user?.email ?? ""}
                </div>
              </div>
            )}
          </Link>

          {/* ── Theme Switcher ──── */}
          <div className={`border-t ${borderColor} px-2 py-2`}>
            {showLabels ? (
              /* Expanded: 3-segment pill toggle */
              <div className={`flex items-center rounded-lg p-0.5 bg-[#e2e8f0] dark:bg-white/10`}>
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    type="button"
                    onClick={() => setThemeMode(opt.mode)}
                    className={`flex min-h-10 lg:min-h-0 flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-all duration-150 ${
                      themeMode === opt.mode
                        ? "bg-white dark:bg-white/15 text-[#1e293b] dark:text-white shadow-sm"
                        : "text-[#64748b] dark:text-white/40 hover:text-[#1e293b] dark:hover:text-white/70"
                    }`}
                    title={opt.label}
                  >
                    {opt.icon}
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              /* Collapsed: single icon button that cycles */
              <button
                type="button"
                onClick={() => {
                  const next: ThemeMode =
                    themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light";
                  setThemeMode(next);
                }}
                className={`w-full flex items-center justify-center py-2 rounded-lg ${textMuted} ${hoverItemBg} transition-colors`}
                title={`Theme: ${themeMode}`}
              >
                {themeMode === "light" ? (
                  <SunIcon />
                ) : themeMode === "dark" ? (
                  <MoonIcon />
                ) : (
                  <MonitorIcon />
                )}
              </button>
            )}
          </div>

          {/* ── Bottom section ──── */}
          <div className={`border-t ${borderColor} py-2`}>
            <Link
              to={
                activeOrg?.id
                  ? (`/organization/${activeOrg.id}/settings` as string & {})
                  : ("/settings" as string & {})
              }
              className={`flex min-h-11 lg:min-h-0 items-center gap-3 w-full px-4 py-2 no-underline transition-colors ${
                pathname.includes("/settings")
                  ? `${textPrimary}`
                  : `${textMuted} hover:text-[#1e293b] dark:hover:text-white`
              } ${hoverItemBg}`}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </span>
              {showLabels && <span className="text-[13px] truncate">Settings</span>}
            </Link>
            <Link
              to={
                activeOrg?.id
                  ? (`/organization/${activeOrg.id}/connections` as string & {})
                  : ("/connections" as string & {})
              }
              className={`flex min-h-11 lg:min-h-0 items-center gap-3 w-full px-4 py-2 no-underline transition-colors ${
                pathname.includes("/connections")
                  ? `${textPrimary}`
                  : `${textMuted} hover:text-[#1e293b] dark:hover:text-white`
              } ${hoverItemBg}`}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </span>
              {showLabels && <span className="text-[13px] truncate">Connections</span>}
            </Link>
            <Link
              to={
                activeOrg?.id
                  ? (`/organization/${activeOrg.id}/mappings` as string & {})
                  : ("/mappings" as string & {})
              }
              className={`flex min-h-11 lg:min-h-0 items-center gap-3 w-full px-4 py-2 no-underline transition-colors ${
                pathname.includes("/mappings")
                  ? `${textPrimary}`
                  : `${textMuted} hover:text-[#1e293b] dark:hover:text-white`
              } ${hoverItemBg}`}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M16 3h5v5" />
                  <path d="M8 3H3v5" />
                  <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
                  <path d="m15 9 6-6" />
                </svg>
              </span>
              {showLabels && <span className="text-[13px] truncate">Mappings</span>}
            </Link>
            <a
              href="https://docs.mvgreenland.com"
              target="_blank"
              rel="noreferrer"
              className={`flex min-h-11 lg:min-h-0 items-center gap-3 w-full px-4 py-2 no-underline transition-colors ${textMuted} hover:${textSecondary}`}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </span>
              {showLabels && <span className="text-[13px] truncate">Documentation</span>}
            </a>
            <button
              type="button"
              onClick={() => {
                signOut().then(() => {
                  window.location.href = "/login";
                });
              }}
              className={`flex min-h-11 lg:min-h-0 items-center gap-3 w-full px-4 py-2 ${textMuted} hover:text-[#ef4444] dark:hover:text-red-400 hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-colors`}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </span>
              {showLabels && <span className="text-[13px] truncate">Sign Out</span>}
            </button>
          </div>
        </div>
      </div>

      {/* ── Main page content ────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {compactNav && (
          <MobileAppBar
            orgName={activeOrg?.name ?? null}
            onOpenNav={() => setDrawerOpen(true)}
            borderColor={borderColor}
            textPrimary={textPrimary}
          />
        )}

        {/* `min-h-0` is what lets this scroll instead of stretching its flex parent. */}
        <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-y-auto">{children}</div>

        {compactNav && <BottomTabBar pathname={pathname} borderColor={borderColor} />}
      </div>
    </div>
  );
}

// ─── Mobile chrome ───────────────────────────────────────────────────────────

/**
 * The compact top bar. Exists only to give the drawer a trigger and to keep the active
 * organization visible — on desktop both live inside the sidebar, which is off-screen here.
 */
function MobileAppBar({
  orgName,
  onOpenNav,
  borderColor,
  textPrimary,
}: {
  orgName: string | null;
  onOpenNav: () => void;
  borderColor: string;
  textPrimary: string;
}) {
  return (
    <header
      className={`pt-safe shrink-0 border-b ${borderColor} bg-white/95 backdrop-blur dark:bg-[#0f172a]/95`}
    >
      <div className="flex h-14 items-center gap-2 px-2">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          aria-haspopup="dialog"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${textPrimary} transition-colors hover:bg-slate-100 dark:hover:bg-white/10`}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${textPrimary}`}>
          {orgName ?? "Buwiz Books"}
        </span>
      </div>
    </header>
  );
}

/**
 * Bottom tab bar for the destinations that carry the most traffic.
 *
 * Five is the ceiling — past that the targets fall under 44px on a 375px screen. Everything else
 * stays in the drawer, which "More" opens rather than duplicating a second nav surface.
 */
const TAB_ITEMS: Array<{ label: string; href: string; icon: React.ReactNode }> = [
  {
    label: "Inbox",
    href: "/inbox",
    icon: (
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
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
  },
  {
    label: "Ledger",
    href: "/transactions",
    icon: (
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
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  {
    label: "Invoices",
    href: "/invoices",
    icon: (
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
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
  },
  {
    label: "Bills",
    href: "/bills",
    icon: (
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
        <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2V2l-3 2-3-2-3 2-3-2z" />
        <path d="M8 9h8M8 13h6" />
      </svg>
    ),
  },
  {
    label: "Reports",
    href: "/financials",
    icon: (
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
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
];

function BottomTabBar({ pathname, borderColor }: { pathname: string; borderColor: string }) {
  return (
    <nav
      aria-label="Primary"
      className={`pb-safe shrink-0 border-t ${borderColor} bg-white/95 backdrop-blur dark:bg-[#0f172a]/95`}
    >
      <ul className="flex items-stretch">
        {TAB_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="flex-1">
              <Link
                to={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 no-underline transition-colors ${
                  active ? "text-teal-600 dark:text-teal-400" : "text-slate-500 dark:text-white/50"
                }`}
              >
                {item.icon}
                <span className="text-[11px] leading-none font-medium">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Nav Link ────────────────────────────────────────────────────────────────

function NavLink({
  item,
  pathname,
  mini,
  indent = false,
  activeItemBg,
  hoverItemBg,
  hoverTextColor,
  textPrimary,
  textSecondary,
}: {
  item: NavItem;
  pathname: string;
  mini: boolean;
  indent?: boolean;
  activeItemBg: string;
  hoverItemBg: string;
  hoverTextColor: string;
  textPrimary: string;
  textSecondary: string;
}) {
  const active = item.href ? pathname === item.href || pathname.startsWith(item.href + "/") : false;

  const content = (
    <div
      // 44px rows below `lg`, where this list is the drawer and gets thumbed rather than
      // clicked; desktop keeps its original density.
      className={`group mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg transition-colors lg:min-h-0 ${
        indent ? "py-1.5 pr-3 pl-9" : "px-3 py-2"
      } ${
        active
          ? `${activeItemBg} ${textPrimary}`
          : `${textSecondary} ${hoverTextColor} ${hoverItemBg}`
      }`}
      title={mini ? item.label : undefined}
    >
      <span className="w-5 h-5 flex items-center justify-center shrink-0">{item.icon}</span>
      {!mini && (
        <>
          <span className="text-[13px] font-medium truncate flex-1">{item.label}</span>
          {item.badge != null && (typeof item.badge === "string" || item.badge > 0) && (
            <span className="min-w-[18px] h-[18px] rounded-full bg-emerald-700 text-white text-[9px] font-semibold flex items-center justify-center px-1.5">
              {item.badge}
            </span>
          )}
        </>
      )}
    </div>
  );

  if (item.href) {
    return (
      <Link to={item.href as string & {}} className="no-underline">
        {content}
      </Link>
    );
  }
  return content;
}

// ─── Section (e.g. Accounting) ───────────────────────────────────────────────

function SectionItem({
  item,
  pathname,
  mini,
  isOpen,
  onToggle,
  activeItemBg,
  hoverItemBg,
  hoverTextColor,
  textPrimary,
  textSecondary,
}: {
  item: NavItem;
  pathname: string;
  mini: boolean;
  isOpen: boolean;
  onToggle: () => void;
  activeItemBg: string;
  hoverItemBg: string;
  hoverTextColor: string;
  textPrimary: string;
  textSecondary: string;
}) {
  const anyChildActive = item.children?.some(
    (c) => c.href && (pathname === c.href || pathname.startsWith(c.href + "/")),
  );

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`flex min-h-11 lg:min-h-0 items-center gap-3 w-full mx-2 rounded-lg transition-colors cursor-pointer px-3 py-2 ${
          anyChildActive ? textPrimary : `${textSecondary} ${hoverTextColor} ${hoverItemBg}`
        }`}
        title={mini ? item.label : undefined}
        style={{ width: "calc(100% - 16px)" }}
      >
        <span className="w-5 h-5 flex items-center justify-center shrink-0">{item.icon}</span>
        {!mini && (
          <>
            <span className="text-[13px] font-medium truncate flex-1 text-left">{item.label}</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 transition-transform"
              style={{ transform: isOpen ? "rotate(180deg)" : "none" }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </>
        )}
      </button>

      {!mini && isOpen && item.children && (
        <div className="mt-0.5">
          {item.children.map((child) => (
            <div key={child.label}>
              {child.dividerLabel && (
                <div
                  className={`px-7 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider ${textSecondary}`}
                >
                  {child.dividerLabel}
                </div>
              )}
              <NavLink
                item={child}
                pathname={pathname}
                mini={false}
                indent
                activeItemBg={activeItemBg}
                hoverItemBg={hoverItemBg}
                hoverTextColor={hoverTextColor}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
