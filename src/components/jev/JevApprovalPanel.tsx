/**
 * "Approved by Jev" on an entry screen (Transactions and Bills detail), with
 * Undo (Inbox v2 §8, §10).
 *
 * Renders nothing for an entry a person approved. For one Jev approved it says
 * which lane and how sure Jev was; Undo posts a reversal (never deletes), voids
 * the bill where there is one, and returns the paper to the Inbox for a
 * person. Undo is an Inbox decision, so it needs inbox:approve.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { JevEntryApproval } from "@/lib/inbox/jev-approval/entry";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import { getJevEntryApproval, undoJevApprovalFn } from "@/routes/api/-jev-lanes";
import { ByJevTag } from "./ByJevTag";

export interface JevApprovalCardProps {
  approval: JevEntryApproval;
  canUndo: boolean;
  busy?: boolean;
  onUndo: (reason: string) => void;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Presentational: the card and its confirm dialog. */
export function JevApprovalCard({ approval, canUndo, busy = false, onUndo }: JevApprovalCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const undoBlocker = !canUndo
    ? "You do not have permission to undo Inbox approvals."
    : approval.cannotUndoReason;

  return (
    <div
      role="region"
      aria-label="Approved by Jev"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-4 py-2.5 text-xs text-[#115e59] dark:border-teal-900/40 dark:bg-teal-950/20 dark:text-teal-200"
    >
      <ByJevTag undone={approval.undone !== null} />
      <span className="min-w-0 flex-1">
        {approval.undone
          ? `Jev approved this entry; ${approval.undone.undoneByName ?? "a person"} undid it${
              approval.undone.reason ? ` (${approval.undone.reason})` : ""
            }.`
          : `Jev approved this entry${approval.laneLabel ? ` on the ${approval.laneLabel} lane` : ""}${
              approval.confidence !== null ? `, ${percent(approval.confidence)} sure` : ""
            }.`}
      </span>
      {!approval.undone && (
        <button
          type="button"
          disabled={busy || undoBlocker !== null}
          title={undoBlocker ?? undefined}
          onClick={() => setConfirming(true)}
          className="min-h-11 lg:min-h-0 rounded-lg border border-[#0d9488]/40 px-3 py-1 text-xs font-medium text-[#0f766e] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:text-teal-200 dark:hover:bg-white/5"
        >
          Undo Jev approval
        </button>
      )}
      {!approval.undone && undoBlocker && (
        <span className="basis-full text-[11px] text-[#64748b] dark:text-white/50">
          {undoBlocker}
        </span>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Undo Jev's approval?"
        description="A reversal is posted and the original stays in the books. The paper goes back to the Inbox for a person, and Jev's lane counts this as a disagreement."
        mobile="center"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg px-4 py-2 text-sm text-[#64748b] dark:text-white/60"
            >
              Keep it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onUndo(reason.trim());
              }}
              className="rounded-lg bg-[#b91c1c] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Undo approval
            </button>
          </div>
        }
      >
        <label htmlFor={reasonId} className="block text-xs text-[#64748b] dark:text-white/60">
          What was wrong (optional)
        </label>
        <input
          id={reasonId}
          value={reason}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm dark:border-white/10 dark:bg-[#0f172a] dark:text-white"
        />
      </Modal>
    </div>
  );
}

/**
 * The card for one journal, wired to the server functions. `onUndone` lets the
 * entry screen refresh its own data.
 */
export function JevApprovalPanel({
  journalHeaderId,
  onUndone,
}: {
  journalHeaderId: string | null | undefined;
  onUndone?: () => void;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canUndo } = usePermission("inbox", "approve");
  const approval = useQuery({
    queryKey: keys.jev.entryApproval(journalHeaderId ?? ""),
    queryFn: () =>
      callServerFn(getJevEntryApproval, { data: { journalHeaderId: journalHeaderId! } }),
    enabled: Boolean(journalHeaderId),
  });
  const undo = useMutation({
    mutationFn: (reason: string) =>
      callServerFn(undoJevApprovalFn, {
        data: { journalHeaderId: journalHeaderId!, ...(reason ? { reason } : {}) },
      }),
    onSuccess: async () => {
      showToast("Jev's approval was undone. The paper is back in the Inbox.", { icon: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.jev.all() }),
        queryClient.invalidateQueries({ queryKey: keys.transactions.all() }),
        queryClient.invalidateQueries({ queryKey: keys.bills.all() }),
        queryClient.invalidateQueries({ queryKey: keys.inbox.all() }),
      ]);
      onUndone?.();
    },
    onError: (error) =>
      showToast(error instanceof Error ? error.message : "The approval could not be undone.", {
        icon: "error",
      }),
  });

  if (!journalHeaderId || !approval.data) return null;
  return (
    <JevApprovalCard
      approval={approval.data}
      canUndo={canUndo}
      busy={undo.isPending}
      onUndo={(reason) => undo.mutate(reason)}
    />
  );
}
