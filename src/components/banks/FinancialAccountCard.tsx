/**
 * FinancialAccountCard — List item card for bank/credit card accounts
 * Used in the left panel of the Banks & Cards page
 */

interface FinancialAccountCardProps {
  account: {
    id: string;
    accountName: string;
    institutionName: string | null;
    accountType: string;
    lastFour: string | null;
    connectionStatus: string | null;
    isManual: boolean;
  };
  isSelected: boolean;
  onClick: () => void;
}

const TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  checking: { icon: "🏦", label: "Checking", color: "#3b82f6" },
  savings: { icon: "🏦", label: "Savings", color: "#10b981" },
  credit_card: { icon: "💳", label: "Credit Card", color: "#f59e0b" },
  money_market: { icon: "🏦", label: "Money Market", color: "#10b981" },
  investment: { icon: "📈", label: "Investment", color: "#8b5cf6" },
  other: { icon: "🏛️", label: "Other", color: "#64748b" },
};

export function FinancialAccountCard({ account, isSelected, onClick }: FinancialAccountCardProps) {
  const config = TYPE_CONFIG[account.accountType] || TYPE_CONFIG.other;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3.5 rounded-xl border transition-all duration-150 ${
        isSelected
          ? "border-[#10b981]/40 bg-[#10b981]/5 dark:bg-[#10b981]/10 shadow-sm ring-1 ring-[#10b981]/20"
          : "border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] hover:border-[#cbd5e1] dark:hover:border-white/15 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Icon */}
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0"
          style={{ backgroundColor: `${config.color}15` }}
        >
          {config.icon}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[#1e293b] dark:text-white truncate">
              {account.accountName}
            </span>
            {account.lastFour && (
              <span className="text-[10px] font-mono text-[#94a3b8] dark:text-white/40 shrink-0">
                •••{account.lastFour}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {account.institutionName && (
              <span className="text-[11px] text-[#64748b] dark:text-white/50 truncate">
                {account.institutionName}
              </span>
            )}
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0"
              style={{ backgroundColor: `${config.color}15`, color: config.color }}
            >
              {config.label}
            </span>
          </div>
        </div>

        {/* Status indicator */}
        <div className="shrink-0">
          {account.isManual ? (
            <span className="text-[10px] font-medium text-[#94a3b8] dark:text-white/30 px-1.5 py-0.5 rounded bg-[#f1f5f9] dark:bg-white/5">
              Manual
            </span>
          ) : (
            <div
              className={`w-2 h-2 rounded-full ${
                account.connectionStatus === "connected"
                  ? "bg-emerald-400"
                  : account.connectionStatus === "stale"
                    ? "bg-amber-400"
                    : "bg-slate-300 dark:bg-white/20"
              }`}
              title={account.connectionStatus || "disconnected"}
            />
          )}
        </div>
      </div>
    </button>
  );
}
