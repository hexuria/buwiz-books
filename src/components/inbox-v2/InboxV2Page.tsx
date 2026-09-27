/**
 * Inbox v2 (spec §10): one list of what needs a human, filtered by reason, and a reading pane with
 * the matching editor. Desktop shows the pane beside the list; below `lg` it is a full-height
 * drawer.
 *
 * Approve and Reject remove the row at once and move to the next item; a failure puts the row
 * back and says why. Afterwards the inbox, bills, transactions and invoices caches refresh, since
 * an approval can create any of them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/ui/EmptyState";
import { AlertTriangleIcon, CheckCircleIcon, PointerIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { useMinWidth } from "@/hooks/useBreakpoint";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import type { InboxV2List, InboxV2ListItem } from "@/lib/inbox/v2/list";
import {
  INBOX_V2_KIND_LABELS,
  INBOX_V2_REASON_LABELS,
  INBOX_V2_REASONS,
  type InboxV2Reason,
} from "@/lib/inbox/v2/triage";
import { approveInbox, rejectInbox } from "@/routes/api/-inbox";
import { formatRelativeTime } from "../transactions/shared/helpers";
import {
  InboxV2Pane,
  type ApproveRequest,
  type InboxV2PaneHandle,
  type RejectRequest,
} from "./InboxV2Pane";
import { inboxKeyAction, INBOX_DRAWER_ATTRIBUTE } from "./keyboard";
import { ReasonChip } from "./ReasonChip";
import { RememberThisPrompt } from "./RememberThisPrompt";
import { useInboxV2List } from "./useInboxV2";

export type InboxV2Filter = InboxV2Reason | "all";

const FILTERS: Array<{ value: InboxV2Filter; label: string }> = [
  { value: "all", label: "All" },
  ...INBOX_V2_REASONS.map((reason) => ({ value: reason, label: INBOX_V2_REASON_LABELS[reason] })),
];

const EMPTY_FILTER_TEXT: Record<InboxV2Reason, string> = {
  needs_fix: "Nothing needs a fix.",
  jev_unsure: "Jev is sure about everything here.",
  spot_check: "No spot checks.",
  failed: "Nothing failed.",
  ready: "Nothing is ready to approve yet.",
};

const DECISION_KEY = ["inbox-v2", "decision"] as const;
const EMPTY_ITEMS: InboxV2ListItem[] = [];

type Decision =
  | { kind: "approve"; request: ApproveRequest }
  | { kind: "reject"; request: RejectRequest };

type DecisionContext = {
  /** Where the row sat in the cached list, to put it back on failure. */
  index: number;
  /** The selection the removal moved to, when it moved the selection at all. */
  advancedTo?: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatAmount(value: string | null, currency: string) {
  if (!value) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency} ${value}`;
  }
}

export function filterInboxV2Items(items: InboxV2ListItem[], filter: InboxV2Filter) {
  return filter === "all" ? items : items.filter((item) => item.reason === filter);
}

export interface InboxV2PageProps {
  /** The item in the URL (`?selected=`), if any. */
  selectedId?: string;
  onSelect: (id: string | undefined, options?: { replace?: boolean }) => void;
}

export function InboxV2Page({ selectedId, onSelect }: InboxV2PageProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const isDesktop = useMinWidth("lg");
  const listQuery = useInboxV2List();
  const [filter, setFilter] = useState<InboxV2Filter>("all");
  const paneRef = useRef<InboxV2PaneHandle>(null);
  // "Remember this?" for an item approved with a correction that changed its answer. The pane
  // has moved on by then, so the offer waits here, out of the way, until answered or dismissed.
  const [rememberApproved, setRememberApproved] = useState<ApproveRequest["remember"] | null>(null);

  const items = listQuery.data?.items ?? EMPTY_ITEMS;
  const visible = useMemo(() => filterInboxV2Items(items, filter), [items, filter]);
  const counts = useMemo(() => {
    const byReason = new Map<InboxV2Filter, number>([["all", items.length]]);
    for (const item of items) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    return byReason;
  }, [items]);

  // The selection, while the current filter shows it. Otherwise the desktop pane opens on the
  // first visible item; a phone opens the drawer only when asked.
  const selectionVisible = visible.some((item) => item.id === selectedId);
  const activeId = selectionVisible ? selectedId : isDesktop ? visible[0]?.id : undefined;
  const activeItem = items.find((item) => item.id === activeId) ?? null;

  const latest = useRef({ visible, activeId, selectedId, onSelect });
  latest.current = { visible, activeId, selectedId, onSelect };

  const decision = useMutation<
    { kind: "approve"; transactionNumber: string | null } | { kind: "reject" },
    Error,
    Decision,
    DecisionContext
  >({
    mutationKey: DECISION_KEY,
    mutationFn: async (input) => {
      if (input.kind === "reject") {
        const { item, expectedLockVersion, reason } = input.request;
        await callServerFn(rejectInbox, {
          data: { inboxItemId: item.id, expectedLockVersion, reason },
        });
        return { kind: "reject" };
      }
      const { item, expectedRevision, expectedLockVersion, overrideReason } = input.request;
      const result = await callServerFn(approveInbox, {
        data: { inboxItemId: item.id, expectedRevision, expectedLockVersion, overrideReason },
      });
      return {
        kind: "approve",
        transactionNumber:
          result.approvalOutcome === "approved" ? (result.transactionNumber ?? null) : null,
      };
    },
    onMutate: async (input) => {
      const removed = input.request.item;
      await queryClient.cancelQueries({ queryKey: keys.inbox.v2List() });
      const list = queryClient.getQueryData<InboxV2List>(keys.inbox.v2List());
      const index = list ? list.items.findIndex((item) => item.id === removed.id) : -1;
      if (list && index >= 0) {
        queryClient.setQueryData<InboxV2List>(keys.inbox.v2List(), {
          ...list,
          items: list.items.filter((item) => item.id !== removed.id),
        });
      }
      const { visible: shown, activeId: current, onSelect: select } = latest.current;
      if (current !== removed.id) return { index };
      const position = shown.findIndex((item) => item.id === removed.id);
      const next = position >= 0 ? (shown[position + 1] ?? shown[position - 1]) : undefined;
      select(next?.id, { replace: true });
      return { index, advancedTo: next?.id };
    },
    onError: (error, input, context) => {
      const failed = input.request.item;
      if (context && context.index >= 0) {
        queryClient.setQueryData<InboxV2List>(keys.inbox.v2List(), (current) => {
          if (!current || current.items.some((item) => item.id === failed.id)) return current;
          const restored = [...current.items];
          restored.splice(Math.min(context.index, restored.length), 0, failed);
          return { ...current, items: restored };
        });
      }
      // Back to the failed item, unless the user has already moved somewhere else.
      if (context && "advancedTo" in context && latest.current.selectedId === context.advancedTo) {
        latest.current.onSelect(failed.id, { replace: true });
      }
      showToast(errorMessage(error), { icon: "error" });
    },
    onSuccess: (result, input) => {
      showToast(
        result.kind === "reject"
          ? "Rejected. The paper stays in Documents."
          : `Approved${result.transactionNumber ? ` as ${result.transactionNumber}` : ""}.`,
        { icon: "success" },
      );
      if (result.kind === "approve" && input.kind === "approve" && input.request.remember) {
        setRememberApproved(input.request.remember);
      }
    },
    onSettled: async () => {
      // Refresh once the last in-flight decision lands, so a refetch cannot resurrect a row
      // another optimistic decision just removed.
      if (queryClient.isMutating({ mutationKey: DECISION_KEY }) > 1) return;
      await Promise.all(
        [keys.inbox.all(), keys.bills.all(), keys.transactions.all(), keys.invoices.all()].map(
          (queryKey) => queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });

  const pendingItemId = decision.isPending ? decision.variables?.request.item.id : undefined;

  // ── Keyboard ──
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = inboxKeyAction(event);
      if (!action) return;
      const { visible: shown, activeId: current, onSelect: select } = latest.current;
      if (action === "next" || action === "previous") {
        if (shown.length === 0) return;
        const position = shown.findIndex((item) => item.id === current);
        const target =
          position < 0
            ? shown[action === "next" ? 0 : shown.length - 1]
            : shown[position + (action === "next" ? 1 : -1)];
        if (target) select(target.id);
      } else if (action === "approve") {
        paneRef.current?.approve();
      } else if (action === "reject") {
        paneRef.current?.startReject();
      } else {
        paneRef.current?.focusEditor();
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const pane = activeItem ? (
    <InboxV2Pane
      key={activeItem.id}
      ref={paneRef}
      item={activeItem}
      deciding={pendingItemId === activeItem.id}
      onApprove={(request) => decision.mutate({ kind: "approve", request })}
      onReject={(request) => decision.mutate({ kind: "reject", request })}
    />
  ) : null;

  const needYou = items.length;
  const beingRead = listQuery.data?.beingRead ?? 0;
  return (
    <main className="h-full overflow-hidden bg-slate-100 p-0 text-slate-900 sm:p-4 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto flex h-full max-w-[1680px] overflow-hidden border-slate-200 bg-white shadow-sm sm:rounded-xl sm:border dark:border-slate-800 dark:bg-slate-900">
        {/* ── List ── */}
        <div className="flex min-w-0 flex-1 flex-col border-slate-200 lg:max-w-[420px] lg:border-r dark:border-slate-800">
          <header className="shrink-0 border-b border-slate-200 px-4 pt-4 pb-3 dark:border-slate-800">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
                <p className="text-sm text-slate-500">
                  {listQuery.isPending
                    ? "Loading…"
                    : needYou === 0
                      ? "Nothing needs you."
                      : `${needYou}${listQuery.data?.truncated ? "+" : ""} need${needYou === 1 ? "s" : ""} you`}
                </p>
              </div>
              <a
                href="/transactions/new"
                className="shrink-0 rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
              >
                New transaction
              </a>
            </div>
            <div
              role="toolbar"
              aria-label="Filter by reason"
              className="mt-3 flex gap-1.5 overflow-x-auto pb-1"
            >
              {FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    filter === value
                      ? "border-teal-700 bg-teal-700 text-white"
                      : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {label}
                  <span className="ml-1.5 tabular-nums opacity-70">{counts.get(value) ?? 0}</span>
                </button>
              ))}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isPending && <ListSkeleton />}
            {beingRead > 0 && (
              // Not listed and not in the badge: nothing to do yet, but not silently missing.
              <p
                role="status"
                className="border-b border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500"
              >
                {beingRead === 1 ? "1 paper being read" : `${beingRead} papers being read`}
              </p>
            )}
            {listQuery.isError && (
              <div className="p-6">
                <EmptyState
                  size="sm"
                  tone="error"
                  icon={<AlertTriangleIcon size={28} strokeWidth={1.5} />}
                  title="Inbox could not be loaded"
                  description={errorMessage(listQuery.error)}
                  action={
                    <button
                      type="button"
                      onClick={() => listQuery.refetch()}
                      className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white"
                    >
                      Try again
                    </button>
                  }
                />
              </div>
            )}
            {listQuery.isSuccess && items.length === 0 && (
              <EmptyState
                size="md"
                tone="success"
                icon={<CheckCircleIcon size={32} strokeWidth={1.5} />}
                title="Nothing needs you."
                description="New papers land here only when they need a human."
              />
            )}
            {listQuery.isSuccess &&
              items.length > 0 &&
              visible.length === 0 &&
              filter !== "all" && (
                <div className="p-6 text-center text-sm text-slate-500">
                  <p>{EMPTY_FILTER_TEXT[filter]}</p>
                  <button
                    type="button"
                    onClick={() => setFilter("all")}
                    className="mt-2 text-xs font-semibold text-teal-700 hover:underline dark:text-teal-400"
                  >
                    Show all
                  </button>
                </div>
              )}
            {visible.length > 0 && (
              <ul aria-label="Items that need you">
                {visible.map((item) => (
                  <li key={item.id}>
                    <InboxV2Row
                      item={item}
                      active={item.id === activeId}
                      onSelect={() => onSelect(item.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ── Reading pane (desktop) ── */}
        {isDesktop && (
          <div className="min-w-0 flex-1 overflow-y-auto" aria-label="Reading pane">
            {pane ??
              (items.length > 0 && (
                <div className="flex h-full items-center justify-center p-8">
                  <EmptyState
                    size="sm"
                    icon={<PointerIcon size={28} strokeWidth={1.5} />}
                    title="Select an item"
                    description="Pick an item to review it in its editor. j and k move, a approves, r rejects, e edits."
                  />
                </div>
              ))}
          </div>
        )}
      </section>

      {rememberApproved && (
        <aside
          aria-label="Remember your last correction"
          className="fixed right-4 bottom-4 z-40 w-[min(30rem,calc(100vw-2rem))] rounded-2xl shadow-lg"
        >
          <p className="rounded-t-2xl bg-slate-800 px-4 py-2 text-xs font-medium text-white">
            You corrected {rememberApproved.who} before approving it.
          </p>
          <RememberThisPrompt
            key={`${rememberApproved.candidateId}:${rememberApproved.candidateRevision}`}
            candidateId={rememberApproved.candidateId}
            candidateRevision={rememberApproved.candidateRevision}
            onSaved={() => setRememberApproved(null)}
            onDismiss={() => setRememberApproved(null)}
          />
        </aside>
      )}

      {/* ── Reading drawer (below lg) ── */}
      {!isDesktop && pane && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={activeItem?.who ?? "Inbox item"}
          {...{ [INBOX_DRAWER_ATTRIBUTE]: "" }}
          className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-slate-900"
        >
          <div className="shrink-0 border-b border-slate-200 px-2 py-1 dark:border-slate-800">
            <button
              type="button"
              onClick={() => onSelect(undefined, { replace: true })}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
              Back to Inbox
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{pane}</div>
        </div>
      )}
    </main>
  );
}

function InboxV2Row({
  item,
  active,
  onSelect,
}: {
  item: InboxV2ListItem;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      data-item-id={item.id}
      className={`grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-3 text-left transition dark:border-slate-800 ${
        active
          ? "bg-teal-50/70 shadow-[inset_3px_0_0_#0f766e] dark:bg-teal-950/30"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
      }`}
    >
      <span className="truncate font-semibold">{item.who}</span>
      <span className="text-right font-semibold tabular-nums">
        {formatAmount(item.originalTotal, item.originalCurrency)}
      </span>
      <span className="truncate text-xs text-slate-500">
        {INBOX_V2_KIND_LABELS[item.kind]} · {formatRelativeTime(item.createdAt)}
      </span>
      <span className="justify-self-end">
        <ReasonChip reason={item.reason} />
      </span>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="animate-pulse" aria-label="Loading Inbox">
      {[1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="border-b border-slate-100 px-4 py-4 dark:border-slate-800">
          <div className="h-4 w-2/5 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-2 h-3 w-3/5 rounded bg-slate-100 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  );
}
