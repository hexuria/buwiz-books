/**
 * RememberThisPrompt — "Remember this?" after a correction (Inbox v2 spec §7 and §10).
 *
 * Opt-in: the new Inbox pane shows it in its strip after a reviewer saves a correction. The
 * reviewer picks how widely the answer should apply — this file, this sender, this party, or these
 * words — and sees, before saving, how many papers from the last 12 months that scope would have
 * matched and how many of them it would have changed. Save calls `rememberCorrection`, which also
 * writes the memory's test lock.
 *
 * Standalone on purpose: nothing mounts it yet (the Inbox v2 screen lands separately). Everything
 * it needs comes from props and the two server functions in src/routes/api/-inbox-memory.ts, whose
 * permission checks are the real boundary — the admin notice here only explains a refusal before
 * the reviewer runs into it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { InfoIcon, LockIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import type { MemoryDocKind } from "@/lib/inbox/memory/answer";
import { keys } from "@/lib/query-keys";
import { callServerFn, type ServerFnResult } from "@/lib/server-fn-client";
import { previewMemoryScope, rememberCorrection } from "../../routes/api/-inbox-memory";

export type MemoryScope = "file_hash" | "sender_party" | "party" | "line_text";

export const MEMORY_SCOPE_OPTIONS: ReadonlyArray<{
  value: MemoryScope;
  label: string;
  hint: string;
}> = [
  {
    value: "file_hash",
    label: "This file",
    hint: "Only when this exact file arrives again.",
  },
  {
    value: "sender_party",
    label: "This sender",
    hint: "Every paper from this sender and tax id.",
  },
  {
    value: "party",
    label: "This party",
    hint: "Every paper matched to this vendor or customer.",
  },
  {
    value: "line_text",
    label: "These words",
    hint: "Every paper described with these words, from any party. Owners and admins only.",
  },
];

/** Kinds of paper a memory can answer, in the words a reviewer uses. */
export const MEMORY_DOC_KIND_LABELS: Record<MemoryDocKind, string> = {
  purchase: "Purchase or receipt (already paid)",
  bill_accrual: "Vendor bill (to pay later)",
  bill_payment: "Payment of a vendor bill",
  payroll: "Payroll",
  sale: "Sale (already received)",
  invoice_accrual: "Sales invoice (to collect later)",
  invoice_payment: "Payment received on an invoice",
  transfer: "Transfer between own accounts",
};

export type RememberCorrectionResult = ServerFnResult<typeof rememberCorrection>;
type ScopePreview = ServerFnResult<typeof previewMemoryScope>;
type AvailablePreview = Extract<ScopePreview, { available: true }>;

