/**
 * Reconciliation Sidebar — 4-tab panel (Summary, Flag, Comments, Activity Log)
 * Right panel of the reconciliation detail page.
 */
import React, { useState } from "react";
import type { AgentResult } from "../../lib/reconciliation-agent";
import { Trash2, FileText, Download } from "lucide-react";
import { CommentThread } from "../comments/CommentThread";
import type {
  ReconciliationSummary,
  FlagItem,
  ReconciliationDetail,
} from "../../routes/api/-reconciliations";

// ============================================================================
// Types
// ============================================================================

interface ActivityLogEntry {
  id: string;
  action: string;
  actorId: string | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
}

export interface AISuggestion {
  id: string;
  suggestionType: string;
  confidence: number;
  description: string;
  proposedChanges: Record<string, { from: any; to: any }> | null;
  status: string;
  appliedAt: string | null;
  resolutionSummary: string | null;
}

interface ReconciliationSidebarProps {
  reconciliation: ReconciliationDetail;
  summary: ReconciliationSummary;
  flags: FlagItem[];
  activityLog: ActivityLogEntry[];
  isFinalized: boolean;
  onResolveFlag?: (flagId: string, action: string) => void;
  onCreateTransaction?: (statementLineId?: string) => void;
  /** Count of unmatched statement lines (for dynamic Flag tab badge) */
  unmatchedStatementCount?: number;
  /** Number of unmatched statement lines that have a match candidate in the ledger */
  matchCandidateCount?: number;
  /** Handler to link/re-match all available candidates */
  onLinkTransaction?: () => void;
  /** AI suggestions from the statement processor */
  suggestions?: AISuggestion[];
  onApplySuggestion?: (suggestionId: string) => void;
  onDismissSuggestion?: (suggestionId: string) => void;
  /** Upload statement from Summary tab */
  onUploadStatement?: (file: File) => void;
  /** Agent execution result */
  agentResult?: AgentResult | null;
  /** Remove statement */
  onRemoveStatement?: () => void;
}

type SidebarTab = "summary" | "flag" | "comments" | "activity";

// ============================================================================
// Tab definitions
// ============================================================================

const TABS: { key: SidebarTab; label: string; icon: React.ReactNode }[] = [
  {
    key: "summary",
    label: "Summary",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    key: "flag",
    label: "Flag",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />
      </svg>
    ),
  },
  {
    key: "comments",
    label: "Comments",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    key: "activity",
    label: "Activity",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
];

// ============================================================================
// Helpers
// ============================================================================

const FLAG_TYPE_LABELS: Record<string, string> = {
  unmatched_statement: "Missing Transaction",
  unmatched_ledger: "Unmatched Ledger Entry",
  date_mismatch: "Date Mismatch",
  amount_discrepancy: "Amount Discrepancy",
  duplicate: "Duplicate",
  overmatched: "Over-matched",
};

const ACTION_LABELS: Record<string, string> = {
  create_transaction: "+ Create Transaction",
  change_date: "Change Date",
  split_transaction: "Split Transaction",
  ignore: "Dismiss",
  manual_review: "Manual Review",
};

const SUGGESTION_TYPE_LABELS: Record<string, string> = {
  auto_match: "Auto Match",
  date_fix: "Date Fix",
  create_txn: "Create Transaction",
  duplicate: "Duplicate",
  split: "Split",
  ignore: "Ignore",
};

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatActionLabel(action: string): string {
  switch (action) {
    case "created":
      return "Created reconciliation";
    case "matched":
      return "Matched a transaction";
    case "unmatched":
      return "Unmatched a transaction";
    case "ignored":
      return "Ignored a transaction";
    case "finalized":
      return "Finalized reconciliation";
    case "flag_resolved":
      return "Resolved a flag";
    case "reconfigured":
      return "Reconfigured reconciliation";
    case "statement_generated":
      return "Generated bank statement";
    case "statement_removed":
      return "Removed bank statement";
    case "statement_uploaded":
      return "Uploaded bank statement";
    default:
      if (action.startsWith("ai_agent_")) {
        const subAction = action.replace("ai_agent_", "");
        return `AI agent: ${subAction.replace(/_/g, " ")}`;
      }
      return action.charAt(0).toUpperCase() + action.slice(1).replace(/_/g, " ");
  }
}

