/**
 * CoaProposalReviewCard — review surface for the two BATCH chart-of-accounts
 * proposal kinds.
 *
 * A batch proposal cannot be reviewed with one Approve button: the interesting
 * decision is per row. So this card lets a reviewer uncheck rows, rename an
 * account, and pick a different subtype — and records those as `excludedKeys`
 * and `overrides` rather than by mutating the `accounts` array. That is not a
 * style choice: `fieldDiff` is a top-level key diff, so an in-place edit would
 * store the correction as one 60-object-versus-47-object blob, which is
 * useless as an eval label. Excluding three rows should read as "excluded
 * three rows".
 *
 * Submit calls `approveAiProposal` when nothing changed and `correctAiProposal`
 * otherwise — the second endpoint has existed server-side with no UI until now.
 *
 * The subtype picker is populated from SUBTYPES_BY_TYPE for that row's account
 * type, so an illegal subtype is not selectable at all. Every model-authored
 * string renders as plain text; nothing here goes near markdown or
 * dangerouslySetInnerHTML.
 */
import { useCallback, useMemo, useState } from "react";
import { SUBTYPES_BY_TYPE, type AccountType } from "../../db/schema/account-constants";
import { SUBTYPE_LABELS } from "../../lib/coa/subtype-labels";
import { callServerFn } from "../../lib/server-fn-client";
import { usePermission } from "../../lib/use-permission";
import type { AiProposalKind, AiProposalStatus } from "../../db/schema/ai";

// ============================================================================
// Payload views
// ============================================================================

interface DraftedAccountView {
  key: string;
  name: string;
  accountType: AccountType;
  subtype: string;
  description?: string;
  accountNumber?: string;
  parentAccountId?: string | null;
  parentDraftKey?: string;
  adjustments?: Array<{ code: string; message: string }>;
}

interface MappingAssignmentView {
  mappingType: string;
  sourceKey: string;
  label?: string;
  targetAccountId: string;
  targetName?: string;
  targetAccountType?: string;
  reason?: string;
}

export interface CoaProposalReviewCardProps {
  proposalId: string;
  kind: Extract<AiProposalKind, "coa_accounts" | "category_mapping">;
  proposal: Record<string, unknown>;
  status?: AiProposalStatus;
  onDone?: (outcome: { action: "approved" | "corrected" | "rejected" }) => void;
}

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  cost_of_revenue: "Cost of Revenue",
  expense: "Operating Expenses",
  other_income: "Other Income",
  other_expense: "Other Expenses",
};

const TYPE_ORDER: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "cost_of_revenue",
  "expense",
  "other_income",
  "other_expense",
];

function readAccounts(proposal: Record<string, unknown>): DraftedAccountView[] {
  return Array.isArray(proposal.accounts) ? (proposal.accounts as DraftedAccountView[]) : [];
}

function readAssignments(proposal: Record<string, unknown>): MappingAssignmentView[] {
  return Array.isArray(proposal.assignments)
    ? (proposal.assignments as MappingAssignmentView[])
    : [];
}

function readRejected(
  proposal: Record<string, unknown>,
): Array<{ name?: string; key?: string; message: string }> {
  return Array.isArray(proposal.rejected)
    ? (proposal.rejected as Array<{ name?: string; key?: string; message: string }>)
    : [];
}

// ============================================================================
// Component
// ============================================================================

