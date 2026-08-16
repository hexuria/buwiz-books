import React, { useMemo } from "react";
import { useTheme } from "../ThemeContext";
import { iconLibrary, renderIconSvg } from "./CategoryForm";

// ============================================================================
// Types
// ============================================================================

export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense"
  | "cost_of_revenue"
  | "other_income"
  | "other_expense";

export interface CategoryRowProps {
  id: string;
  name: string;
  accountNumber?: string | null;
  description?: string | null;
  accountType: AccountType;
  icon?: string | null;
  level: number;
  isSelected?: boolean;
  isExpanded?: boolean;
  hasChildren?: boolean;
  connections?: Array<{ name: string; logoUrl?: string }>;
  onClick?: (id: string) => void;
  onToggle?: (id: string) => void;
  onEdit?: (id: string) => void;
  onAddChild?: (id: string) => void;
  onNavigate?: (id: string) => void;
}

// ============================================================================
// Color Mapping
// ============================================================================

const typeColors: Record<
  AccountType,
  { bg: string; darkBg: string; icon: string; darkIcon: string }
> = {
  asset: { bg: "#e8f5e9", darkBg: "#1b3a2a", icon: "#2e7d32", darkIcon: "#66bb6a" },
  liability: { bg: "#fce4ec", darkBg: "#3a1a24", icon: "#c62828", darkIcon: "#ef5350" },
  equity: { bg: "#e3f2fd", darkBg: "#1a2a3d", icon: "#1565c0", darkIcon: "#42a5f5" },
  revenue: { bg: "#e8f5e9", darkBg: "#1b3a2a", icon: "#2e7d32", darkIcon: "#66bb6a" },
  expense: { bg: "#fff3e0", darkBg: "#3a2a1a", icon: "#e65100", darkIcon: "#ff9800" },
  cost_of_revenue: { bg: "#fff3e0", darkBg: "#3a2a1a", icon: "#e65100", darkIcon: "#ff9800" },
  other_income: { bg: "#e0f2f1", darkBg: "#1a332f", icon: "#00695c", darkIcon: "#4db6ac" },
  other_expense: { bg: "#fce4ec", darkBg: "#3a1a24", icon: "#c62828", darkIcon: "#ef5350" },
};

// ============================================================================
// Icon Mapping (SVG icons per type)
// ============================================================================

const typeIcons: Record<AccountType, React.ReactNode> = {
  asset: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  ),
  liability: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
    </svg>
  ),
  equity: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M3 3v18h18" />
      <path d="M7 16l4-8 4 5 5-6" />
    </svg>
  ),
  revenue: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  ),
  expense: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  ),
  cost_of_revenue: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    </svg>
  ),
  other_income: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  ),
  other_expense: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8l-8 8" />
      <path d="M8 8l8 8" />
    </svg>
  ),
};

// ============================================================================
// Sub-Components
// ============================================================================

const ConnectionBadges: React.FC<{ connections: CategoryRowProps["connections"] }> = ({
  connections = [],
}) => {
  if (!connections.length) return null;
  return (
    <div className="flex items-center shrink-0">
      {connections.slice(0, 3).map((conn, idx) => (
        <div
          key={idx}
          className={`w-7 h-7 rounded-full border-2 border-white bg-gray-200 flex items-center justify-center text-[0.625rem] font-semibold text-[#6b7c93] ${idx === 0 ? "" : "-ml-1.5"}`}
          title={conn.name}
        >
          {conn.logoUrl ? (
            <img
              src={conn.logoUrl}
              alt={conn.name}
              className="w-full h-full object-cover rounded-full"
            />
          ) : (
            conn.name.charAt(0).toUpperCase()
          )}
        </div>
      ))}
      {connections.length > 3 && (
        <div className="w-7 h-7 rounded-full border-2 border-white bg-gray-200 flex items-center justify-center -ml-1.5 text-[0.625rem] font-semibold text-[#6b7c93]">
          +{connections.length - 3}
        </div>
      )}
    </div>
  );
};

