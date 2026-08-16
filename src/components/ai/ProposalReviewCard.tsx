/**
 * ProposalReviewCard — generic confirm-first card for one ai_action_proposal.
 *
 * Renders a kind badge, a human-readable summary of the proposed action, the
 * model confidence when known, and Approve / Reject actions. Approval routes
 * through the proposal applier server-side (which re-checks the underlying
 * resource permissions); this card only ever calls the proposal endpoints.
 *
 * Users without aiTask:run see the card read-only (no action buttons).
 */
import { useCallback, useState } from "react";
import { callServerFn } from "../../lib/server-fn-client";
import { usePermission } from "../../lib/use-permission";
import type { AiProposalKind, AiProposalStatus } from "../../db/schema/ai";

// ============================================================================
// Types
// ============================================================================

export interface ProposalReviewCardProps {
  proposalId: string;
  kind: AiProposalKind;
  /** The proposal jsonb payload (shape depends on kind). */
  proposal: Record<string, unknown>;
  /** 0–1 model confidence, when known. */
  confidence?: number | null;
  /** Precomputed human summary (e.g. from the entity resolver). */
  summary?: string;
  /** Defaults to "pending" — non-pending proposals render without actions. */
  status?: AiProposalStatus;
  /** Called after an Approve/Reject round-trip completes successfully. */
  onDone?: (outcome: {
    action: "approved" | "rejected";
    result: Record<string, unknown> | null;
  }) => void;
}

interface ProposalEntityPayload {
  entityType?: string;
  name?: string;
  identifier?: string;
  accountType?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const KIND_LABELS: Record<AiProposalKind, string> = {
  match: "Match",
  categorize: "Categorize",
  create_txn: "New transaction",
  create_party: "New record",
  date_fix: "Date fix",
  split: "Split",
  document_type: "Document type",
  prefill: "Prefill",
  coa_accounts: "Chart of accounts",
  category_mapping: "Posting defaults",
};

const STATUS_LABELS: Record<AiProposalStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrected: "Corrected",
  rejected: "Rejected",
  auto_applied: "Auto-applied",
  expired: "Expired",
};

/** Mirrors bankAccountLabel in src/lib/entity-creation.ts (server module). */
export function formatBankAccountLabel(entity: {
  name?: string;
  identifier?: string;
  accountType?: string;
}): string {
  const isCredit = entity.accountType === "credit_card";
  const lastFour = entity.identifier?.replace(/[^0-9]/g, "").slice(-4) || undefined;
  const rawKind = isCredit ? "Credit Card" : entity.accountType || "checking";
  const kind = isCredit ? rawKind : rawKind.charAt(0).toUpperCase() + rawKind.slice(1);
  const name = entity.name ?? "";
  return lastFour ? `${name} ${kind} ****${lastFour}` : `${name} ${kind}`;
}

function jsonSnippet(value: unknown, max = 120): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return "";
  }
}