export default function CoaProposalReviewCard({
  proposalId,
  kind,
  proposal,
  status = "pending",
  onDone,
}: CoaProposalReviewCardProps) {
  const { canAccess: canRun } = usePermission("aiTask", "run");
  const [busy, setBusy] = useState<"submit" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [subtypes, setSubtypes] = useState<Record<string, string>>({});

  const accounts = useMemo(() => readAccounts(proposal), [proposal]);
  const assignments = useMemo(() => readAssignments(proposal), [proposal]);
  const rejected = useMemo(() => readRejected(proposal), [proposal]);
  const notes = typeof proposal.notes === "string" ? proposal.notes : "";
  const truncated = proposal.truncated === true;

  const grouped = useMemo(() => {
    const buckets = new Map<AccountType, DraftedAccountView[]>();
    for (const account of accounts) {
      const bucket = buckets.get(account.accountType);
      if (bucket) bucket.push(account);
      else buckets.set(account.accountType, [account]);
    }
    return TYPE_ORDER.filter((type) => buckets.has(type)).map((type) => ({
      type,
      rows: buckets.get(type)!,
    }));
  }, [accounts]);

  const toggle = useCallback((key: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** The `overrides` array: only rows the reviewer actually changed. */
  const overrides = useMemo(() => {
    if (kind !== "coa_accounts") return [];
    return accounts
      .filter((account) => !excluded.has(account.key))
      .map((account) => {
        const name = names[account.key];
        const subtype = subtypes[account.key];
        const changed: { key: string; name?: string; subtype?: string } = { key: account.key };
        if (name !== undefined && name.trim() !== account.name) changed.name = name.trim();
        if (subtype !== undefined && subtype !== account.subtype) changed.subtype = subtype;
        return changed;
      })
      .filter((change) => change.name !== undefined || change.subtype !== undefined);
  }, [accounts, excluded, kind, names, subtypes]);

  const dirty = excluded.size > 0 || overrides.length > 0;
  const keptCount =
    kind === "coa_accounts" ? accounts.length - excluded.size : assignments.length - excluded.size;

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    setBusy("submit");
    setError(null);
    try {
      const api = await import("../../routes/api/-ai-proposals");
      if (!dirty) {
        await callServerFn(api.approveAiProposal, { data: { proposalId } });
        onDone?.({ action: "approved" });
      } else {
        // The corrected payload is the ORIGINAL plus the reviewer's decisions,
        // so the diff is exactly what changed.
        const correctedPayload = {
          ...proposal,
          excludedKeys: [...excluded],
          ...(kind === "coa_accounts" ? { overrides } : {}),
        } as Record<string, unknown>;
        await callServerFn(api.correctAiProposal, { data: { proposalId, correctedPayload } });
        onDone?.({ action: "corrected" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setBusy(null);
    }
  }, [busy, dirty, excluded, kind, onDone, overrides, proposal, proposalId]);

  const handleReject = useCallback(async () => {
    if (busy) return;
    setBusy("reject");
    setError(null);
    try {
      const api = await import("../../routes/api/-ai-proposals");
      await callServerFn(api.rejectAiProposal, { data: { proposalId } });
      onDone?.({ action: "rejected" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject proposal");
    } finally {
      setBusy(null);
    }
  }, [busy, onDone, proposalId]);

  const isPending = status === "pending";
  const editable = isPending && canRun;

  return (
    <div className="rounded-lg border border-[var(--color-app-header-teal)]/20 bg-white px-3 py-3 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-[var(--color-app-header-teal)]/20 px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-app-header-teal)]">
          {kind === "coa_accounts" ? "Chart of accounts" : "Posting defaults"}
        </span>
        <span className="text-[10px] text-slate-500">
          {kind === "coa_accounts"
            ? `${keptCount} of ${accounts.length} accounts selected`
            : `${keptCount} of ${assignments.length} defaults selected`}
        </span>
        {truncated && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-400">
            list truncated
          </span>
        )}
        {!isPending && (
          <span className="rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
            {status}
          </span>
        )}
      </div>

      {notes && <p className="mt-1.5 text-[11px] leading-snug text-slate-600">{notes}</p>}

      {kind === "coa_accounts" && (
        <div className="mt-2 space-y-3">
          {grouped.map((group) => (
            <div key={group.type}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {TYPE_LABELS[group.type]}
              </p>
              <ul className="mt-1 space-y-1">
                {group.rows.map((account) => {
                  const isExcluded = excluded.has(account.key);
                  const adjustments = account.adjustments ?? [];
                  return (
                    <li
                      key={account.key}
                      className={`flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 dark:border-slate-800 ${
                        isExcluded ? "opacity-50" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!isExcluded}
                        disabled={!editable}
                        onChange={() => toggle(account.key)}
                        aria-label={`Include ${account.name}`}
                        className="h-3.5 w-3.5"
                      />
                      <input
                        type="text"
                        value={names[account.key] ?? account.name}
                        disabled={!editable || isExcluded}
                        maxLength={255}
                        onChange={(event) =>
                          setNames((current) => ({
                            ...current,
                            [account.key]: event.target.value,
                          }))
                        }
                        aria-label={`Name for ${account.name}`}
                        className="min-w-0 flex-1 rounded border border-slate-200 px-1.5 py-0.5 text-base sm:text-[11px] outline-none focus:border-teal-500 disabled:bg-transparent dark:border-slate-700 dark:bg-slate-900"
                      />
                      <select
                        value={subtypes[account.key] ?? account.subtype}
                        disabled={!editable || isExcluded}
                        onChange={(event) =>
                          setSubtypes((current) => ({
                            ...current,
                            [account.key]: event.target.value,
                          }))
                        }
                        aria-label={`Subtype for ${account.name}`}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-base sm:text-[11px] outline-none focus:border-teal-500 dark:border-slate-700 dark:bg-slate-900"
                      >
                        {SUBTYPES_BY_TYPE[account.accountType].map((value) => (
                          <option key={value} value={value}>
                            {SUBTYPE_LABELS[value]}
                          </option>
                        ))}
                      </select>
                      {account.accountNumber && (
                        <span className="text-[10px] tabular-nums text-slate-400">
                          {account.accountNumber}
                        </span>
                      )}
                      {adjustments.length > 0 && (
                        <span
                          title={adjustments.map((a) => a.message).join("; ")}
                          className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-400"
                        >
                          adjusted
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {kind === "category_mapping" && (
        <ul className="mt-2 space-y-1">
          {assignments.map((assignment) => {
            const key = `${assignment.mappingType}:${assignment.sourceKey}`;
            const isExcluded = excluded.has(key);
            return (
              <li
                key={key}
                className={`flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 dark:border-slate-800 ${
                  isExcluded ? "opacity-50" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={!isExcluded}
                  disabled={!editable}
                  onChange={() => toggle(key)}
                  aria-label={`Include ${assignment.label ?? key}`}
                  className="h-3.5 w-3.5"
                />
                <span className="text-[11px] font-medium">{assignment.label || key}</span>
                <span className="text-[10px] text-slate-400">→</span>
                <span className="text-[11px]">
                  {assignment.targetName || assignment.targetAccountId}
                </span>
                {assignment.targetAccountType && (
                  <span className="rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[9px] text-slate-500">
                    {assignment.targetAccountType}
                  </span>
                )}
                {assignment.reason && (
                  <span className="w-full text-[10px] text-slate-500">{assignment.reason}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rejected.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowRejected((value) => !value)}
            className="text-[10px] font-medium text-slate-500 underline"
          >
            {showRejected ? "Hide" : "Show"} {rejected.length} discarded suggestion
            {rejected.length === 1 ? "" : "s"}
          </button>
          {showRejected && (
            <ul className="mt-1 space-y-0.5">
              {rejected.map((entry, index) => (
                <li key={`${entry.key ?? index}`} className="text-[10px] text-slate-500">
                  {entry.name || entry.key || "—"}: {entry.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="mt-1.5 text-[10px] text-red-600 dark:text-red-400">{error}</p>}

      {isPending && canRun && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleReject}
            className="cursor-pointer rounded-md px-2.5 py-1 text-[10px] font-medium text-[#64748b] transition-colors hover:bg-[#f1f5f9] hover:text-[#1e293b] disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            {busy === "reject" ? "Rejecting…" : "Reject all"}
          </button>
          <button
            type="button"
            disabled={busy !== null || keptCount === 0}
            onClick={handleSubmit}
            className="cursor-pointer rounded-md bg-[var(--color-app-header-teal)] px-3 py-1 text-[10px] font-medium text-white transition-colors hover:bg-[#248f82] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "submit" ? "Applying…" : dirty ? "Apply with my changes" : "Apply all"}
          </button>
        </div>
      )}
    </div>
  );
}
