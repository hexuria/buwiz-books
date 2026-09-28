/**
 * MemoriesSettings — what the Inbox remembers (Inbox v2 spec §7).
 *
 * Every classification memory of the organization: what it matches, the answer it gives, how often
 * it answered a paper and how often a person undid that answer. A memory undone twice in a row
 * turns itself off; this is where that shows, and where an owner or admin turns memories back on,
 * off, or deletes them. A memory that would be skipped today (an account deactivated since it was
 * saved, say) says why.
 *
 * Settings → Review Rules mounts it after the rule snapshots: memories are organization
 * configuration that decides drafts, like the rules. Reads go through `listMemories`
 * (inbox:view); every change goes through the admin-only server functions in
 * src/routes/api/-inbox-memory.ts, whose permission checks are the real boundary.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { AlertTriangleIcon, LockIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { keys } from "@/lib/query-keys";
import { callServerFn, type ServerFnResult } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import {
  deleteMemory,
  disableMemory,
  enableMemory,
  listMemories,
} from "../../routes/api/-inbox-memory";

export type MemoryListItem = ServerFnResult<typeof listMemories>[number];

const SCOPE_LABEL: Record<MemoryListItem["matchKind"], string> = {
  file_hash: "This file",
  sender_party: "This sender",
  party: "This party",
  line_text: "These words",
};

const DOC_KIND_LABEL: Record<string, string> = {
  purchase: "Paid expense",
  bill_accrual: "Vendor bill",
  bill_payment: "Bill payment",
  payroll: "Payroll",
  sale: "Money in",
  invoice_accrual: "Sales invoice",
  invoice_payment: "Invoice payment",
  transfer: "Transfer",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function times(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

export function MemoriesSettings() {
  const headingId = useId();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canManage, isLoading: permissionLoading } = usePermission(
    "agentRule",
    "configure",
  );
  const memories = useQuery({
    queryKey: keys.inbox.memories(),
    queryFn: () => callServerFn(listMemories, { data: undefined }),
  });

  const onChanged = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: keys.inbox.memories() });
    showToast(message, { icon: "success" });
  };
  const onError = (error: unknown) =>
    showToast(errorMessage(error, "The memory could not be changed."), { icon: "error" });

  const toggle = useMutation({
    mutationFn: (memory: MemoryListItem) =>
      memory.enabled
        ? callServerFn(disableMemory, { data: { memoryId: memory.id } })
        : callServerFn(enableMemory, { data: { memoryId: memory.id } }),
    onSuccess: (result) => onChanged(result.enabled ? "Memory turned on." : "Memory turned off."),
    onError,
  });
  const remove = useMutation({
    mutationFn: (memory: MemoryListItem) =>
      callServerFn(deleteMemory, { data: { memoryId: memory.id } }),
    onSuccess: () => onChanged("Memory deleted."),
    onError,
  });

  const rows = memories.data ?? [];

  return (
    <section
      aria-labelledby={headingId}
      className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6"
    >
      <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
        Memories
      </h3>
      <p className="text-xs text-[#64748b] dark:text-white/50 mb-4">
        Answers people chose to have the Inbox remember. A matching paper is answered the same way
        with no model involved, and still arrives as a draft for review. When two memories of the
        same kind disagree, neither is used and the paper waits for a person. A memory that is
        undone twice in a row turns itself off.
      </p>

      {!permissionLoading && !canManage && (
        <p className="mb-4 flex items-start gap-2 text-xs text-[#64748b] dark:text-white/50">
          <LockIcon size={14} className="mt-0.5 shrink-0" />
          <span>
            You can see what is remembered but not change it. Ask an owner or admin for the
            “configure agent rules” permission.
          </span>
        </p>
      )}

      {memories.isLoading ? (
        <p className="text-sm text-[#64748b] dark:text-white/50">Loading memories…</p>
      ) : memories.isError ? (
        <div
          role="alert"
          className="rounded-2xl border border-[#fecaca] dark:border-red-900/40 bg-[#fef2f2] dark:bg-red-900/10 p-6"
        >
          <p className="text-sm font-medium text-[#b91c1c] dark:text-red-300">
            Memories could not be loaded
          </p>
          <p className="mt-1 text-xs text-[#b91c1c]/80 dark:text-red-300/70">
            {errorMessage(memories.error, "Please try again.")}
          </p>
          <button
            type="button"
            onClick={() => memories.refetch()}
            className="mt-3 rounded-lg bg-[#0d9488] px-4 py-2 text-sm font-medium text-white transition-all hover:bg-[#0f766e]"
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#e2e8f0] dark:border-white/10 p-6 text-sm text-[#64748b] dark:text-white/50">
          Nothing is remembered yet. After you correct a draft in the Inbox, choose Remember this?
          to have matching papers answered the same way.
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              canManage={canManage}
              busy={
                (toggle.isPending && toggle.variables?.id === memory.id) ||
                (remove.isPending && remove.variables?.id === memory.id)
              }
              onToggle={() => toggle.mutate(memory)}
              onDelete={() => remove.mutate(memory)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryRow({
  memory,
  canManage,
  busy,
  onToggle,
  onDelete,
}: {
  memory: MemoryListItem;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const status = memory.enabled
    ? "On"
    : memory.autoDisabled
      ? "Turned off after two undos in a row"
      : "Off";
  return (
    <li
      aria-label={`${SCOPE_LABEL[memory.matchKind]}: ${memory.keyLabel}`}
      className="rounded-2xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#1e293b] p-4"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[#94a3b8] dark:text-white/40">
            {SCOPE_LABEL[memory.matchKind]}
          </p>
          <p className="truncate text-sm font-medium text-[#1e293b] dark:text-white">
            {memory.keyLabel}
          </p>
          {memory.answer ? (
            <div className="mt-1 text-xs text-[#64748b] dark:text-white/50">
              <p>
                {DOC_KIND_LABEL[memory.answer.docKind] ?? memory.answer.docKind}
                {memory.answer.party ? ` · ${memory.answer.party.name}` : ""}
              </p>
              <ul className="mt-0.5">
                {memory.answer.lines.map((line, index) => (
                  <li key={`${line.side}-${line.accountId}-${index}`}>
                    {line.side === "debit" ? "Debit" : "Credit"} {line.accountLabel}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-1 text-[11px] text-[#94a3b8] dark:text-white/40">
            Answered {times(memory.uses)} · undone {times(memory.undos)}
            {memory.createdBy.name ? ` · saved by ${memory.createdBy.name}` : ""}
          </p>
          {memory.problem && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-[#b45309] dark:text-amber-300">
              <AlertTriangleIcon size={14} className="mt-0.5 shrink-0" />
              <span>Skipped on new papers: {memory.problem}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              memory.enabled
                ? "bg-[#0d9488]/10 text-[#0f766e] dark:bg-teal-900/30 dark:text-teal-300"
                : "bg-[#f1f5f9] text-[#64748b] dark:bg-white/10 dark:text-white/60"
            }`}
          >
            {status}
          </span>
          {canManage &&
            (confirmingDelete ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[#64748b] dark:text-white/50">
                  Delete this memory?
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                  className="rounded-lg bg-[#b91c1c] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#991b1b] disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-[#64748b] hover:text-[#1e293b] dark:text-white/60"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onToggle}
                  aria-label={`${memory.enabled ? "Turn off" : "Turn on"} memory for ${memory.keyLabel}`}
                  className="rounded-lg border border-[#e2e8f0] dark:border-white/10 px-2.5 py-1 text-xs font-medium text-[#1e293b] dark:text-white hover:border-[#94a3b8] disabled:opacity-50"
                >
                  {memory.enabled ? "Turn off" : "Turn on"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                  aria-label={`Delete memory for ${memory.keyLabel}`}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-[#b91c1c] hover:bg-[#fef2f2] dark:text-red-300 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            ))}
        </div>
      </div>
    </li>
  );
}
