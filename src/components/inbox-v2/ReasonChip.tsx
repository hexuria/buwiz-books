import { INBOX_V2_REASON_LABELS, type InboxV2Reason } from "@/lib/inbox/v2/triage";

const REASON_CHIP_CLASSES: Record<InboxV2Reason, string> = {
  needs_fix: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  jev_unsure: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  spot_check: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
};

/** The one chip that says why an Inbox item needs a human. */
export function ReasonChip({ reason }: { reason: InboxV2Reason }) {
  return (
    <span
      data-reason={reason}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${REASON_CHIP_CLASSES[reason]}`}
    >
      {INBOX_V2_REASON_LABELS[reason]}
    </span>
  );
}