function deriveSummary(kind: AiProposalKind, proposal: Record<string, unknown>): string {
  switch (kind) {
    case "create_party": {
      const entity = (proposal.entity ?? {}) as ProposalEntityPayload;
      if (entity.entityType === "bank") {
        return `Create bank account "${formatBankAccountLabel(entity)}"`;
      }
      return `Create ${entity.entityType ?? "party"} "${entity.name ?? "Unknown"}"`;
    }
    case "document_type": {
      const docType = typeof proposal.documentType === "string" ? proposal.documentType : "unknown";
      return `Classify document as "${docType}"`;
    }
    case "prefill": {
      const target = typeof proposal.target === "string" ? proposal.target : "form";
      const summary =
        proposal.summary && typeof proposal.summary === "object"
          ? (proposal.summary as Record<string, unknown>)
          : {};
      const parts = Object.entries(summary)
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === "object" ? "…" : String(value)}`);
      return parts.length > 0
        ? `AI pre-filled ${target} (${parts.join(", ")})`
        : `AI pre-filled ${target}`;
    }
    case "coa_accounts": {
      // Batch kinds get a count, not a payload dump — a 60-account blob is
      // not a summary. CoaProposalReviewCard renders the reviewable detail.
      const drafted = Array.isArray(proposal.accounts) ? proposal.accounts.length : 0;
      const excluded = Array.isArray(proposal.excludedKeys) ? proposal.excludedKeys.length : 0;
      const kept = Math.max(0, drafted - excluded);
      return `Add ${kept} account${kept === 1 ? "" : "s"} to the chart of accounts`;
    }
    case "category_mapping": {
      const assignments = Array.isArray(proposal.assignments) ? proposal.assignments.length : 0;
      const excluded = Array.isArray(proposal.excludedKeys) ? proposal.excludedKeys.length : 0;
      const kept = Math.max(0, assignments - excluded);
      return `Re-point ${kept} posting default${kept === 1 ? "" : "s"}`;
    }
    default:
      return `${KIND_LABELS[kind]}: ${jsonSnippet(proposal)}`;
  }
}

// ============================================================================
// Component
// ============================================================================

export default function ProposalReviewCard({
  proposalId,
  kind,
  proposal,
  confidence,
  summary,
  status = "pending",
  onDone,
}: ProposalReviewCardProps) {
  const { canAccess: canRun } = usePermission("aiTask", "run");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const displaySummary = summary ?? deriveSummary(kind, proposal);
  const effectiveConfidence =
    confidence ??
    (kind === "document_type" && typeof proposal.confidence === "number"
      ? proposal.confidence
      : undefined);

  const handleApprove = useCallback(async () => {
    if (busy) return;
    setBusy("approve");
    setError(null);
    try {
      const { approveAiProposal } = await import("../../routes/api/-ai-proposals");
      const response = (await callServerFn(approveAiProposal, { data: { proposalId } })) as {
        proposal: Record<string, unknown>;
        result: Record<string, unknown> | null;
      } | null;
      onDone?.({ action: "approved", result: response?.result ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve proposal");
    } finally {
      setBusy(null);
    }
  }, [busy, proposalId, onDone]);

  const handleReject = useCallback(async () => {
    if (busy) return;
    setBusy("reject");
    setError(null);
    try {
      const { rejectAiProposal } = await import("../../routes/api/-ai-proposals");
      await callServerFn(rejectAiProposal, { data: { proposalId } });
      onDone?.({ action: "rejected", result: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject proposal");
    } finally {
      setBusy(null);
    }
  }, [busy, proposalId, onDone]);

  const isPending = status === "pending";

  return (
    // The 9–10px type below is the desktop density this card was drawn at, kept from `sm` up.
    // Below `sm` it is unreadable on a phone, so every size steps up one notch at the base.
    <div className="rounded-lg border border-[var(--color-app-header-teal)]/20 bg-[var(--color-app-header-teal)]/5 px-3 py-2.5 sm:px-2.5 sm:py-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs sm:text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-app-header-teal)]/20 text-[var(--color-app-header-teal)] font-medium">
          {KIND_LABELS[kind]}
        </span>
        {effectiveConfidence != null && (
          <span className="text-xs sm:text-[9px] px-1.5 py-0.5 rounded-full bg-[#8b5cf6]/15 text-[#8b5cf6] font-medium">
            {Math.round(effectiveConfidence * 100)}% confident
          </span>
        )}
        {!isPending && (
          <span
            className={`text-xs sm:text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
              status === "rejected" || status === "expired"
                ? "bg-red-500/10 text-red-500"
                : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            }`}
          >
            {STATUS_LABELS[status]}
          </span>
        )}
      </div>

      <p className="mt-1 text-sm sm:text-[10px] font-medium text-[#1e293b] dark:text-white leading-snug break-words">
        {displaySummary}
      </p>

      {error && (
        <p className="mt-1 text-xs sm:text-[9px] text-red-600 dark:text-red-400">{error}</p>
      )}

      {isPending && canRun && (
        <div className="mt-2 flex items-center justify-end gap-2 sm:mt-1.5 sm:gap-1.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleReject}
            className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-2.5 py-1 rounded-md text-xs sm:text-[10px] font-medium text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-slate-200 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleApprove}
            className="inline-flex min-h-11 items-center justify-center lg:min-h-0 gap-1 px-3 py-1 rounded-md bg-[var(--color-app-header-teal)] hover:bg-[#248f82] text-white text-xs sm:text-[10px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {busy === "approve" ? (
              <>
                <svg
                  className="animate-spin"
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeDasharray="32"
                    strokeLinecap="round"
                  />
                </svg>
                Approving…
              </>
            ) : (
              <>
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
                Approve
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
