/**
 * The small "by Jev" tag on entries Jev approved through its autonomy lane
 * (Inbox v2 §10). Lists decide it from the row's audit column (journal
 * created_by, bill approver_id): see src/lib/jev-actor.ts.
 */
import { isJevAuditActor } from "@/lib/jev-actor";

export function ByJevTag({ undone = false }: { undone?: boolean }) {
  return (
    <span
      title={undone ? "Approved by Jev, then undone by a person" : "Approved by Jev"}
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
        undone
          ? "bg-[#f1f5f9] text-[#64748b] line-through dark:bg-white/5 dark:text-white/50"
          : "bg-[#0d9488]/10 text-[#0d9488] dark:text-teal-300"
      }`}
    >
      by Jev
    </span>
  );
}

/** The tag when this audit actor is Jev, nothing otherwise. */
export function ByJevTagFor({ actorId }: { actorId: string | null | undefined }) {
  return isJevAuditActor(actorId) ? <ByJevTag /> : null;
}
