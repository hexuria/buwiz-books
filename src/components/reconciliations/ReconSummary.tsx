/**
 * Reconciliation Summary — Deposits / Withdrawals / Net cards
 * Extracted from reconciliations_.$reconciliationId.tsx
 */
import { Landmark, BookOpen } from "lucide-react";

// ============================================================================
// Summary Card (Deposits / Withdrawals / Net)
// ============================================================================

function SummaryCard({
  title,
  rows,
  highlight,
}: {
  title: string;
  rows: { label: string; value: string }[];
  highlight?: string;
}) {
  return (
    <div className="flex-1 min-w-[200px] rounded-xl border border-white/10 px-4 py-3 flex flex-col justify-between shadow-sm bg-white/10 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {/* Header Icon */}
          {title === "Net" ? (
            <div className="w-5 h-5 rounded-full bg-white/20 text-white flex items-center justify-center shrink-0">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="100%"
                height="100%"
                fill="none"
                viewBox="0 0 24 24"
              >
                <path
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M5 9h14M5 15h14m0-10L5 19"
                />
              </svg>
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-white/20 text-white flex items-center justify-center shrink-0">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14" />
              </svg>
            </div>
          )}
          <span className="text-[13px] font-semibold text-white">{title}</span>
        </div>

        {/* Highlight Value (Net Difference) */}
        {highlight && (
          <span className="text-[13px] font-bold text-white tabular-nums">{highlight}</span>
        )}
      </div>

      {/* Rows */}
      <div className="space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-white/60">
              {row.label === "Bank" ? (
                <Landmark size={13} className="text-white/60" />
              ) : (
                <BookOpen size={13} className="text-white/60" />
              )}
              <span className="text-[12px] font-medium text-white/60">{row.label}</span>
            </div>
            <span className="text-[13px] font-medium tabular-nums text-white">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Summary Row — container-query-aware layout
// ============================================================================

export interface SummaryRowRecon {
  accountType: string | null;
  summary: {
    totalDepositsBank?: string;
    totalDepositsLedger?: string;
    totalWithdrawalsBank?: string;
    totalWithdrawalsLedger?: string;
    endingBankBalance?: string;
    endingLedgerBalance?: string;
    unreconciledDifference?: string;
  };
}

export default function SummaryRow({ recon }: { recon: SummaryRowRecon; isNarrow: boolean }) {
  const isCreditCard = recon.accountType === "credit_card";
  const inflowLabel = isCreditCard ? "Charges" : "Deposits";
  const outflowLabel = isCreditCard ? "Payments" : "Withdrawals";

  return (
    <div className="bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] flex flex-col md:flex-row items-stretch gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3.5 border-b border-gray-100 dark:border-white/5 shrink-0">
      <SummaryCard
        title={inflowLabel}
        rows={[
          { label: "Bank", value: recon.summary.totalDepositsBank ?? "—" },
          { label: "Ledger", value: recon.summary.totalDepositsLedger ?? "—" },
        ]}
      />
      <SummaryCard
        title={outflowLabel}
        rows={[
          { label: "Bank", value: recon.summary.totalWithdrawalsBank ?? "—" },
          { label: "Ledger", value: recon.summary.totalWithdrawalsLedger ?? "—" },
        ]}
      />
      <SummaryCard
        title="Net"
        highlight={recon.summary.unreconciledDifference}
        rows={[
          { label: "Bank", value: recon.summary.endingBankBalance ?? "—" },
          { label: "Ledger", value: recon.summary.endingLedgerBalance ?? "—" },
        ]}
      />
    </div>
  );
}