function getActionDotColor(action: string): string {
  switch (action) {
    case "matched":
      return "bg-emerald-500";
    case "unmatched":
      return "bg-amber-500";
    case "ignored":
      return "bg-gray-400 dark:bg-white/30";
    case "finalized":
      return "bg-blue-500";
    case "reconfigured":
      return "bg-violet-500";
    case "created":
      return "bg-cyan-500";
    case "flag_resolved":
      return "bg-emerald-400";
    case "statement_generated":
    case "statement_uploaded":
      return "bg-teal-500";
    case "statement_removed":
      return "bg-red-400";
    default:
      if (action.startsWith("ai_agent_")) return "bg-amber-400";
      return "bg-gray-300 dark:bg-white/20";
  }
}

const CHANGE_LABELS: Record<string, string> = {
  statementLineId: "Statement Line",
  journalLineId: "Journal Line",
  bankAccountId: "Bank Account",
  periodStart: "Period Start",
  periodEnd: "Period End",
  period: "Period",
  statementEndingBalance: "Ending Balance",
  statementBeginningBalance: "Beginning Balance",
  description: "Details",
  flagId: "Flag",
  action: "Action",
  targetId: "Target",
  reason: "Reason",
  confidence: "Confidence",
  documentId: "Document",
  charges: "Charges",
  payments: "Payments",
};

// ============================================================================
// Component
// ============================================================================

export function ReconciliationSidebar({
  reconciliation,
  summary,
  flags,
  activityLog,
  isFinalized,
  onResolveFlag,
  onCreateTransaction,
  unmatchedStatementCount,
  matchCandidateCount = 0,
  onLinkTransaction,
  suggestions = [],
  onApplySuggestion,
  onDismissSuggestion,
  onUploadStatement,
  agentResult,
  onRemoveStatement,
}: ReconciliationSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("summary");

  const unresolvedFlags = flags.filter((f) => !f.resolved);
  const resolvedFlags = flags.filter((f) => f.resolved);
  const totalFlagCount = unresolvedFlags.length + (unmatchedStatementCount ?? 0);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-100 dark:border-white/5 shrink-0 bg-white dark:bg-[#111820]">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-semibold transition-all relative ${
              activeTab === tab.key
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50"
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.key === "flag" && totalFlagCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                {totalFlagCount}
              </span>
            )}
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-emerald-500 rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "summary" && (
          <SummaryTab
            reconciliation={reconciliation}
            summary={summary}
            onUploadStatement={onUploadStatement}
            onRemoveStatement={onRemoveStatement}
          />
        )}
        {activeTab === "flag" && (
          <FlagTab
            flags={unresolvedFlags}
            resolvedFlags={resolvedFlags}
            isFinalized={isFinalized}
            onResolveFlag={onResolveFlag}
            onCreateTransaction={onCreateTransaction}
            unmatchedStatementCount={unmatchedStatementCount ?? 0}
            matchCandidateCount={matchCandidateCount}
            onLinkTransaction={onLinkTransaction}
            suggestions={suggestions}
            onApplySuggestion={onApplySuggestion}
            onDismissSuggestion={onDismissSuggestion}
            agentResult={agentResult}
          />
        )}
        {activeTab === "comments" && (
          <CommentThread
            entityType="reconciliation"
            entityId={reconciliation.id}
            isReadOnly={isFinalized}
          />
        )}
        {activeTab === "activity" && <ActivityTab activityLog={activityLog} />}
      </div>
    </div>
  );
}

// ============================================================================
// Summary Tab
// ============================================================================