function availablePreview(preview: ScopePreview | undefined): AvailablePreview | null {
  return preview && preview.available ? preview : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function papers(count: number): string {
  return count === 1 ? "1 past paper" : `${count} past papers`;
}

export function RememberThisPrompt({
  candidateId,
  candidateRevision,
  defaultScope = "file_hash",
  onSaved,
  onDismiss,
}: {
  /** The corrected Inbox draft (transaction candidate). */
  candidateId: string;
  /** The revision the reviewer is looking at; a newer one is refused as stale. */
  candidateRevision?: number;
  defaultScope?: MemoryScope;
  onSaved?: (result: RememberCorrectionResult) => void;
  onDismiss?: () => void;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const headingId = useId();
  const [scope, setScope] = useState<MemoryScope>(defaultScope);
  // Only for a paper whose own kind is unknown (a hand-entered entry): the kind the
  // reviewer says it is. The server offers the kinds that fit and re-checks the choice.
  const [docKind, setDocKind] = useState<MemoryDocKind | null>(null);
  const kindSelectId = useId();

  const preview = useQuery({
    queryKey: keys.inbox.memoryPreview(candidateId, scope, docKind),
    queryFn: () =>
      callServerFn(previewMemoryScope, {
        data: { candidateId, scope, ...(docKind ? { docKind } : {}) },
      }),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      callServerFn(rememberCorrection, {
        data: {
          candidateId,
          scope,
          ...(candidateRevision !== undefined ? { expectedRevision: candidateRevision } : {}),
          ...(docKind ? { docKind } : {}),
        },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.inbox.memories() });
      showToast(
        result.replaced
          ? `Updated what is remembered for ${result.keyLabel}.`
          : `Remembered for ${result.keyLabel}.`,
        { icon: "success" },
      );
      onSaved?.(result);
    },
  });

  const data = preview.data;
  const available = availablePreview(data);
  // The kinds the reviewer may choose, sticky once seen so the picker does not
  // vanish while the next preview loads.
  const [kindOptions, setKindOptions] = useState<MemoryDocKind[] | null>(null);
  const reportedKinds = data && !data.available ? (data.kindOptions ?? null) : null;
  if (reportedKinds && reportedKinds.join() !== kindOptions?.join()) {
    setKindOptions(reportedKinds);
  }
  // A hand-entered entry that no kind of paper fits cannot be remembered at all.
  if (kindOptions !== null && kindOptions.length === 0) return null;
  const blockedByRole = available !== null && available.requiresAdmin && !available.allowed;
  const canSave = available !== null && !blockedByRole && !save.isPending;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#1e293b] p-4"
    >
      <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white">
        Remember this?
      </h3>
      <p className="mt-0.5 text-xs text-[#64748b] dark:text-white/50">
        Answer matching papers the way you just did, without asking a model. Each one still arrives
        as a draft for review.
      </p>

      <fieldset className="mt-3">
        <legend className="sr-only">Remember it for</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {MEMORY_SCOPE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                scope === option.value
                  ? "border-[#0d9488] bg-[#0d9488]/5 dark:border-teal-500 dark:bg-teal-900/10"
                  : "border-[#e2e8f0] dark:border-white/10 hover:border-[#94a3b8]"
              }`}
            >
              <input
                type="radio"
                name={`${headingId}-scope`}
                value={option.value}
                checked={scope === option.value}
                onChange={() => {
                  setScope(option.value);
                  save.reset();
                }}
                className="mt-0.5 accent-[#0d9488]"
              />
              <span>
                <span className="block font-medium text-[#1e293b] dark:text-white">
                  {option.label}
                </span>
                <span className="block text-[11px] leading-4 text-[#94a3b8] dark:text-white/40">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {kindOptions && kindOptions.length > 0 && (
        <div className="mt-3">
          <label
            htmlFor={kindSelectId}
            className="block text-xs font-medium text-[#1e293b] dark:text-white"
          >
            What kind of paper is this?
          </label>
          <select
            id={kindSelectId}
            value={docKind ?? ""}
            onChange={(event) => {
              setDocKind((event.target.value || null) as MemoryDocKind | null);
              save.reset();
            }}
            className="mt-1 w-full rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] px-2 py-1.5 text-sm text-[#1e293b] dark:text-white"
          >
            <option value="">Choose a kind…</option>
            {kindOptions.map((kind) => (
              <option key={kind} value={kind}>
                {MEMORY_DOC_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-3 min-h-10 text-xs" aria-live="polite">
        {preview.isLoading ? (
          <p className="text-[#64748b] dark:text-white/50">Checking the last 12 months…</p>
        ) : preview.isError ? (
          <p role="alert" className="text-[#b91c1c] dark:text-red-300">
            {errorMessage(preview.error, "The preview could not be loaded.")}
          </p>
        ) : data && !data.available ? (
          <p className="flex items-start gap-1.5 text-[#64748b] dark:text-white/50">
            <InfoIcon size={14} className="mt-0.5 shrink-0" />
            <span>{data.reason}</span>
          </p>
        ) : available ? (
          <div className="space-y-1">
            <p className="text-[#64748b] dark:text-white/50">
              Matches{" "}
              <span className="font-medium text-[#1e293b] dark:text-white">
                {available.keyLabel}
              </span>
            </p>
            <p className="text-[#1e293b] dark:text-white" data-testid="memory-preview-count">
              {available.matched === 0
                ? `No past papers in the last ${available.windowMonths} months match.`
                : `Would have changed ${available.changed} of ${papers(available.matched)} in the last ${available.windowMonths} months.`}
              {available.capped ? ` (Checked the newest ${available.examined}.)` : ""}
            </p>
            {available.existingMemory && (
              <p className="text-[#64748b] dark:text-white/50">
                Saving replaces the answer already remembered for this
                {available.existingMemory.enabled ? "" : " (it is turned off; saving turns it on)"}.
              </p>
            )}
            {blockedByRole && (
              <p
                role="status"
                className="flex items-start gap-1.5 rounded-lg bg-[#f8fafc] dark:bg-[#0f172a] px-2 py-1.5 text-[#64748b] dark:text-white/50"
              >
                <LockIcon size={14} className="mt-0.5 shrink-0" />
                <span>
                  This would answer papers from more than one party, so only an owner or admin can
                  save it.
                </span>
              </p>
            )}
          </div>
        ) : null}
      </div>

      {save.isError && (
        <p role="alert" className="mt-2 text-xs text-[#b91c1c] dark:text-red-300">
          {errorMessage(save.error, "The memory could not be saved.")}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-[#64748b] hover:text-[#1e293b] dark:text-white/60 dark:hover:text-white"
          >
            Not now
          </button>
        )}
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!canSave}
          className="rounded-lg bg-[#0d9488] px-4 py-1.5 text-sm font-medium text-white transition-all hover:bg-[#0f766e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