const ActionButtons: React.FC<{
  id: string;
  isSelected?: boolean;
  onEdit?: (id: string) => void;
  onAddChild?: (id: string) => void;
  onNavigate?: (id: string) => void;
}> = ({ id, onEdit, onAddChild, onNavigate, isSelected }) => (
  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
    {onAddChild && (
      <button
        className="w-9 h-9 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-slate-500 dark:text-slate-300 transition-all hover:bg-slate-200/60 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          onAddChild(id);
        }}
        type="button"
        title="Add child category"
      >
        {/* GitBranch01 icon */}
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
          <path d="M3 3v10.2c0 1.68 0 2.52.327 3.162a3 3 0 001.311 1.311C5.28 18 6.12 18 7.8 18H15m0 0a3 3 0 106 0 3 3 0 00-6 0M3 8h12m0 0a3 3 0 106 0 3 3 0 00-6 0" />
        </svg>
      </button>
    )}
    {onEdit && (
      <button
        className="w-9 h-9 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-slate-500 dark:text-slate-300 transition-all hover:bg-slate-200/60 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(id);
        }}
        type="button"
        title="Edit category"
      >
        {/* Pencil01 icon */}
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
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
    )}
    {/* Navigate icon — chevron when unselected, arrow-up-right when selected */}
    <button
      className="w-9 h-9 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-slate-500 dark:text-slate-300 transition-all hover:bg-slate-200/60 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-white opacity-0 group-hover:opacity-70"
      onClick={(e) => {
        e.stopPropagation();
        onNavigate?.(id);
      }}
      type="button"
      title={isSelected ? "View details" : "View category"}
    >
      {isSelected ? (
        /* Arrow-up-right — diagonal icon for "go to detail page" */
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
          <path d="M7 17L17 7" />
          <path d="M7 7h10v10" />
        </svg>
      ) : (
        /* ChevronRight icon */
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
          <path d="M9 18l6-6-6-6" />
        </svg>
      )}
    </button>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const CategoryRow: React.FC<CategoryRowProps> = ({
  id,
  name,
  accountNumber,
  description,
  accountType,
  icon,
  level,
  isSelected = false,
  isExpanded = false,
  hasChildren = false,
  connections = [],
  onClick,
  onToggle,
  onEdit,
  onAddChild,
  onNavigate,
}) => {
  const handleRowClick = () => onClick?.(id);

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle?.(id);
  };

  const { resolved } = useTheme();
  const isDark = resolved === "dark";
  const colors = typeColors[accountType] || typeColors.asset;
  const iconBg = isDark ? colors.darkBg : colors.bg;
  const iconColor = isDark ? colors.darkIcon : colors.icon;

  // Look up a custom icon from the shared library; fall back to default type icon
  const renderedIcon = useMemo(() => {
    if (icon) {
      const match = iconLibrary.find((i) => i.id === icon);
      if (match) {
        // Wrap in a container that scales to 18px to match tree row sizing
        return (
          <span style={{ display: "inline-flex", width: 18, height: 18, transform: "scale(0.9)" }}>
            {renderIconSvg(match.id, 18)}
          </span>
        );
      }
    }
    return typeIcons[accountType] || typeIcons.asset;
  }, [icon, accountType]);

  return (
    <div
      className={`group grid grid-cols-12 items-center py-3 px-4 cursor-pointer transition-colors border-b border-[#f0f1f3] dark:border-slate-700 hover:bg-[#f8f9fb] dark:hover:bg-slate-800 ${isSelected ? "bg-[#e8f4fe] dark:bg-slate-700" : ""}`}
      style={{ paddingLeft: `${16 + level * 24}px` }}
      onClick={handleRowClick}
    >
      {/* Column 1: Category — 9/12 on mobile, 6/12 once Connections reappears at `sm` */}
      <div className="col-span-9 flex min-w-0 items-center gap-3 sm:col-span-6">
        {/* Icon Box — doubles as expand/collapse toggle */}
        {hasChildren ? (
          <button
            type="button"
            className="w-9 h-9 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-lg flex items-center justify-center shrink-0 text-base border-none cursor-pointer"
            style={{ backgroundColor: iconBg, color: iconColor }}
            onClick={handleToggleClick}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <>
                {/* Expanded: show icon by default, chevron-down on hover */}
                <span className="group-hover:hidden">{renderedIcon}</span>
                <span className="hidden group-hover:flex items-center justify-center">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
              </>
            ) : (
              /* Collapsed: always show chevron-right */
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
          </button>
        ) : (
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-base"
            style={{ backgroundColor: iconBg, color: iconColor }}
          >
            {renderedIcon}
          </div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div>
            <span className="font-semibold text-[var(--color-app-text-navy)] text-[0.9375rem]">
              {name}
            </span>
            {accountNumber && (
              <span className="font-normal text-[var(--color-app-text-light)] text-[0.8125rem] ml-2">
                {accountNumber}
              </span>
            )}
          </div>
          {description && (
            <div className="text-[0.8125rem] text-[var(--color-app-text-light)] truncate mt-0.5">
              {description}
            </div>
          )}
        </div>
      </div>

      {/* Column 2: Connections — dropped below `sm`; still shown on the category detail page. */}
      <div className="hidden justify-center sm:col-span-3 sm:flex">
        <ConnectionBadges connections={connections} />
      </div>

      {/* Column 3: Actions (3 cols) */}
      <div className="col-span-3 flex justify-end">
        <ActionButtons
          id={id}
          isSelected={isSelected}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
};

export default CategoryRow;
