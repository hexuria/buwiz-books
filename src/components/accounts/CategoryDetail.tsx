import React from "react";
import type { AccountType } from "./CategoryRow";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Types
// ============================================================================

interface CategoryDetailProps {
  id: string;
  name: string;
  accountNumber?: string | null;
  description?: string | null;
  accountType: AccountType;
  parentName?: string | null;
  balance?: number;
  connections?: Array<{ name: string; logoUrl?: string }>;
  isSystem?: boolean;
  isRootCategory?: boolean;
  hasTransactions?: boolean;
  transactionCount?: number;
  onEdit?: () => void;
  onAddChild?: () => void;
  onDelete?: () => void;
  onClose?: () => void;
}

// ============================================================================
// Icon Mapping
// ============================================================================

const typeIcons: Record<AccountType, React.ReactNode> = {
  asset: (
    <svg
      width="24"
      height="24"
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
      width="24"
      height="24"
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
      width="24"
      height="24"
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
      width="24"
      height="24"
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
      width="24"
      height="24"
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
      width="24"
      height="24"
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
      width="24"
      height="24"
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
      width="24"
      height="24"
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
// Simple Chart Component (Mock)
// ============================================================================

const SimpleLineChart: React.FC<{ positive?: boolean }> = ({ positive = true }) => {
  const pathData = positive
    ? "M0,80 Q40,75 80,60 T160,40 T240,20 T300,10"
    : "M0,20 Q40,30 80,45 T160,60 T240,75 T300,80";

  return (
    <svg viewBox="0 0 300 100" className="w-full h-20">
      <defs>
        <linearGradient id="chartGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={positive ? "#2a9d8f" : "#ef4444"} stopOpacity="0.3" />
          <stop offset="100%" stopColor={positive ? "#2a9d8f" : "#ef4444"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${pathData} L300,100 L0,100 Z`} fill="url(#chartGradient)" />
      <path d={pathData} fill="none" stroke={positive ? "#2a9d8f" : "#ef4444"} strokeWidth="2" />
      <circle cx="300" cy={positive ? 10 : 80} r="4" fill={positive ? "#2a9d8f" : "#ef4444"} />
    </svg>
  );
};

// ============================================================================
// Component
// ============================================================================

export const CategoryDetail: React.FC<CategoryDetailProps> = ({
  name,
  accountNumber,
  description,
  accountType,
  parentName,
  balance = 0,
  connections = [],
  isSystem = false,
  isRootCategory = false,
  hasTransactions = false,
  transactionCount = 0,
  onEdit,
  onAddChild,
  onDelete,
}) => {
  const currentMonth = new Date().toLocaleString("default", { month: "long", year: "numeric" });

  return (
    <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-full lg:w-[360px] shrink-0 lg:min-h-[684px] flex flex-col">
      {/* Top Icon — centered, smaller */}
      <div className="flex justify-center pt-5 pb-3 bg-[var(--color-app-header-teal)]">
        <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-transparent flex items-center justify-center text-[#6b7c93] dark:text-white">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <line x1="10" y1="9" x2="8" y2="9" />
          </svg>
        </div>
      </div>

      {/* Header Card */}
      <div className="relative px-5 pt-6 pb-4">
        {/* Action buttons — absolutely positioned so they don't steal name width */}
        <div className="absolute top-3 right-5 flex items-center gap-1">
          {onAddChild && (
            <button
              className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#6b7c93] dark:text-slate-400 transition-all hover:bg-[rgba(50,73,127,0.08)] dark:hover:bg-slate-700 hover:text-[#32497f] dark:hover:text-slate-200"
              onClick={onAddChild}
              title="Add child category"
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
              >
                <path d="M3 3v10.2c0 1.68 0 2.52.327 3.162a3 3 0 001.311 1.311C5.28 18 6.12 18 7.8 18H15m0 0a3 3 0 106 0 3 3 0 00-6 0M3 8h12m0 0a3 3 0 106 0 3 3 0 00-6 0" />
              </svg>
            </button>
          )}
          {onEdit && (
            <button
              className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#6b7c93] dark:text-slate-400 transition-all hover:bg-[rgba(50,73,127,0.08)] dark:hover:bg-slate-700 hover:text-[#32497f] dark:hover:text-slate-200"
              onClick={onEdit}
              title="Edit"
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
              >
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
          {onDelete && !isSystem && !isRootCategory && (
            <button
              className={`w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full flex items-center justify-center bg-transparent border-none transition-all ${
                hasTransactions
                  ? "text-gray-300 dark:text-slate-600 cursor-not-allowed"
                  : "text-red-400 cursor-pointer hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500"
              }`}
              onClick={hasTransactions ? undefined : onDelete}
              title={
                hasTransactions
                  ? `Cannot delete — ${transactionCount} transaction${transactionCount !== 1 ? "s" : ""} exist`
                  : "Delete"
              }
              disabled={hasTransactions}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>

        {/* Icon + Text block */}
        <div className="flex items-start gap-3 pr-16">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center bg-[var(--color-app-header-teal)] text-white shrink-0 ${accountType}`}
          >
            <div className="scale-75">{typeIcons[accountType]}</div>
          </div>
          <div className="flex-1 min-w-0">
            {/* Parent name */}
            {parentName && (
              <div className="text-xs text-[var(--color-app-header-teal)] font-medium leading-tight">
                {parentName}
              </div>
            )}
            {/* Category name */}
            <div className="text-lg font-bold text-[var(--color-app-text-navy)] leading-snug">
              {name}
            </div>
            {/* Account number below name */}
            {accountNumber && (
              <div className="text-xs text-[var(--color-app-text-light)] mt-0.5">
                {accountNumber}
              </div>
            )}
          </div>
        </div>

        {/* Description — full width below the header */}
        {description && (
          <p className="text-sm text-[#6b7c93] mt-3 leading-relaxed">{description}</p>
        )}
      </div>

      {/* Activity / Chart Section */}
      <div className="mx-4 mb-4 bg-[#f5f7fb] dark:bg-slate-800 rounded-xl p-4 flex-1 flex flex-col">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-app-text-navy)]">
          <div className="scale-75 origin-left">{typeIcons[accountType]}</div>
          <span>{name}</span>
        </div>
        <div className="text-xs text-[var(--color-app-text-light)] mt-0.5">{currentMonth}</div>

        {hasTransactions ? (
          <div className="mt-3 flex-1">
            <div className="flex items-center justify-end mb-2">
              <span className="text-xl font-bold text-[var(--color-app-text-navy)]">
                {formatCurrency(balance)}
              </span>
            </div>
            <SimpleLineChart positive={balance >= 0} />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-lg text-gray-300 font-medium select-none">No Activity</span>
          </div>
        )}
      </div>

      {/* Connections */}
      {connections.length > 0 && (
        <div className="p-4 px-5 border-t border-gray-200">
          <div className="text-sm font-semibold text-[#32497f] mb-3">Connections</div>
          {connections.map((conn, idx) => (
            <div
              key={idx}
              className={`flex items-center gap-3 py-2 ${idx < connections.length - 1 ? "border-b border-gray-200" : ""}`}
            >
              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-semibold text-[#6b7c93]">
                {conn.logoUrl ? (
                  <img src={conn.logoUrl} alt={conn.name} className="w-full h-full rounded-full" />
                ) : (
                  conn.name.charAt(0).toUpperCase()
                )}
              </div>
              <span className="text-sm text-[#32497f]">{conn.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Filter by Type Panel (when no category is selected)
// ============================================================================

const filterTypeItems: Array<{
  type: AccountType;
  label: string;
  bg: string;
  color: string;
  icon: React.ReactNode;
}> = [
  {
    type: "asset",
    label: "Asset",
    bg: "#e8f5e9",
    color: "#2e7d32",
    icon: (
      <svg
        width="28"
        height="28"
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
  },
  {
    type: "revenue",
    label: "Revenue",
    bg: "#e8f5e9",
    color: "#2e7d32",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
      </svg>
    ),
  },
  {
    type: "other_income",
    label: "Other Income",
    bg: "#e0f2f1",
    color: "#00695c",
    icon: (
      <svg
        width="28"
        height="28"
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
  },
  {
    type: "liability",
    label: "Liability",
    bg: "#fce4ec",
    color: "#c62828",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
        <rect x="9" y="3" width="6" height="4" rx="1" />
      </svg>
    ),
  },
  {
    type: "expense",
    label: "Operating Expenses",
    bg: "#fff3e0",
    color: "#e65100",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  {
    type: "other_expense",
    label: "Other Expenses",
    bg: "#fce4ec",
    color: "#c62828",
    icon: (
      <svg
        width="28"
        height="28"
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
  },
  {
    type: "equity",
    label: "Equity",
    bg: "#e3f2fd",
    color: "#1565c0",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M3 3v18h18" />
        <path d="M7 16l4-8 4 5 5-6" />
      </svg>
    ),
  },
  {
    type: "cost_of_revenue",
    label: "Cost of Revenue",
    bg: "#fff3e0",
    color: "#e65100",
    icon: (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      </svg>
    ),
  },
];

export const CategoryDetailEmpty: React.FC<{
  onTypeClick?: (type: AccountType) => void;
  activeTypes?: AccountType[];
}> = ({ onTypeClick, activeTypes = [] }) => (
  <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-[360px] shrink-0">
    {/* Header */}
    <div className="bg-[var(--color-app-header-teal)] text-white px-5 py-4 flex items-center gap-3 font-semibold text-base rounded-t-xl">
      <span className="font-semibold">Filter by Type</span>
    </div>

    {/* Type Grid */}
    <div className="grid grid-cols-3 gap-4 p-6">
      {filterTypeItems.map((item) => {
        const isActive = activeTypes.includes(item.type);
        return (
          <div
            key={item.type}
            onClick={() => onTypeClick?.(item.type)}
            className="flex flex-col items-center gap-2 cursor-pointer"
          >
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center transition-transform duration-150"
              style={{
                backgroundColor: isActive ? item.bg : "var(--color-app-filter-idle, #f0f2f5)",
                color: isActive ? item.color : "#9ca3af",
                border: isActive ? `2.5px solid ${item.color}` : "2.5px solid transparent",
                boxShadow: isActive ? `0 2px 8px ${item.color}33` : "none",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "scale(1.08)";
                if (!isActive) {
                  e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.1)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "scale(1)";
                if (!isActive) {
                  e.currentTarget.style.boxShadow = "none";
                }
              }}
            >
              {item.icon}
            </div>
            <span
              className="text-[0.7rem] text-center leading-tight"
              style={{
                color: isActive ? item.color : "#6b7c93",
                fontWeight: isActive ? 700 : 500,
              }}
            >
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  </div>
);

export default CategoryDetail;
