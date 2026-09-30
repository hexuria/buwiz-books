/**
 * The possible-duplicate comparison and its structured resolution, shared by the classic Inbox and
 * Inbox v2. Moved unchanged from src/routes/inbox.tsx; a note alone never clears a duplicate, so
 * both screens resolve it here, through the existing duplicate-case server functions.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import {
  getDuplicateCase,
  type getInboxItem,
  previewDuplicateResolution,
  resolveDuplicateCase,
} from "@/routes/api/-inbox";

function money(value: string | null, currency: string | null) {
  if (!value) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency ?? ""} ${value}`.trim();
  }
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export type DuplicateCaseSummary = Awaited<
  ReturnType<typeof getInboxItem>
>["duplicateCases"][number];
type DuplicateCaseDetail = Awaited<ReturnType<typeof getDuplicateCase>>;
type DuplicateAction =
  | "consolidate_candidates"
  | "attach_to_posted"
  | "keep_separate"
  | "merge_posted"
  | "reject_source";

const DUPLICATE_ACTION_LABELS: Record<DuplicateAction, string> = {
  consolidate_candidates: "Consolidate Inbox items",
  attach_to_posted: "Attach to posted transaction",
  keep_separate: "Keep separate",
  merge_posted: "Merge posted transactions",
  reject_source: "Reject source",
};

function candidateForSide(side: DuplicateCaseDetail["left"]) {
  return side.candidate?.candidate ?? null;
}

function defaultDuplicateAction(detail: DuplicateCaseDetail, canMatch: boolean): DuplicateAction {
  return applicableDuplicateActions(detail, canMatch)[0] ?? "keep_separate";
}

function canonicalOptions(detail: DuplicateCaseDetail, action: DuplicateAction) {
  const options: Array<{ id: string; label: string }> = [];
  const sideOptions = [
    { label: "First", side: detail.left },
    { label: "Second", side: detail.right },
  ] as const;
  for (const { label, side } of sideOptions) {
    const candidate = candidateForSide(side);
    if (action === "consolidate_candidates" && candidate) {
      options.push({
        id: candidate.id,
        label: `${label}: ${candidate.memo || side.source.description}`,
      });
    } else if ((action === "attach_to_posted" || action === "merge_posted") && side.journal) {
      options.push({
        id: side.journal.id,
        label: `${label}: ${side.journal.transactionNumber} · ${side.journal.memo || "Posted transaction"}`,
      });
    } else if (action === "reject_source" && !side.journal && !candidate?.postedJournalHeaderId) {
      options.push({
        id: candidate?.id ?? side.source.id,
        label: `${label}: ${candidate?.memo || side.source.description || "Source record"}`,
      });
    }
  }
  return options;
}

function applicableDuplicateActions(detail: DuplicateCaseDetail, canMatch: boolean) {
  const leftCandidate = candidateForSide(detail.left);
  const rightCandidate = candidateForSide(detail.right);
  if (detail.left.journal && detail.right.journal) {
    return canMatch
      ? (["merge_posted", "keep_separate"] satisfies DuplicateAction[])
      : ([] as DuplicateAction[]);
  }
  const actions: DuplicateAction[] = ["keep_separate"];
  if (canMatch) actions.push("reject_source");
  if (
    leftCandidate &&
    rightCandidate &&
    !leftCandidate.postedJournalHeaderId &&
    !rightCandidate.postedJournalHeaderId
  ) {
    actions.unshift("consolidate_candidates");
  }
  if (
    (detail.left.journal && !detail.right.journal && rightCandidate) ||
    (detail.right.journal && !detail.left.journal && leftCandidate)
  ) {
    actions.unshift("attach_to_posted");
  }
  return actions;
}

export function DuplicateCasePanel({
  duplicateCase,
  canResolve,
}: {
  duplicateCase: DuplicateCaseSummary;
  canResolve: boolean;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canMatch } = usePermission("journal", "match");
  const detailQuery = useQuery({
    queryKey: keys.inbox.duplicateCase(duplicateCase.id),
    queryFn: () => callServerFn(getDuplicateCase, { data: { caseId: duplicateCase.id } }),
    enabled: duplicateCase.state === "open",
  });
  const [action, setAction] = useState<DuplicateAction>("keep_separate");
  const [canonicalId, setCanonicalId] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<
    Awaited<ReturnType<typeof previewDuplicateResolution>> | undefined
  >();

  useEffect(() => {
    if (!detailQuery.data) return;
    const nextAction = defaultDuplicateAction(detailQuery.data, canMatch);
    const options = canonicalOptions(detailQuery.data, nextAction);
    setAction(nextAction);
    setCanonicalId(options[0]?.id ?? "");
    setPreview(undefined);
  }, [canMatch, detailQuery.data]);

  const options = detailQuery.data ? canonicalOptions(detailQuery.data, action) : [];
  const actions = detailQuery.data
    ? applicableDuplicateActions(detailQuery.data, canMatch)
    : ([] as DuplicateAction[]);
  const requiresCanonical = action !== "keep_separate";
  const requiresReason =
    action === "keep_separate" || action === "merge_posted" || action === "reject_source";
  const input = {
    caseId: duplicateCase.id,
    action,
    canonicalId: requiresCanonical ? canonicalId || null : null,
    reason: reason.trim() || null,
  };
  const previewMutation = useMutation({
    mutationFn: () => callServerFn(previewDuplicateResolution, { data: input }),
    onSuccess: setPreview,
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const resolveDuplicateMutation = useMutation({
    mutationFn: () =>
      callServerFn(resolveDuplicateCase, {
        data: {
          ...input,
          expectedVersion: duplicateCase.lockVersion,
          idempotencyKey,
        },
      }),
    onSuccess: async () => {
      showToast("Duplicate case resolved without discarding source evidence.", {
        icon: "success",
      });
      setIdempotencyKey(crypto.randomUUID());
      setPreview(undefined);
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  if (duplicateCase.state !== "open") {
    return (
      <div className="border-l-2 border-emerald-500 py-1 pl-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">{titleCase(duplicateCase.resolutionAction)}</p>
          <span className="font-mono text-xs text-slate-500">{duplicateCase.score}%</span>
        </div>
        {duplicateCase.resolutionReason && (
          <p className="mt-1 text-xs leading-5 text-slate-500">{duplicateCase.resolutionReason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20">
      <div className="flex items-center justify-between border-b border-amber-200 px-3 py-2 dark:border-amber-900">
        <div>
          <p className="text-sm font-semibold">Possible duplicate</p>
          <p className="text-[11px] text-slate-500">
            Deterministic matcher v{duplicateCase.algorithmVersion}
            {duplicateCase.disposition === "shadow" ? " · shadow" : ""}
          </p>
        </div>
        <span className="font-mono text-sm font-semibold text-amber-800 dark:text-amber-200">
          {duplicateCase.score}%
        </span>
      </div>
      {detailQuery.isLoading && (
        <div className="space-y-2 p-3" aria-label="Loading duplicate comparison">
          <div className="h-14 animate-pulse rounded bg-amber-100 dark:bg-amber-950" />
          <div className="h-14 animate-pulse rounded bg-amber-100 dark:bg-amber-950" />
        </div>
      )}
      {detailQuery.isError && (
        <div className="p-3 text-sm text-rose-700 dark:text-rose-300">
          {errorMessage(detailQuery.error)}
          <button
            type="button"
            onClick={() => detailQuery.refetch()}
            className="ml-2 font-semibold underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}
      {detailQuery.data && (
        <div className="space-y-3 p-3">
          <div className="grid gap-px overflow-hidden rounded border border-amber-200 bg-amber-200 dark:border-amber-900 dark:bg-amber-900">
            <DuplicateSideSummary label="First source" side={detailQuery.data.left} />
            <DuplicateSideSummary label="Second source" side={detailQuery.data.right} />
          </div>
          <DuplicateSignals signals={detailQuery.data.case.signals} />
          {canResolve && actions.length > 0 ? (
            <div className="space-y-2 border-t border-amber-200 pt-3 dark:border-amber-900">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                Resolution
                <select
                  value={action}
                  onChange={(event) => {
                    const nextAction = event.target.value as DuplicateAction;
                    const nextOptions = canonicalOptions(detailQuery.data!, nextAction);
                    setAction(nextAction);
                    setCanonicalId(nextOptions[0]?.id ?? "");
                    setPreview(undefined);
                    setIdempotencyKey(crypto.randomUUID());
                  }}
                  className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-amber-200 bg-white px-2 text-base sm:text-xs outline-none focus:border-teal-600 dark:border-amber-900 dark:bg-slate-900"
                >
                  {actions.map((value) => (
                    <option key={value} value={value}>
                      {DUPLICATE_ACTION_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              {requiresCanonical && (
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  {action === "reject_source" ? "Source to reject" : "Canonical record"}
                  <select
                    value={canonicalId}
                    onChange={(event) => {
                      setCanonicalId(event.target.value);
                      setPreview(undefined);
                      setIdempotencyKey(crypto.randomUUID());
                    }}
                    className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-amber-200 bg-white px-2 text-base sm:text-xs outline-none focus:border-teal-600 dark:border-amber-900 dark:bg-slate-900"
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                Reason {requiresReason ? "(required)" : "(optional)"}
                <textarea
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setPreview(undefined);
                  }}
                  rows={2}
                  placeholder="Document why these records should be handled this way"
                  className="mt-1 w-full resize-none rounded-md border border-amber-200 bg-white p-2 text-base sm:text-xs outline-none focus:border-teal-600 dark:border-amber-900 dark:bg-slate-900"
                />
              </label>
              {preview && (
                <div
                  className={`rounded border p-2 text-xs ${
                    preview.allowed
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                      : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                  }`}
                >
                  {preview.errors.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                  {preview.warnings.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                  {preview.allowed && preview.warnings.length === 0 && (
                    <p>This resolution can be applied safely.</p>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => previewMutation.mutate()}
                  disabled={
                    previewMutation.isPending ||
                    (requiresCanonical && !canonicalId) ||
                    (requiresReason && reason.trim().length < 3)
                  }
                  className="h-9 min-h-11 lg:min-h-0 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-900 transition active:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-slate-900 dark:text-amber-100"
                >
                  {previewMutation.isPending ? "Checking…" : "Preview"}
                </button>
                <button
                  type="button"
                  onClick={() => resolveDuplicateMutation.mutate()}
                  disabled={!preview?.allowed || resolveDuplicateMutation.isPending}
                  className="h-9 min-h-11 lg:min-h-0 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white transition hover:bg-teal-800 active:-translate-y-px disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
                >
                  {resolveDuplicateMutation.isPending ? "Applying…" : "Apply resolution"}
                </button>
              </div>
            </div>
          ) : (
            <p className="border-t border-amber-200 pt-3 text-xs text-slate-500 dark:border-amber-900">
              You can inspect this case, but an approver must resolve it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DuplicateSideSummary({
  label,
  side,
}: {
  label: string;
  side: DuplicateCaseDetail["left"];
}) {
  const candidate = candidateForSide(side);
  const amount =
    candidate?.originalTotal ??
    side.journal?.totalAmount ??
    side.source.originalAmount ??
    side.source.amount;
  const currency =
    candidate?.originalCurrency ??
    side.journal?.transactionCurrency ??
    side.source.originalCurrency ??
    side.source.currency;
  return (
    <div className="bg-white p-3 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            {label}
          </p>
          <p className="mt-1 truncate text-sm font-semibold">
            {candidate?.memo || side.journal?.memo || side.source.description || "Untitled source"}
          </p>
        </div>
        <span className="shrink-0 font-mono text-xs font-semibold">{money(amount, currency)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[72px_1fr] gap-y-1 text-xs">
        <dt className="text-slate-500">Source</dt>
        <dd className="truncate">
          {titleCase(side.provider?.provider)} · {titleCase(side.provider?.channel)}
        </dd>
        <dt className="text-slate-500">Date</dt>
        <dd>
          {candidate?.transactionDate ||
            side.journal?.transactionDate ||
            side.source.effectiveDate ||
            "—"}
        </dd>
        <dt className="text-slate-500">Reference</dt>
        <dd className="truncate">
          {candidate?.referenceNumber ||
            side.journal?.referenceNumber ||
            side.source.normalizedReference ||
            "—"}
        </dd>
        <dt className="text-slate-500">Evidence</dt>
        <dd>
          {side.documents.length} document{side.documents.length === 1 ? "" : "s"}
        </dd>
      </dl>
    </div>
  );
}

function DuplicateSignals({ signals }: { signals: Record<string, unknown> }) {
  const entries = Object.entries(signals).filter(
    ([, value]) => value !== null && value !== false && value !== 0 && value !== "",
  );
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
        Why it matched
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        {entries.map(([key, value]) => (
          <span
            key={key}
            className="rounded border border-amber-200 bg-white px-1.5 py-1 text-[10px] font-medium text-amber-900 dark:border-amber-900 dark:bg-slate-900 dark:text-amber-100"
          >
            {titleCase(key)}: {typeof value === "object" ? "matched" : String(value)}
          </span>
        ))}
      </div>
    </div>
  );
}
