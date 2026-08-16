/**
 * PartyCard — Compact card for vendor/customer display in list views
 */

import type { PartyRecord } from "../../routes/api/-parties";

// ============================================================================
// Helpers
// ============================================================================

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function getAvatarColor(name: string): string {
  const colors = [
    "#10b981",
    "#ec4899",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ef4444",
    "#14b8a6",
    "#f97316",
    "#06b6d4",
  ];
  let hash = 0;
  for (const c of name) hash = hash + c.charCodeAt(0);
  return colors[hash % colors.length];
}

// ============================================================================
// Component
// ============================================================================

interface PartyCardProps {
  party: PartyRecord;
  isSelected: boolean;
  onClick: () => void;
}

export function PartyCard({ party, isSelected, onClick }: PartyCardProps) {
  const initial = getInitial(party.name);
  const color = getAvatarColor(party.name);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3.5 rounded-xl border transition-all duration-150 cursor-pointer ${
        isSelected
          ? "border-[#10b981]/40 bg-[#10b981]/5 dark:bg-[#10b981]/10 shadow-sm"
          : "border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] hover:shadow-md hover:border-[#a7f3d0] dark:hover:border-[#10b981]/30"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Avatar */}
        {party.logoUrl ? (
          <img
            src={party.logoUrl}
            alt={party.name}
            className="w-9 h-9 rounded-full object-cover shrink-0"
          />
        ) : (
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
            style={{ backgroundColor: color }}
          >
            {initial}
          </div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
            {party.name}
          </div>
          {party.email && (
            <div className="text-[11px] text-[#94a3b8] dark:text-white/40 truncate">
              {party.email}
            </div>
          )}
        </div>

        {/* Type badge */}
        <div className="shrink-0 flex items-center gap-1.5">
          {!party.isActive && (
            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400">
              Inactive
            </span>
          )}
          <span
            className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
              party.partyType === "customer"
                ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400"
                : party.partyType === "both"
                  ? "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
                  : "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
            }`}
          >
            {party.partyType}
          </span>
        </div>
      </div>
    </button>
  );
}