function SummaryTab({
  reconciliation,
  summary,
  onUploadStatement,
  onRemoveStatement,
}: {
  reconciliation: ReconciliationDetail;
  summary: ReconciliationSummary;
  onUploadStatement?: (file: File) => void;
  onRemoveStatement?: () => void;
}) {
  type RowDef = { label: string; value: string; emphasis?: boolean; divider?: boolean };

  const rows: RowDef[] = [
    { label: "Ending Bank Balance", value: summary.endingBankBalance, emphasis: true },
    { label: "Opening Bank Balance", value: summary.openingBankBalance },
    { label: "Net Transactions (Bank)", value: summary.netTransactionsPerBank },
    { label: "", value: "", divider: true },
    { label: "Deposits (Bank)", value: summary.totalDepositsBank },
    { label: "Deposits (Ledger)", value: summary.totalDepositsLedger },
    { label: "", value: "", divider: true },
    { label: "Withdrawals (Bank)", value: summary.totalWithdrawalsBank },
    { label: "Withdrawals (Ledger)", value: summary.totalWithdrawalsLedger },
    { label: "", value: "", divider: true },
    { label: "Unsettled Transactions", value: summary.unsettledTransactions },
    { label: "Ending Ledger Balance", value: summary.endingLedgerBalance },
    { label: "Unreconciled Difference", value: summary.unreconciledDifference, emphasis: true },
  ];

  return (
    <div className="p-4">
      {/* AI status message */}
      {reconciliation.aiAutoFinalized && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/30">
          <div className="flex items-center gap-2 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            AI auto-reconciled — all transactions matched
          </div>
        </div>
      )}

      {/* Summary table */}
      <div className="space-y-0">
        {rows.map((row, i) => {
          if (row.divider) {
            return <div key={`div-${i}`} className="h-px bg-gray-100 dark:bg-white/5 my-2" />;
          }
          return (
            <div
              key={row.label}
              className={`flex items-center justify-between py-1.5 ${
                row.emphasis ? "font-semibold" : ""
              }`}
            >
              <span
                className={`text-[12px] ${
                  row.emphasis
                    ? "text-gray-800 dark:text-white font-semibold"
                    : "text-gray-500 dark:text-white/40"
                }`}
              >
                {row.label}
              </span>
              <span
                className={`text-[12px] tabular-nums ${
                  row.emphasis
                    ? "text-gray-900 dark:text-white font-semibold"
                    : "text-gray-700 dark:text-white/60"
                }`}
              >
                {row.value}
              </span>
            </div>
          );
        })}
      </div>

      {/* Attachments section */}
      <div className="mt-6 pt-4 border-t border-gray-100 dark:border-white/5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold text-gray-500 dark:text-white/40 uppercase tracking-wider">
            Attachments
          </span>
          <button
            type="button"
            className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:opacity-80 flex items-center gap-1"
            onClick={() => {
              if (!onUploadStatement) return;
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".pdf,.png,.jpg,.jpeg";
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) onUploadStatement(file);
              };
              input.click();
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Upload
          </button>
        </div>
        {reconciliation.statementDocument ? (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 group">
            <div className="w-8 h-8 rounded bg-white dark:bg-white/10 flex items-center justify-center text-red-500 shrink-0">
              <FileText className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-gray-900 dark:text-white truncate">
                {reconciliation.statementDocument.filename}
              </div>
              <div className="text-[10px] text-gray-500 dark:text-white/40">
                {reconciliation.statementDocument.fileSizeBytes
                  ? `${(reconciliation.statementDocument.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`
                  : "PDF Document"}
              </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {reconciliation.statementPdfUrl && (
                <a
                  href={reconciliation.statementPdfUrl}
                  download={reconciliation.statementDocument.filename}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-white/50 transition-colors"
                  title="Download"
                >
                  <Download className="w-3.5 h-3.5" />
                </a>
              )}
              {onRemoveStatement && (
                <button
                  type="button"
                  onClick={onRemoveStatement}
                  className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-gray-500 hover:text-red-500 transition-colors"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-gray-400 dark:text-white/30 text-center py-4">
            No attachments yet
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Flag Tab
// ============================================================================

function FlagTab({
  flags,
  resolvedFlags,
  isFinalized,
  onResolveFlag,
  onCreateTransaction,
  unmatchedStatementCount = 0,
  matchCandidateCount = 0,
  onLinkTransaction,
  suggestions = [],
  onApplySuggestion,
  onDismissSuggestion,
  agentResult,
}: {
  flags: FlagItem[];
  resolvedFlags: FlagItem[];
  isFinalized: boolean;
  onResolveFlag?: (flagId: string, action: string) => void;
  onCreateTransaction?: (statementLineId?: string) => void;
  unmatchedStatementCount?: number;
  matchCandidateCount?: number;
  onLinkTransaction?: () => void;
  suggestions?: AISuggestion[];
  onApplySuggestion?: (suggestionId: string) => void;
  onDismissSuggestion?: (suggestionId: string) => void;
  agentResult?: AgentResult | null;
}) {
  if (
    flags.length === 0 &&
    resolvedFlags.length === 0 &&
    suggestions.length === 0 &&
    !(unmatchedStatementCount && unmatchedStatementCount > 0)
  ) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center mb-3">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-emerald-500"
          >
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <div className="text-[13px] font-medium text-gray-700 dark:text-white/60">No flags</div>
        <div className="text-[11px] text-gray-400 dark:text-white/30 mt-1">
          All transactions are reconciled
        </div>
      </div>
    );
  }

  const pendingSuggestions = suggestions.filter((s) => s.status === "pending");
  const resolvedSuggestions = suggestions.filter((s) => s.status !== "pending");

  return (
    <div className="p-4 space-y-4">
      {/* Agent result banner */}
      {agentResult && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-950/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="text-amber-400"
            >
              <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
            </svg>
            <span className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider">
              AI Agent Result
            </span>
            {agentResult.canAutoFinalize && (
              <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                Auto-Finalized
              </span>
            )}
          </div>
          <div className="text-[12px] text-white/60">{agentResult.summary}</div>
          <div className="flex gap-3 text-[11px]">
            {agentResult.autoApplied > 0 && (
              <span className="text-emerald-400">✅ {agentResult.autoApplied} applied</span>
            )}
            {agentResult.escalated > 0 && (
              <span className="text-amber-400">⚠️ {agentResult.escalated} need review</span>
            )}
          </div>
        </div>
      )}

      {/* AI Suggestions */}
      {pendingSuggestions.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-violet-500"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span className="text-[11px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider">
              AI Suggestions ({pendingSuggestions.length})
            </span>
          </div>
          <div className="space-y-2">
            {pendingSuggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                onApply={onApplySuggestion}
                onDismiss={onDismissSuggestion}
                isFinalized={isFinalized}
              />
            ))}
          </div>
        </div>
      )}

      {/* Unresolved flags */}
      {flags.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-gray-500 dark:text-white/40 uppercase tracking-wider mb-2">
            Unresolved ({flags.length})
          </div>
          <div className="space-y-2">
            {flags.map((flag) => (
              <FlagCard
                key={flag.id}
                flag={flag}
                isFinalized={isFinalized}
                onResolve={onResolveFlag}
                onCreateTransaction={onCreateTransaction}
              />
            ))}
          </div>
        </div>
      )}

      {/* Dynamic unsettled transactions */}
      {unmatchedStatementCount > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-2">
            Unsettled ({unmatchedStatementCount})
          </div>
          <div className="rounded-lg border border-amber-200 dark:border-amber-800/30 bg-amber-50 dark:bg-amber-900/10 p-3">
            <div className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
              {unmatchedStatementCount} statement line{unmatchedStatementCount > 1 ? "s" : ""}{" "}
              unmatched
            </div>
            <div className="text-[11px] text-gray-500 dark:text-white/40 mt-1">
              {matchCandidateCount > 0
                ? `${matchCandidateCount} can be linked to existing ledger transactions.`
                : "These statement lines have no matching ledger transaction."}
            </div>
            {!isFinalized && (
              <div className="flex items-center gap-3 mt-2.5">
                {matchCandidateCount > 0 && onLinkTransaction && (
                  <button
                    type="button"
                    onClick={onLinkTransaction}
                    className="text-[11px] font-semibold text-cyan-600 dark:text-cyan-400 hover:opacity-80 flex items-center gap-1"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    Link Transaction
                  </button>
                )}
                {unmatchedStatementCount > matchCandidateCount && onCreateTransaction && (
                  <button
                    type="button"
                    onClick={() => onCreateTransaction()}
                    className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:opacity-80 flex items-center gap-1"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Create Transaction
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resolved suggestions */}
      {resolvedSuggestions.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-gray-500 dark:text-white/40 uppercase tracking-wider mb-2">
            Applied / Dismissed ({resolvedSuggestions.length})
          </div>
          <div className="space-y-2 opacity-60">
            {resolvedSuggestions.map((suggestion) => (
              <SuggestionCard key={suggestion.id} suggestion={suggestion} isFinalized={true} />
            ))}
          </div>
        </div>
      )}

      {/* Resolved flags */}
      {resolvedFlags.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-gray-500 dark:text-white/40 uppercase tracking-wider mb-2">
            Resolved ({resolvedFlags.length})
          </div>
          <div className="space-y-2 opacity-60">
            {resolvedFlags.map((flag) => (
              <FlagCard key={flag.id} flag={flag} isFinalized={true} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FlagCard({
  flag,
  isFinalized,
  onResolve,
  onCreateTransaction,
}: {
  flag: FlagItem;
  isFinalized: boolean;
  onResolve?: (flagId: string, action: string) => void;
  onCreateTransaction?: (statementLineId?: string) => void;
}) {
  const typeLabel = FLAG_TYPE_LABELS[flag.flagType] ?? flag.flagType;
  const isWarning = flag.flagType === "unmatched_statement" || flag.flagType === "unmatched_ledger";

  return (
    <div
      className={`rounded-lg border p-3 ${
        flag.resolved
          ? "border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-white/[0.02]"
          : isWarning
            ? "border-amber-200 dark:border-amber-800/30 bg-amber-50 dark:bg-amber-900/10"
            : "border-blue-200 dark:border-blue-800/30 bg-blue-50 dark:bg-blue-900/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className={`text-[12px] font-semibold ${
              flag.resolved
                ? "text-gray-500 dark:text-white/40 line-through"
                : isWarning
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-blue-700 dark:text-blue-300"
            }`}
          >
            {typeLabel}
          </div>
          {flag.description && (
            <div className="text-[11px] text-gray-500 dark:text-white/40 mt-1">
              {flag.description}
            </div>
          )}
        </div>
        {flag.resolved && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 text-emerald-500 mt-0.5"
          >
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        )}
      </div>

      {/* Action buttons */}
      {!flag.resolved && !isFinalized && (
        <div className="flex items-center gap-2 mt-2.5">
          {flag.suggestedAction === "create_transaction" && (
            <button
              type="button"
              onClick={() => onCreateTransaction?.(flag.statementLineId ?? undefined)}
              className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:opacity-80 flex items-center gap-1"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {ACTION_LABELS[flag.suggestedAction]}
            </button>
          )}
          {flag.suggestedAction && flag.suggestedAction !== "create_transaction" && (
            <button
              type="button"
              onClick={() => onResolve?.(flag.id, flag.suggestedAction!)}
              className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:opacity-80"
            >
              {ACTION_LABELS[flag.suggestedAction] ?? flag.suggestedAction}
            </button>
          )}
          <button
            type="button"
            onClick={() => onResolve?.(flag.id, "ignore")}
            className="text-[11px] font-medium text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Suggestion Card (AI recommendations)
// ============================================================================

function SuggestionCard({
  suggestion,
  isFinalized,
  onApply,
  onDismiss,
}: {
  suggestion: AISuggestion;
  isFinalized: boolean;
  onApply?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const typeLabel = SUGGESTION_TYPE_LABELS[suggestion.suggestionType] ?? suggestion.suggestionType;
  const confidence = Math.round(suggestion.confidence * 100);
  const isResolved = suggestion.status !== "pending";

  // Confidence color
  let confColor = "text-red-500 bg-red-50 dark:bg-red-900/20";
  if (confidence >= 85) confColor = "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20";
  else if (confidence >= 60) confColor = "text-amber-600 bg-amber-50 dark:bg-amber-900/20";

  return (
    <div
      className={`rounded-lg border p-3 ${
        isResolved
          ? "border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-white/[0.02]"
          : "border-violet-200 dark:border-violet-800/30 bg-violet-50 dark:bg-violet-900/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-[12px] font-semibold ${
                isResolved
                  ? "text-gray-500 dark:text-white/40 line-through"
                  : "text-violet-700 dark:text-violet-300"
              }`}
            >
              {typeLabel}
            </span>
            {!isResolved && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${confColor}`}>
                {confidence}%
              </span>
            )}
          </div>
          {suggestion.description && (
            <div className="text-[11px] text-gray-500 dark:text-white/40 mt-1">
              {suggestion.description}
            </div>
          )}
        </div>

        {/* Resolved badge */}
        {isResolved && (
          <div className="shrink-0 mt-0.5">
            {suggestion.status === "applied" ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-emerald-500"
              >
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-gray-400 dark:text-white/30"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* Proposed changes diff */}
      {suggestion.proposedChanges && !isResolved && (
        <div className="mt-2 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 p-2 space-y-1">
          {Object.entries(suggestion.proposedChanges).map(([key, change]) => (
            <div key={key} className="flex items-center gap-2 text-[10px]">
              <span className="text-gray-400 dark:text-white/30 font-medium min-w-[60px]">
                {key}
              </span>
              <span className="text-red-400 line-through">{String(change.from ?? "—")}</span>
              <svg
                width="8"
                height="8"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="text-gray-300 dark:text-white/20 shrink-0"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="text-emerald-500 font-medium">{String(change.to ?? "—")}</span>
            </div>
          ))}
        </div>
      )}

      {/* Resolution summary for applied suggestions */}
      {isResolved && suggestion.resolutionSummary && (
        <div className="mt-1.5 text-[10px] text-gray-400 dark:text-white/30 italic">
          {suggestion.resolutionSummary}
        </div>
      )}

      {/* Action buttons */}
      {!isResolved && !isFinalized && (
        <div className="flex items-center gap-3 mt-2.5">
          <button
            type="button"
            onClick={() => onApply?.(suggestion.id)}
            className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:opacity-80 flex items-center gap-1"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Apply
          </button>
          <button
            type="button"
            onClick={() => onDismiss?.(suggestion.id)}
            className="text-[11px] font-medium text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Activity Log Tab
// ============================================================================

function ActivityTab({ activityLog }: { activityLog: ActivityLogEntry[] }) {
  if (activityLog.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-3">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-gray-300 dark:text-white/20"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div className="text-[13px] font-medium text-gray-500 dark:text-white/40">
          No activity yet
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-[9px] top-2 bottom-2 w-px bg-gray-200 dark:bg-white/10" />

        <div className="space-y-4">
          {activityLog.map((entry) => (
            <div key={entry.id} className="relative flex gap-3 pl-0">
              {/* Color-coded timeline dot */}
              <div className="w-[19px] shrink-0 flex justify-center pt-0.5 z-10">
                <div
                  className={`w-2 h-2 rounded-full ring-2 ring-white dark:ring-[#111820] ${getActionDotColor(entry.action)}`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-gray-700 dark:text-white/60">
                  {formatActionLabel(entry.action)}
                </div>
                {entry.changes && Object.keys(entry.changes).length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(entry.changes).map(([key, val]) => {
                      const label = CHANGE_LABELS[key] ?? key.replace(/_/g, " ");

                      // Diff format: { from, to }
                      if (
                        val &&
                        typeof val === "object" &&
                        "from" in (val as Record<string, unknown>) &&
                        "to" in (val as Record<string, unknown>)
                      ) {
                        const diff = val as { from: string; to: string };
                        return (
                          <div
                            key={key}
                            className="flex items-center gap-1.5 text-[10px] flex-wrap"
                          >
                            <span className="text-gray-400 dark:text-white/30 font-medium">
                              {label}:
                            </span>
                            <span className="text-red-400/80 line-through">
                              {String(diff.from)}
                            </span>
                            <svg
                              width="8"
                              height="8"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              className="text-gray-300 dark:text-white/20 shrink-0"
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                            <span className="text-emerald-500 font-medium">{String(diff.to)}</span>
                          </div>
                        );
                      }

                      // Simple value
                      if (key === "description") {
                        return (
                          <div key={key} className="text-[10px] text-gray-400 dark:text-white/30">
                            {String(val)}
                          </div>
                        );
                      }

                      return (
                        <div key={key} className="text-[10px] text-gray-400 dark:text-white/30">
                          <span className="font-medium">{label}:</span> {String(val)}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="text-[10px] text-gray-400 dark:text-white/25 mt-0.5">
                  {formatTimestamp(entry.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ReconciliationSidebar;
