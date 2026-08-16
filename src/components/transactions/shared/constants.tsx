/**
 * Shared constants for transaction forms (New + Detail pages)
 */
import { ICON_PATHS } from "../../accounts/icons";
import type { TabType } from "./types";

// ============================================================================
// Style constants
// ============================================================================

export const inputClass =
  "w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-[#1e293b] dark:text-slate-200 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:border-[var(--color-app-header-teal)] focus:ring-1 focus:ring-[var(--color-app-header-teal)] transition-colors";

export const labelClass =
  "flex items-center gap-1.5 text-xs font-semibold text-[#475569] dark:text-slate-400 mb-2";

// ============================================================================
// Combobox placeholder icons
// ============================================================================

function iconNode(name: string): React.ReactNode {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 opacity-50"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

export const CATEGORY_ICON = iconNode("Award03");
export const PARTY_ICON = iconNode("Consultant");
export const DEPARTMENT_ICON = iconNode("Operations");
export const LOCATION_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 opacity-50"
  >
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

export const CategoryIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

// ============================================================================
// Tab definitions (for the "new" page left sidebar)
// ============================================================================

export const TABS: { id: TabType; label: string; icon: React.ReactNode }[] = [
  {
    id: "journal",
    label: "Journal",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        dangerouslySetInnerHTML={{ __html: ICON_PATHS.Journal }}
      />
    ),
  },
  {
    id: "pay_in",
    label: "Pay In",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        dangerouslySetInnerHTML={{ __html: ICON_PATHS.CoinsHand }}
      />
    ),
  },
  {
    id: "pay_out",
    label: "Pay Out",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        dangerouslySetInnerHTML={{ __html: ICON_PATHS.CoinsHand02 }}
      />
    ),
  },
  {
    id: "transfer",
    label: "Transfer",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        dangerouslySetInnerHTML={{ __html: ICON_PATHS.ArrowSwitch }}
      />
    ),
  },
];

// ============================================================================
// Label maps
// ============================================================================

export const TYPE_LABELS: Record<string, string> = {
  pay_in: "Pay In",
  pay_out: "Pay Out",
  journal: "Journal Entry",
  transfer: "Transfer",
};

export const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-amber-100 dark:bg-amber-900/30", text: "text-amber-700 dark:text-amber-300" },
  posted: {
    bg: "bg-emerald-100 dark:bg-emerald-900/30",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  voided: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-700 dark:text-red-300" },
};
