/**
 * Financial Package Modal
 * Lets users select which reports to include in the financial package ZIP.
 */
import { useState } from "react";
import { Modal } from "../ui/Modal";

interface FinancialPackageModalProps {
  open: boolean;
  onClose: () => void;
  onDownload: (options: {
    includeTransactionList: boolean;
    includeTrialBalance: boolean;
    includeProfitLoss: boolean;
    includeBalanceSheet: boolean;
    includeCashFlow: boolean;
  }) => void;
  loading: boolean;
  dateFrom: string;
  dateTo: string;
}

const REPORTS = [
  { key: "includeTransactionList" as const, label: "Transaction List", ext: "CSV" },
  { key: "includeTrialBalance" as const, label: "Trial Balance", ext: "XLSX" },
  { key: "includeProfitLoss" as const, label: "Profit & Loss", ext: "XLSX" },
  { key: "includeBalanceSheet" as const, label: "Balance Sheet", ext: "XLSX" },
  { key: "includeCashFlow" as const, label: "Cash Flow Statement", ext: "XLSX" },
] as const;

type ReportKey = (typeof REPORTS)[number]["key"];

export default function FinancialPackageModal({
  open,
  onClose,
  onDownload,
  loading,
  dateFrom,
  dateTo,
}: FinancialPackageModalProps) {
  const [selected, setSelected] = useState<Record<ReportKey, boolean>>({
    includeTransactionList: true,
    includeTrialBalance: true,
    includeProfitLoss: true,
    includeBalanceSheet: true,
    includeCashFlow: true,
  });

  const toggle = (key: ReportKey) => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectAll = () => {
    setSelected({
      includeTransactionList: true,
      includeTrialBalance: true,
      includeProfitLoss: true,
      includeBalanceSheet: true,
      includeCashFlow: true,
    });
  };

  const deselectAll = () => {
    setSelected({
      includeTransactionList: false,
      includeTrialBalance: false,
      includeProfitLoss: false,
      includeBalanceSheet: false,
      includeCashFlow: false,
    });
  };

  const anySelected = Object.values(selected).some(Boolean);
  const allSelected = Object.values(selected).every(Boolean);
  const selectedCount = Object.values(selected).filter(Boolean).length;

  if (!open) return null;

  const formatDate = (d: string) => {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Download Financial Package"
      description={`${formatDate(dateFrom)} — ${formatDate(dateTo)}`}
      mobile="sheet"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            data-testid="pkg-cancel-btn"
            className="h-11 rounded-lg bg-[#f1f5f9] px-4 text-sm font-medium text-[#374151] transition-colors hover:bg-[#e2e8f0] dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onDownload(selected)}
            disabled={!anySelected || loading}
            data-testid="pkg-download-btn"
            className="flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--color-app-header-teal,#1a6b3c)] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeDasharray="31.42"
                    strokeDashoffset="10"
                    strokeLinecap="round"
                  />
                </svg>
                Generating…
              </>
            ) : (
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
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download ZIP
              </>
            )}
          </button>
        </>
      }
    >
      <div data-testid="financial-package-modal">
        {/* Select All / Deselect All */}
        <div className="-mx-4 flex items-center justify-between border-b border-[#f1f5f9] px-4 pb-2 dark:border-slate-700">
          <span className="text-sm text-[#64748b] dark:text-slate-400">
            {selectedCount} of {REPORTS.length} selected
          </span>
          <button
            type="button"
            onClick={allSelected ? deselectAll : selectAll}
            data-testid="pkg-toggle-all"
            className="touch-target text-sm font-medium text-[var(--color-app-header-teal,#1a6b3c)] hover:underline"
          >
            {allSelected ? "Deselect All" : "Select All"}
          </button>
        </div>

        {/* Report Checkboxes */}
        <div className="space-y-1 pt-2">
          {REPORTS.map((report) => (
            <label
              key={report.key}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-[#f9fafb] dark:hover:bg-slate-800"
            >
              <input
                type="checkbox"
                checked={selected[report.key]}
                onChange={() => toggle(report.key)}
                data-testid={`pkg-report-${report.key}`}
                className="h-5 w-5 shrink-0 cursor-pointer rounded border-[#d1d5db] accent-[var(--color-app-header-teal,#1a6b3c)] dark:border-slate-600"
              />
              <span className="flex-1 text-sm text-[#374151] dark:text-slate-300">
                {report.label}
              </span>
              <span className="rounded bg-[#f1f5f9] px-1.5 py-0.5 text-xs font-medium text-[#94a3b8] dark:bg-slate-800 dark:text-slate-500">
                {report.ext}
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
