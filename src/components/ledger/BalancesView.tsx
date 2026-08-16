/**
 * BalancesView — Alternate ledger view showing account balances summary
 * balance rows grouped by account type with totals
 */

// ============================================================================
// Types
// ============================================================================

export interface AccountBalance {
  accountId: string;
  accountName: string;
  accountNumber?: string | null;
  accountType: string;
  parentId?: string | null;
  totalDebit: string;
  totalCredit: string;
  transactionCount: number;
  balance: string;
}

interface BalancesViewProps {
  balances: AccountBalance[];
  onSelectAccount: (accountId: string) => void;
  currency: string;
}

// ============================================================================
// Helpers
// ============================================================================

const TYPE_ORDER = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "cost_of_goods_sold",
  "cost_of_revenue",
  "expense",
  "other_income",
  "other_expense",
];

const TYPE_META: Record<string, { label: string; bg: string; text: string; icon: string }> = {
  asset: { label: "Assets", bg: "#dcfce7", text: "#16a34a", icon: "A" },
  liability: { label: "Liabilities", bg: "#fef3c7", text: "#d97706", icon: "L" },
  equity: { label: "Equity", bg: "#dbeafe", text: "#2563eb", icon: "E" },
  revenue: { label: "Revenue", bg: "#d1fae5", text: "#059669", icon: "R" },
  expense: { label: "Expenses", bg: "#fee2e2", text: "#dc2626", icon: "X" },
  cost_of_goods_sold: { label: "Cost of Sales", bg: "#fce7f3", text: "#db2777", icon: "C" },
  cost_of_revenue: { label: "Cost of Revenue", bg: "#fce7f3", text: "#db2777", icon: "C" },
  other_income: { label: "Other Income", bg: "#e0e7ff", text: "#4f46e5", icon: "I" },
  other_expense: { label: "Other Expense", bg: "#fef9c3", text: "#ca8a04", icon: "O" },
};

import { formatCurrency } from "@/lib/format-currency";

// ============================================================================
// Component
// ============================================================================

export default function BalancesView({ balances, onSelectAccount, currency }: BalancesViewProps) {
  // Group by account type
  const grouped = new Map<string, AccountBalance[]>();
  for (const b of balances) {
    const group = grouped.get(b.accountType) ?? [];
    group.push(b);
    grouped.set(b.accountType, group);
  }

  // Sort groups by canonical order
  const orderedTypes = TYPE_ORDER.filter((t) => grouped.has(t));

  if (balances.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-[#94a3b8] dark:text-slate-500 text-sm">
        No transactions in this period
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Column headers */}
      <div className="flex items-center gap-0 px-1 py-2 border-b border-[#e5e7eb] dark:border-slate-700 bg-[#f8fafc] dark:bg-slate-900 sticky top-0 z-10">
        <div className="flex-1 px-4 text-[10px] font-medium text-[#94a3b8] uppercase tracking-wider">
          Account
        </div>
        <div className="w-[120px] px-3 text-right text-[10px] font-medium text-[#94a3b8] uppercase tracking-wider">
          Balance
        </div>
        <div className="w-[80px] px-3 text-right text-[10px] font-medium text-[#94a3b8] uppercase tracking-wider">
          Txns
        </div>
        <div className="w-[36px]" />
      </div>

      {orderedTypes.map((type) => {
        const accounts = grouped.get(type) ?? [];
        const meta = TYPE_META[type] ?? { label: type, bg: "#f1f5f9", text: "#64748b", icon: "?" };
        const groupTotal = accounts.reduce((sum, a) => sum + Number.parseFloat(a.balance), 0);

        return (
          <div key={type}>
            {/* Type group header */}
            <div className="flex items-center gap-2 px-4 py-2 bg-[#f8fafc] dark:bg-slate-800/50 border-b border-[#f1f5f9] dark:border-slate-700">
              <span
                className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold shrink-0 dark:!bg-current/15"
                style={{ backgroundColor: meta.bg, color: meta.text }}
              >
                {meta.icon}
              </span>
              <span className="text-[12px] font-semibold text-[#475569] dark:text-slate-300">
                {meta.label}
              </span>
              <div className="flex-1" />
              <span className="text-[12px] font-semibold text-[#1e293b] dark:text-slate-100 tabular-nums">
                {formatCurrency(groupTotal, currency)}
              </span>
              <div className="w-[80px]" />
              <div className="w-[36px]" />
            </div>

            {/* Account rows */}
            {accounts.map((account) => {
              const bal = Number.parseFloat(account.balance);
              const isNegative = bal < 0;

              return (
                <div
                  key={account.accountId}
                  className="group flex items-center gap-0 cursor-pointer border-b border-[#f1f5f9] dark:border-slate-700/50 hover:bg-[#fafbfc] dark:hover:bg-slate-800/50 transition-colors"
                  onClick={() => onSelectAccount(account.accountId)}
                  onKeyDown={(e) => e.key === "Enter" && onSelectAccount(account.accountId)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex-1 flex items-center gap-2 px-4 py-2.5 min-w-0">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: meta.text }}
                    />
                    <span className="text-[13px] text-[#1e293b] dark:text-slate-200 truncate">
                      {account.accountName}
                    </span>
                    {account.accountNumber && (
                      <span className="text-[10px] text-[#94a3b8] shrink-0">
                        #{account.accountNumber}
                      </span>
                    )}
                  </div>

                  <div className="w-[120px] px-3 text-right shrink-0">
                    <span
                      className="text-[13px] font-semibold tabular-nums"
                      style={{ color: isNegative ? "#dc2626" : undefined }}
                    >
                      <span className={isNegative ? "" : "text-[#1e293b] dark:text-slate-100"}>
                        {formatCurrency(account.balance, currency)}
                      </span>
                    </span>
                  </div>

                  <div className="w-[80px] px-3 text-right shrink-0">
                    <span className="text-[12px] text-[#94a3b8] tabular-nums">
                      {account.transactionCount}
                    </span>
                  </div>

                  <div className="w-[36px] flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
