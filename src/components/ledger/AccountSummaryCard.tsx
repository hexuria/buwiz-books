/**
 * AccountSummaryCard — Shows selected account info + balance
 * summary card below the search bar in the Ledger
 */

interface AccountSummaryCardProps {
  accountName: string;
  accountNumber?: string | null;
  accountType: string;
  balance: string;
  transactionCount: number;
  currency: string;
}

const TYPE_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  asset: { bg: "#dcfce7", text: "#16a34a", icon: "A" },
  liability: { bg: "#fef3c7", text: "#d97706", icon: "L" },
  equity: { bg: "#dbeafe", text: "#2563eb", icon: "E" },
  revenue: { bg: "#d1fae5", text: "#059669", icon: "R" },
  expense: { bg: "#fee2e2", text: "#dc2626", icon: "X" },
  cost_of_goods_sold: { bg: "#fce7f3", text: "#db2777", icon: "C" },
  cost_of_revenue: { bg: "#fce7f3", text: "#db2777", icon: "C" },
  other_income: { bg: "#e0e7ff", text: "#4f46e5", icon: "I" },
  other_expense: { bg: "#fef9c3", text: "#ca8a04", icon: "O" },
};

import { formatCurrency } from "@/lib/format-currency";

function formatTypeName(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function AccountSummaryCard({
  accountName,
  accountNumber,
  accountType,
  balance,
  transactionCount,
  currency,
}: AccountSummaryCardProps) {
  const typeConf = TYPE_COLORS[accountType] ?? { bg: "#f1f5f9", text: "#64748b", icon: "?" };
  const numericBalance = Number.parseFloat(balance);
  const isNegative = numericBalance < 0;

  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-[#e5e7eb] dark:border-slate-700 bg-[#fafbfc] dark:bg-slate-800/50">
      {/* Type badge */}
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
        style={
          {
            "--badge-bg": typeConf.bg,
            "--badge-text": typeConf.text,
            backgroundColor: "var(--badge-bg)",
            color: "var(--badge-text)",
          } as React.CSSProperties
        }
      >
        {typeConf.icon}
      </div>

      {/* Account info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8] dark:text-slate-500">
            {formatTypeName(accountType)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[#1e293b] dark:text-slate-100 truncate">
            {accountName}
          </span>
          {accountNumber && (
            <span className="text-[11px] text-[#94a3b8] dark:text-slate-500 shrink-0">
              #{accountNumber}
            </span>
          )}
        </div>
      </div>

      {/* Balance + count */}
      <div className="text-right shrink-0">
        <div
          className="text-[16px] font-bold tabular-nums"
          style={
            {
              "--balance-color": isNegative ? "#dc2626" : "#1e293b",
              color: "var(--balance-color)",
            } as React.CSSProperties
          }
        >
          {formatCurrency(balance, currency)}
        </div>
        <div className="text-[11px] text-[#94a3b8] dark:text-slate-500">
          {transactionCount} transaction{transactionCount !== 1 ? "s" : ""}
        </div>
      </div>

      {/* More menu */}
      <button
        type="button"
        className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-md flex items-center justify-center text-[#94a3b8] dark:text-slate-500 hover:text-[#64748b] dark:hover:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors shrink-0"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
    </div>
  );
}
