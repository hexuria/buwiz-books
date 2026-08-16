import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppErrorBoundary } from "@/components/error/AppErrorBoundary";
import { EmptyState, type EmptyStateTone } from "@/components/ui/EmptyState";
import { AlertTriangleIcon, CheckCircleIcon, PointerIcon, SearchIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { authClient } from "@/lib/auth-client";
import { keys } from "@/lib/query-keys";
import { usePermission, useRole } from "@/lib/use-permission";
import { callServerFn } from "@/lib/server-fn-client";
import {
  approveInbox,
  getDuplicateCase,
  getInboxItem,
  listInboxItems,
  previewDuplicateResolution,
  rejectInbox,
  resolveDuplicateCase,
  resolveInboxFinding,
  retryInboundEmailProcessing,
  updateInboxCandidate,
} from "./api/-inbox";
import {
  getInboxSettings,
  updateInboxSettings,
  generateInboundEmailAddress,
} from "./api/-inbox-settings";

type InboxSearch = {
  selected?: string;
  state?: string;
};

type CandidateCorrectionDraft = {
  transactionDate: string;
  transactionType: "pay_in" | "pay_out" | "journal" | "transfer";
  economicEventClass:
    | "purchase"
    | "sale"
    | "bill_accrual"
    | "bill_payment"
    | "invoice_accrual"
    | "invoice_payment"
    | "transfer"
    | "payroll"
    | "other";
  memo: string | null;
  referenceNumber: string | null;
  partyId: string | null;
  originalCurrency: string;
  exchangeRate: string | null;
  lines: Array<{
    accountId: string;
    debit: string | null;
    credit: string | null;
    lineDescription: string | null;
    departmentId: string | null;
    locationId: string | null;
  }>;
};

export const Route = createFileRoute("/inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    selected: typeof search.selected === "string" ? search.selected : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
  }),
  component: InboxRoute,
});

function InboxRoute() {
  return (
    <AppErrorBoundary contextLabel="Inbox">
      <InboxPage />
    </AppErrorBoundary>
  );
}

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

function InboxPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: session } = authClient.useSession();
  const { role } = useRole();
  const { canAccess: canApprove } = usePermission("inbox", "approve");
  const { canAccess: canReject } = usePermission("inbox", "reject");
  const { canAccess: canUpdate } = usePermission("inbox", "update");
  const { canAccess: canResolve } = usePermission("review", "resolve");
  const { canAccess: canConfigureInboundEmail } = usePermission("integration", "authorize");
  const [query, setQuery] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [inboundEmail, setInboundEmail] = useState("");
  const state = search.state ?? "open";

  const listQuery = useQuery({
    queryKey: keys.inbox.list({ state, search: query.trim() || undefined }),
    queryFn: () =>
      callServerFn(listInboxItems, {
        data: { state, search: query.trim() || undefined },
      }),
  });
  const items = listQuery.data ?? [];
  const selectedId = search.selected;
  const detailQuery = useQuery({
    queryKey: keys.inbox.detail(selectedId!),
    queryFn: () => callServerFn(getInboxItem, { data: { id: selectedId! } }),
    enabled: Boolean(selectedId),
  });
  const settingsQuery = useQuery({
    queryKey: keys.inbox.settings(),
    queryFn: () => callServerFn(getInboxSettings, { data: undefined }),
  });
  useEffect(() => {
    setInboundEmail(settingsQuery.data?.inboundEmailAddress ?? "");
  }, [settingsQuery.data?.inboundEmailAddress]);

  const ownerOverrideRequired = Boolean(
    role === "owner" &&
    settingsQuery.data?.requireDifferentApprover &&
    detailQuery.data?.item.submittedBy === session?.user.id,
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
  };
  const approveMutation = useMutation({
    mutationFn: () => {
      const detail = detailQuery.data;
      if (!detail) throw new Error("Inbox item is still loading.");
      return callServerFn(approveInbox, {
        data: {
          inboxItemId: detail.item.id,
          expectedRevision: detail.item.candidateRevision,
          expectedLockVersion: detail.item.lockVersion,
          overrideReason: overrideReason.trim() || undefined,
        },
      });
    },
    onSuccess: async (result) => {
      showToast(`Approved as ${result.transactionNumber ?? "a posted transaction"}.`, {
        icon: "success",
      });
      setOverrideReason("");
      await refresh();
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const rejectMutation = useMutation({
    mutationFn: () => {
      const detail = detailQuery.data;
      if (!detail) throw new Error("Inbox item is still loading.");
      return callServerFn(rejectInbox, {
        data: {
          inboxItemId: detail.item.id,
          expectedLockVersion: detail.item.lockVersion,
          reason: rejectReason,
        },
      });
    },
    onSuccess: async () => {
      showToast("Transaction rejected.", { icon: "success" });
      setRejectReason("");
      await refresh();
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const resolveMutation = useMutation({
    mutationFn: ({ findingId, note }: { findingId: string; note: string }) => {
      const detail = detailQuery.data;
      if (!detail) throw new Error("Inbox item is still loading.");
      return callServerFn(resolveInboxFinding, {
        data: {
          findingId,
          expectedLockVersion: detail.item.lockVersion,
          resolutionNote: note,
        },
      });
    },
    onSuccess: async () => {
      showToast("Finding resolved with an audit note.", { icon: "success" });
      await refresh();
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const retryProcessingMutation = useMutation({
    mutationFn: (emailId: string) =>
      callServerFn(retryInboundEmailProcessing, { data: { emailId } }),
    onSuccess: async () => {
      showToast("Reprocessing queued. This item will update shortly.", { icon: "success" });
      await refresh();
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const correctionMutation = useMutation({
    mutationFn: (draft: CandidateCorrectionDraft) => {
      const detail = detailQuery.data;
      if (!detail) throw new Error("Inbox item is still loading.");
      return callServerFn(updateInboxCandidate, {
        data: {
          inboxItemId: detail.item.id,
          expectedRevision: detail.item.candidateRevision,
          expectedLockVersion: detail.item.lockVersion,
          ...draft,
        },
      });
    },
    onSuccess: async () => {
      showToast("Accounting entry saved and Book checks refreshed.", { icon: "success" });
      await refresh();
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const settingsMutation = useMutation({
    mutationFn: () => {
      const settings = settingsQuery.data;
      if (!settings) throw new Error("Inbox settings are still loading.");
      return callServerFn(updateInboxSettings, {
        data: {
          inboundEmailAddress: inboundEmail.trim() || null,
          requireDifferentApprover: settings.requireDifferentApprover,
          allowOwnerOverride: settings.allowOwnerOverride,
        },
      });
    },
    onSuccess: async () => {
      showToast("Inbound email address saved.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.settings() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  const generateAddressMutation = useMutation({
    mutationFn: () => callServerFn(generateInboundEmailAddress, { data: undefined }),
    onSuccess: async (result: { inboundEmailAddress: string | null }) => {
      if (result?.inboundEmailAddress) setInboundEmail(result.inboundEmailAddress);
      showToast("Inbound address generated.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.settings() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  const [copiedAddress, setCopiedAddress] = useState(false);
  const copyInboundAddress = useCallback(() => {
    const addr = settingsQuery.data?.inboundEmailAddress;
    if (!addr) return;
    navigator.clipboard?.writeText(addr).then(() => {
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    });
  }, [settingsQuery.data?.inboundEmailAddress]);

  const openCount = useMemo(
    () => items.filter((item) => item.state === "ready_for_review").length,
    [items],
  );

  return (
    // `h-full`, not `100vh`: the shell owns the viewport and stacks a mobile app bar and tab bar,
    // so a viewport-height child overflows by exactly that chrome. `min-h-[680px]` went with it —
    // it forced a phone to scroll the whole three-pane frame rather than the list inside it.
    <main className="h-full overflow-hidden bg-slate-100 p-0 text-slate-900 sm:p-4 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto flex h-full max-w-[1680px] overflow-hidden border-slate-200 bg-white shadow-sm sm:rounded-xl sm:border dark:border-slate-800 dark:bg-slate-900">
        <aside className="hidden w-[240px] shrink-0 flex-col border-r border-slate-200 bg-slate-50 xl:flex dark:border-slate-800 dark:bg-slate-950/40">
          <div className="border-b border-slate-200 p-5 dark:border-slate-800">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-400">
              Review queue
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Inbox</h1>
            <p className="mt-1 text-sm text-slate-500">{openCount} ready for review</p>
          </div>
          <nav className="space-y-1 p-3" aria-label="Inbox filters">
            {[
              ["open", "Open"],
              ["ready_for_review", "Ready for review"],
              ["needs_information", "Needs information"],
              ["approved", "Approved"],
              ["rejected", "Rejected"],
              ["all", "All items"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() =>
                  navigate({
                    search: (previous) => ({ ...previous, state: value, selected: undefined }),
                  })
                }
                className={`flex h-10 w-full items-center justify-between rounded-md px-3 text-left text-sm font-medium transition-colors ${
                  state === value
                    ? "bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                <span>{label}</span>
                {value === "open" && (
                  <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                    {items.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t border-slate-200 p-4 dark:border-slate-800">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              Inbound email
            </p>
            {canConfigureInboundEmail ? (
              <div className="mt-2 space-y-2">
                <div className="flex items-center gap-1">
                  <input
                    type="email"
                    value={inboundEmail}
                    onChange={(event) => setInboundEmail(event.target.value)}
                    placeholder="bills@inbound.example.com"
                    aria-label="Inbound accounting email address"
                    className="h-9 min-h-11 lg:min-h-0 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-base sm:text-xs outline-none focus:border-teal-500 dark:border-slate-700 dark:bg-slate-900"
                  />
                  {settingsQuery.data?.inboundEmailAddress && (
                    <button
                      type="button"
                      onClick={copyInboundAddress}
                      title="Copy address"
                      className="h-9 min-h-11 lg:min-h-0 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-semibold transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                    >
                      {copiedAddress ? "Copied!" : "Copy"}
                    </button>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => settingsMutation.mutate()}
                    disabled={settingsMutation.isPending || !settingsQuery.data}
                    className="h-8 min-h-11 lg:min-h-0 flex-1 rounded-md border border-slate-300 bg-white text-xs font-semibold transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                  >
                    {settingsMutation.isPending ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => generateAddressMutation.mutate()}
                    disabled={generateAddressMutation.isPending}
                    title="Generate a unique inbound address for this organization"
                    className="h-8 min-h-11 lg:min-h-0 flex-1 rounded-md border border-teal-500 bg-teal-500 text-xs font-semibold text-white transition hover:bg-teal-600 disabled:opacity-50"
                  >
                    {generateAddressMutation.isPending ? "…" : "Generate"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1">
                <p className="min-w-0 flex-1 break-all text-xs leading-5 text-slate-500">
                  {settingsQuery.data?.inboundEmailAddress ?? "Not configured"}
                </p>
                {settingsQuery.data?.inboundEmailAddress && (
                  <button
                    type="button"
                    onClick={copyInboundAddress}
                    className="shrink-0 text-[11px] font-semibold text-teal-600 hover:underline dark:text-teal-400"
                  >
                    {copiedAddress ? "Copied!" : "Copy"}
                  </button>
                )}
              </div>
            )}
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Forward or email receipts, bills, and statements to this address — they'll appear here
              for review. Transactions stay outside the ledger until an authorized reviewer approves
              them.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Send them automatically with auto-forwarding:{" "}
              <a
                href="https://support.google.com/mail/answer/10957"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-teal-600 hover:underline dark:text-teal-400"
              >
                Gmail
              </a>{" "}
              ·{" "}
              <a
                href="https://support.microsoft.com/office/turn-on-automatic-forwarding-in-outlook-7f2670a1-7fff-4475-8a3c-5822d63b0c8e"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-teal-600 hover:underline dark:text-teal-400"
              >
                Outlook
              </a>
              .
            </p>
          </div>
        </aside>

        <section
          className={`${selectedId ? "hidden lg:flex" : "flex"} min-w-0 flex-1 flex-col border-r border-slate-200 dark:border-slate-800`}
        >
          {/* Filter + search + primary action do not fit one 375px row. Below `sm` the row wraps
              and the search takes the second line at full width; from `sm` it is a single row. */}
          <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 sm:h-[88px] sm:flex-nowrap sm:gap-3 sm:px-5 sm:py-0 dark:border-slate-800">
            <select
              value={state}
              onChange={(event) =>
                navigate({
                  search: (previous) => ({
                    ...previous,
                    state: event.target.value,
                    selected: undefined,
                  }),
                })
              }
              aria-label="Filter Inbox"
              className="h-10 flex-1 rounded-md border border-slate-200 bg-white px-2 text-base outline-none focus:border-teal-500 sm:max-w-36 sm:flex-none sm:text-sm xl:hidden dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="open">Open</option>
              <option value="ready_for_review">Ready</option>
              <option value="needs_information">Needs information</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="all">All items</option>
            </select>
            {/* `order-last w-full` drops search to its own line while the row is wrapping. */}
            <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400 dark:text-slate-500">
                <SearchIcon size={14} />
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search transactions"
                aria-label="Search Inbox"
                // 16px on mobile: anything smaller makes iOS Safari zoom the viewport on focus
                // and never zoom back out.
                className="h-10 w-full rounded-md border border-slate-200 bg-white pr-3 pl-9 text-base outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 sm:text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </div>
            <a
              href="/transactions/new"
              aria-label="New transaction"
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3 text-sm font-semibold whitespace-nowrap text-white transition hover:bg-teal-800 focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:outline-none sm:px-4"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                className="sm:hidden"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="hidden sm:inline">New transaction</span>
            </a>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isLoading && <InboxListSkeleton />}
            {listQuery.isError && (
              <EmptyPanel
                title="Inbox could not be loaded"
                detail={errorMessage(listQuery.error)}
                icon={<AlertTriangleIcon size={28} strokeWidth={1.5} />}
                tone="error"
                action={<button onClick={() => listQuery.refetch()}>Try again</button>}
              />
            )}
            {!listQuery.isLoading && !listQuery.isError && items.length === 0 && (
              <EmptyPanel
                title={query ? "No matching transactions" : "This queue is clear"}
                detail={
                  query
                    ? "Try a different transaction, vendor, or source name."
                    : "New transactions from uploads, email, imports, and connected sources will appear here."
                }
                // A cleared queue is good news and a fruitless search is not — the branch that
                // already varies the copy should vary the glyph too.
                icon={
                  query ? (
                    <SearchIcon size={28} strokeWidth={1.5} />
                  ) : (
                    <CheckCircleIcon size={28} strokeWidth={1.5} />
                  )
                }
                tone={query ? "neutral" : "success"}
              />
            )}
            {items.map((item) => {
              const active = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    navigate({ search: (previous) => ({ ...previous, selected: item.id }) })
                  }
                  className={`grid w-full grid-cols-[1fr_auto] gap-4 border-b border-slate-100 px-5 py-4 text-left transition dark:border-slate-800 ${
                    active
                      ? "bg-teal-50/70 shadow-[inset_3px_0_0_#0f766e] dark:bg-teal-950/30"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{item.title}</span>
                      {item.blockingFindingCount > 0 && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                          {item.blockingFindingCount} to fix
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-500">
                      {titleCase(item.sourceProvider)} · {titleCase(item.sourceChannel)} ·{" "}
                      {item.transactionDate}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">
                      {money(item.originalTotal, item.originalCurrency)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{titleCase(item.state)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <aside
          className={`${selectedId ? "block" : "hidden lg:block"} w-full shrink-0 overflow-y-auto bg-white lg:w-[340px] xl:w-[390px] dark:bg-slate-900`}
        >
          {/* Below `lg` this pane replaces the list entirely, so without this the only way back to
              the queue is the browser's back gesture. */}
          {selectedId && (
            <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-2 py-1 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-900/95">
              <button
                type="button"
                onClick={() =>
                  navigate({ search: (previous) => ({ ...previous, selected: undefined }) })
                }
                className="inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
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
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back to queue
              </button>
            </div>
          )}
          {!selectedId && (
            <EmptyPanel
              title="Select a transaction"
              detail="Choose an Inbox item to inspect its source, accounting entry, and review findings."
              icon={<PointerIcon size={28} strokeWidth={1.5} />}
            />
          )}
          {selectedId && detailQuery.isLoading && <DetailSkeleton />}
          {selectedId && detailQuery.isError && (
            <EmptyPanel
              title="Transaction could not be loaded"
              detail={errorMessage(detailQuery.error)}
              icon={<AlertTriangleIcon size={28} strokeWidth={1.5} />}
              tone="error"
              action={<button onClick={() => detailQuery.refetch()}>Try again</button>}
            />
          )}
          {detailQuery.data && (
            <InboxDetail
              key={`${detailQuery.data.item.id}:${detailQuery.data.candidate.revision}`}
              detail={detailQuery.data}
              canApprove={canApprove}
              canReject={canReject}
              canUpdate={canUpdate}
              canResolve={canResolve}
              isOwner={role === "owner"}
              ownerOverrideRequired={ownerOverrideRequired}
              ownerOverrideAllowed={settingsQuery.data?.allowOwnerOverride ?? false}
              onBack={() =>
                navigate({
                  search: (previous) => ({ ...previous, selected: undefined }),
                  replace: true,
                })
              }
              approvePending={approveMutation.isPending}
              rejectPending={rejectMutation.isPending}
              rejectReason={rejectReason}
              overrideReason={overrideReason}
              onRejectReason={setRejectReason}
              onOverrideReason={setOverrideReason}
              onApprove={() => approveMutation.mutate()}
              onReject={() => rejectMutation.mutate()}
              resolvePending={resolveMutation.isPending}
              onResolve={(findingId, note) => resolveMutation.mutate({ findingId, note })}
              retryProcessingPending={retryProcessingMutation.isPending}
              onRetryProcessing={(emailId) => retryProcessingMutation.mutate(emailId)}
              correctionPending={correctionMutation.isPending}
              onCorrect={(draft) => correctionMutation.mutate(draft)}
            />
          )}
        </aside>
      </section>
    </main>
  );
}

function InboxDetail({
  detail,
  canApprove,
  canReject,
  canUpdate,
  canResolve,
  isOwner,
  ownerOverrideRequired,
  ownerOverrideAllowed,
  onBack,
  approvePending,
  rejectPending,
  rejectReason,
  overrideReason,
  onRejectReason,
  onOverrideReason,
  onApprove,
  onReject,
  resolvePending,
  onResolve,
  retryProcessingPending,
  onRetryProcessing,
  correctionPending,
  onCorrect,
}: {
  detail: Awaited<ReturnType<typeof getInboxItem>>;
  canApprove: boolean;
  canReject: boolean;
  canUpdate: boolean;
  canResolve: boolean;
  isOwner: boolean;
  ownerOverrideRequired: boolean;
  ownerOverrideAllowed: boolean;
  onBack: () => void;
  approvePending: boolean;
  rejectPending: boolean;
  rejectReason: string;
  overrideReason: string;
  onRejectReason: (value: string) => void;
  onOverrideReason: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  resolvePending: boolean;
  onResolve: (findingId: string, note: string) => void;
  retryProcessingPending: boolean;
  onRetryProcessing: (emailId: string) => void;
  correctionPending: boolean;
  onCorrect: (draft: CandidateCorrectionDraft) => void;
}) {
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const blocking = detail.findings.filter(
    (finding) => finding.state === "open" && finding.impact === "blocking",
  );
  const resolved = ["approved", "rejected", "dismissed"].includes(detail.item.state);
  return (
    <div>
      <header className="border-b border-slate-200 bg-slate-950 px-6 py-6 text-white dark:border-slate-800">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 text-sm font-semibold text-teal-200 hover:text-white lg:hidden"
        >
          ← Back to Inbox
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-300">
              {titleCase(detail.source?.provider)} · {titleCase(detail.source?.channel)}
            </p>
            <h2 className="mt-2 truncate text-xl font-semibold">{detail.item.title}</h2>
            <p className="mt-1 text-sm text-slate-300">
              {detail.candidate.transactionDate} ·{" "}
              {money(detail.candidate.originalTotal, detail.candidate.originalCurrency)}
            </p>
          </div>
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium">
            {titleCase(detail.item.state)}
          </span>
        </div>
      </header>

      <div className="space-y-5 p-5">
        <DetailSection title="Source">
          <DetailRow label="Type" value={titleCase(detail.candidate.candidateType)} />
          <DetailRow label="Provider" value={titleCase(detail.source?.provider)} />
          <DetailRow label="Reference" value={detail.candidate.referenceNumber ?? "—"} />
          <DetailRow label="Submitted by" value={detail.submitterName ?? "Unknown user"} />
          <DetailRow label="Party" value={detail.partyName ?? "Not assigned"} />
        </DetailSection>

        <DetailSection title="Accounting entry">
          <AccountingEntryEditor
            key={`${detail.item.id}:${detail.candidate.revision}`}
            detail={detail}
            canUpdate={canUpdate && !resolved}
            pending={correctionPending}
            onSave={onCorrect}
          />
        </DetailSection>

        <DetailSection title={`Book findings (${blocking.length})`}>
          {detail.findings.length === 0 && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              All required bookkeeping checks passed.
            </div>
          )}
          <div className="space-y-2">
            {detail.findings.map((finding) => (
              <div
                key={finding.id}
                className={`rounded-md border p-3 ${
                  finding.state === "open"
                    ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                    : "border-slate-200 bg-slate-50 opacity-70 dark:border-slate-700 dark:bg-slate-800"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <p className="truncate text-sm font-semibold">{titleCase(finding.ruleKey)}</p>
                    <Link
                      to="/review-agents"
                      search={{ agent: finding.ruleKey }}
                      className="shrink-0 text-[11px] font-semibold text-teal-600 hover:underline dark:text-teal-400"
                    >
                      Agent settings
                    </Link>
                  </div>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    {finding.state}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{finding.message}</p>
                {finding.state === "open" &&
                  canResolve &&
                  finding.ruleKey === "source_processing_failed" &&
                  typeof (finding.evidence as { emailId?: unknown } | null)?.emailId ===
                    "string" && (
                    <button
                      type="button"
                      disabled={retryProcessingPending}
                      onClick={() =>
                        onRetryProcessing((finding.evidence as { emailId: string }).emailId)
                      }
                      className="mt-3 h-9 min-h-11 lg:min-h-0 rounded-md border border-teal-500 bg-teal-500 px-3 text-xs font-semibold text-white transition hover:bg-teal-600 disabled:opacity-50"
                    >
                      {retryProcessingPending ? "Queuing…" : "Retry processing"}
                    </button>
                  )}
                {finding.state === "open" &&
                  canResolve &&
                  finding.ruleKey !== "possible_duplicate" && (
                    <div className="mt-3 flex gap-2">
                      <input
                        value={resolutionNotes[finding.id] ?? ""}
                        onChange={(event) =>
                          setResolutionNotes((current) => ({
                            ...current,
                            [finding.id]: event.target.value,
                          }))
                        }
                        placeholder="Resolution or documented exception"
                        aria-label={`Resolution note for ${titleCase(finding.ruleKey)}`}
                        className="h-9 min-h-11 lg:min-h-0 min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-2 text-base sm:text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 dark:border-amber-900 dark:bg-slate-900"
                      />
                      <button
                        type="button"
                        disabled={
                          resolvePending || (resolutionNotes[finding.id]?.trim().length ?? 0) < 3
                        }
                        onClick={() => onResolve(finding.id, resolutionNotes[finding.id] ?? "")}
                        className="h-9 min-h-11 lg:min-h-0 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-slate-900 dark:text-amber-200"
                      >
                        Resolve
                      </button>
                    </div>
                  )}
                {finding.state === "open" && finding.ruleKey === "possible_duplicate" && (
                  <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">
                    {finding.impact === "blocking"
                      ? "Use the duplicate comparison below. A note alone cannot clear this finding."
                      : "The duplicate agent is currently non-blocking. This prior finding remains visible for audit."}
                  </p>
                )}
              </div>
            ))}
          </div>
        </DetailSection>

        {detail.duplicateCases.length > 0 && (
          <DetailSection title={`Duplicate review (${detail.duplicateCases.length})`}>
            <div className="space-y-3">
              {detail.duplicateCases.map((duplicateCase) => (
                <DuplicateCasePanel
                  key={duplicateCase.id}
                  duplicateCase={duplicateCase}
                  canResolve={canResolve}
                />
              ))}
            </div>
          </DetailSection>
        )}

        {detail.documents.length > 0 && (
          <DetailSection title={`Evidence (${detail.documents.length})`}>
            <div className="space-y-2">
              {detail.documents.map((document) => (
                <div
                  key={document.id}
                  className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700"
                >
                  <p className="truncate text-sm font-medium">
                    {document.displayTitle || document.filename}
                  </p>
                  <p className="text-xs text-slate-500">{titleCase(document.documentType)}</p>
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        {!resolved && detail.item.state === "ready_for_review" && (canApprove || canReject) && (
          <DetailSection title="Decision">
            {isOwner && ownerOverrideRequired && ownerOverrideAllowed && (
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Owner override reason
                <textarea
                  value={overrideReason}
                  onChange={(event) => onOverrideReason(event.target.value)}
                  placeholder="Required only when approving your own submission"
                  rows={2}
                  className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white p-2 text-base sm:text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
            )}
            {ownerOverrideRequired && !ownerOverrideAllowed && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                A different reviewer must approve this transaction. Owner overrides are disabled for
                this organization.
              </div>
            )}
            {canReject && (
              <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Rejection reason
                <textarea
                  value={rejectReason}
                  onChange={(event) => onRejectReason(event.target.value)}
                  placeholder="Explain what needs to change"
                  rows={2}
                  className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white p-2 text-base sm:text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {canReject && (
                <button
                  type="button"
                  onClick={onReject}
                  disabled={rejectPending || !rejectReason.trim()}
                  className="h-10 rounded-md border border-slate-300 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {rejectPending ? "Rejecting…" : "Reject"}
                </button>
              )}
              {canApprove && (
                <button
                  type="button"
                  onClick={onApprove}
                  disabled={
                    approvePending ||
                    blocking.length > 0 ||
                    (ownerOverrideRequired &&
                      (!ownerOverrideAllowed || overrideReason.trim().length === 0))
                  }
                  title={
                    blocking.length > 0
                      ? "Resolve all blocking Book findings before approval"
                      : ownerOverrideRequired && !ownerOverrideAllowed
                        ? "A different reviewer must approve this transaction"
                        : ownerOverrideRequired && overrideReason.trim().length === 0
                          ? "Enter an owner override reason before approving your own submission"
                          : undefined
                  }
                  className="h-10 rounded-md bg-teal-700 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
                >
                  {approvePending ? "Approving…" : "Approve & post"}
                </button>
              )}
            </div>
          </DetailSection>
        )}
        {!resolved && detail.item.state !== "ready_for_review" && (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            This source is still being processed or needs transaction details before it can be
            approved.
          </div>
        )}

        {detail.decisions.length > 0 && (
          <DetailSection title="Decision history">
            {detail.decisions.map((decision) => (
              <div key={decision.id} className="border-l-2 border-slate-200 py-1 pl-3 text-sm">
                <p className="font-medium">{titleCase(decision.decision)}</p>
                <p className="text-xs text-slate-500">
                  {decision.actorName ?? "Unknown user"} ·{" "}
                  {new Date(decision.createdAt).toLocaleString()}
                </p>
                {decision.reason && <p className="mt-1 text-slate-600">{decision.reason}</p>}
              </div>
            ))}
          </DetailSection>
        )}
      </div>
    </div>
  );
}

type InboxDetailData = Awaited<ReturnType<typeof getInboxItem>>;

type EditableAccountingLine = {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  lineDescription: string;
  departmentId: string;
  locationId: string;
};

function editableLines(detail: InboxDetailData): EditableAccountingLine[] {
  if (detail.lines.length === 0) {
    return [
      {
        key: crypto.randomUUID(),
        accountId: "",
        debit: "",
        credit: "",
        lineDescription: "",
        departmentId: "",
        locationId: "",
      },
      {
        key: crypto.randomUUID(),
        accountId: "",
        debit: "",
        credit: "",
        lineDescription: "",
        departmentId: "",
        locationId: "",
      },
    ];
  }
  return detail.lines.map((line) => ({
    key: line.id,
    accountId: line.accountId ?? "",
    debit: line.originalDebit ?? "",
    credit: line.originalCredit ?? "",
    lineDescription: line.lineDescription ?? "",
    departmentId: line.departmentId ?? "",
    locationId: line.locationId ?? "",
  }));
}

function AccountingEntryEditor({
  detail,
  canUpdate,
  pending,
  onSave,
}: {
  detail: InboxDetailData;
  canUpdate: boolean;
  pending: boolean;
  onSave: (draft: CandidateCorrectionDraft) => void;
}) {
  const requiresAccounts =
    detail.lines.length === 0 || detail.lines.some((line) => line.accountId === null);
  const [editing, setEditing] = useState(canUpdate && requiresAccounts);
  const [transactionDate, setTransactionDate] = useState(detail.candidate.transactionDate);
  const [transactionType, setTransactionType] = useState<
    CandidateCorrectionDraft["transactionType"]
  >(detail.candidate.transactionType as CandidateCorrectionDraft["transactionType"]);
  const [economicEventClass, setEconomicEventClass] = useState<
    CandidateCorrectionDraft["economicEventClass"]
  >(
    (detail.economicEvent?.economicEventClass as CandidateCorrectionDraft["economicEventClass"]) ??
      (detail.candidate.transactionType === "pay_out"
        ? "purchase"
        : detail.candidate.transactionType === "pay_in"
          ? "sale"
          : detail.candidate.transactionType === "transfer"
            ? "transfer"
            : "other"),
  );
  const [memo, setMemo] = useState(detail.candidate.memo ?? "");
  const [referenceNumber, setReferenceNumber] = useState(detail.candidate.referenceNumber ?? "");
  const [partyId, setPartyId] = useState(detail.candidate.partyId ?? "");
  const [originalCurrency, setOriginalCurrency] = useState(detail.candidate.originalCurrency);
  const [exchangeRate, setExchangeRate] = useState(detail.candidate.exchangeRate ?? "1");
  const [lines, setLines] = useState<EditableAccountingLine[]>(() => editableLines(detail));
  const updateLine = (key: string, patch: Partial<EditableAccountingLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };
  const addLine = () => {
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        accountId: "",
        debit: "",
        credit: "",
        lineDescription: "",
        departmentId: "",
        locationId: "",
      },
    ]);
  };
  const removeLine = (key: string) => {
    setLines((current) => current.filter((line) => line.key !== key));
  };
  const lineShapeValid = lines.every((line) => {
    const hasDebit = line.debit.trim().length > 0;
    const hasCredit = line.credit.trim().length > 0;
    return Boolean(line.accountId) && hasDebit !== hasCredit;
  });
  const requiresExchangeRate =
    originalCurrency.trim().toUpperCase() !== detail.candidate.functionalCurrency;
  const canSave =
    lines.length >= 2 &&
    lineShapeValid &&
    /^[A-Za-z]{3}$/.test(originalCurrency.trim()) &&
    (!requiresExchangeRate || exchangeRate.trim().length > 0);

  if (!editing) {
    return (
      <div>
        {detail.lines.length === 0 ? (
          <div className="rounded-md border border-dashed border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            No posting lines exist yet. Add both sides of the accounting entry before review.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
            {detail.lines.map((line) => (
              <div
                key={line.id}
                className="grid grid-cols-[1fr_auto] gap-3 border-b border-slate-100 px-3 py-3 last:border-0 dark:border-slate-800"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {line.accountNumber ? `${line.accountNumber} · ` : ""}
                    {line.accountName ?? "Account selection required"}
                  </p>
                  {line.lineDescription && (
                    <p className="mt-0.5 truncate text-xs text-slate-500">{line.lineDescription}</p>
                  )}
                </div>
                <div className="text-right text-sm tabular-nums">
                  {line.originalDebit && (
                    <p>{money(line.originalDebit, detail.candidate.originalCurrency)} Dr</p>
                  )}
                  {line.originalCredit && (
                    <p>{money(line.originalCredit, detail.candidate.originalCurrency)} Cr</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {detail.candidate.originalCurrency !== detail.candidate.functionalCurrency && (
          <p className="mt-2 text-xs text-slate-500">
            FX rate {detail.candidate.exchangeRate} · {detail.candidate.originalCurrency} to{" "}
            {detail.candidate.functionalCurrency}
          </p>
        )}
        {canUpdate && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mt-3 h-9 min-h-11 lg:min-h-0 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {detail.lines.length === 0 ? "Add accounting details" : "Edit accounting entry"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
        Extracted evidence may prefill the amount, but it never chooses the bank, card, cash,
        receivable, payable, or category accounts. Select both sides before saving.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Date
          <input
            type="date"
            value={transactionDate}
            onChange={(event) => setTransactionDate(event.target.value)}
            className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Type
          <select
            value={transactionType}
            onChange={(event) =>
              setTransactionType(event.target.value as CandidateCorrectionDraft["transactionType"])
            }
            className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="pay_out">Pay out</option>
            <option value="pay_in">Pay in</option>
            <option value="journal">Journal</option>
            <option value="transfer">Transfer</option>
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
        Economic event
        <select
          value={economicEventClass}
          disabled={detail.economicEvent?.reviewerEditable === false}
          onChange={(event) =>
            setEconomicEventClass(
              event.target.value as CandidateCorrectionDraft["economicEventClass"],
            )
          }
          className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:disabled:bg-slate-800"
        >
          <option value="purchase">Purchase</option>
          <option value="sale">Sale</option>
          <option value="bill_accrual">Bill accrual</option>
          <option value="bill_payment">Bill payment</option>
          <option value="invoice_accrual">Invoice accrual</option>
          <option value="invoice_payment">Invoice payment</option>
          <option value="transfer">Transfer</option>
          <option value="payroll">Payroll</option>
          <option value="other">Other</option>
        </select>
        {detail.economicEvent?.reviewerEditable === false && (
          <span className="mt-1 block font-normal text-slate-500">
            This event type comes from the connected provider and cannot be changed here.
          </span>
        )}
      </label>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
        Memo
        <input
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Reference
          <input
            value={referenceNumber}
            onChange={(event) => setReferenceNumber(event.target.value)}
            className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Vendor or customer
          <select
            value={partyId}
            onChange={(event) => setPartyId(event.target.value)}
            className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Not assigned</option>
            {detail.partyOptions.map((party) => (
              <option key={party.id} value={party.id}>
                {party.name} · {titleCase(party.partyType)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Currency
          <input
            value={originalCurrency}
            maxLength={3}
            onChange={(event) => setOriginalCurrency(event.target.value.toUpperCase())}
            className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm uppercase dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        {requiresExchangeRate && (
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            FX rate to {detail.candidate.functionalCurrency}
            <input
              inputMode="decimal"
              value={exchangeRate}
              onChange={(event) => setExchangeRate(event.target.value)}
              className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        )}
      </div>
      <div className="space-y-2">
        {lines.map((line, index) => (
          <div
            key={line.key}
            className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Line {index + 1}
              </span>
              {lines.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeLine(line.key)}
                  className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                >
                  Remove
                </button>
              )}
            </div>
            <select
              value={line.accountId}
              aria-label={`Account for line ${index + 1}`}
              onChange={(event) => updateLine(line.key, { accountId: event.target.value })}
              className="mt-2 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">Choose a leaf account</option>
              {detail.accountOptions.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.accountNumber ? `${account.accountNumber} · ` : ""}
                  {account.name}
                </option>
              ))}
            </select>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-500">
                Debit
                <input
                  inputMode="decimal"
                  value={line.debit}
                  onChange={(event) =>
                    updateLine(line.key, { debit: event.target.value, credit: "" })
                  }
                  className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-base sm:text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="text-xs text-slate-500">
                Credit
                <input
                  inputMode="decimal"
                  value={line.credit}
                  onChange={(event) =>
                    updateLine(line.key, { credit: event.target.value, debit: "" })
                  }
                  className="mt-1 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-base sm:text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
            </div>
            <input
              value={line.lineDescription}
              onChange={(event) => updateLine(line.key, { lineDescription: event.target.value })}
              placeholder="Line description"
              aria-label={`Description for line ${index + 1}`}
              className="mt-2 h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <select
                value={line.departmentId}
                aria-label={`Department for line ${index + 1}`}
                onChange={(event) => updateLine(line.key, { departmentId: event.target.value })}
                className="h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="">No department</option>
                {detail.departmentOptions.map((dimension) => (
                  <option key={dimension.id} value={dimension.id}>
                    {dimension.name}
                  </option>
                ))}
              </select>
              <select
                value={line.locationId}
                aria-label={`Location for line ${index + 1}`}
                onChange={(event) => updateLine(line.key, { locationId: event.target.value })}
                className="h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-2 text-base sm:text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="">No location</option>
                {detail.locationOptions.map((dimension) => (
                  <option key={dimension.id} value={dimension.id}>
                    {dimension.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addLine}
        className="h-9 min-h-11 lg:min-h-0 w-full rounded-md border border-dashed border-slate-300 text-xs font-semibold text-slate-600 transition hover:border-teal-500 hover:text-teal-700 dark:border-slate-700 dark:text-slate-300"
      >
        Add posting line
      </button>
      <div className="grid grid-cols-2 gap-2">
        {!requiresAccounts && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={pending}
            className="h-10 rounded-md border border-slate-300 text-sm font-semibold text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={!canSave || pending}
          onClick={() =>
            onSave({
              transactionDate,
              transactionType,
              economicEventClass,
              memo: memo.trim() || null,
              referenceNumber: referenceNumber.trim() || null,
              partyId: partyId || null,
              originalCurrency: originalCurrency.trim().toUpperCase(),
              exchangeRate: requiresExchangeRate ? exchangeRate.trim() || null : "1",
              lines: lines.map((line) => ({
                accountId: line.accountId,
                debit: line.debit.trim() || null,
                credit: line.credit.trim() || null,
                lineDescription: line.lineDescription.trim() || null,
                departmentId: line.departmentId || null,
                locationId: line.locationId || null,
              })),
            })
          }
          className="h-10 rounded-md bg-teal-700 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
        >
          {pending ? "Saving…" : "Save & run Book checks"}
        </button>
      </div>
    </div>
  );
}

type DuplicateCaseSummary = Awaited<ReturnType<typeof getInboxItem>>["duplicateCases"][number];
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

function DuplicateCasePanel({
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

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[100px_1fr] border-b border-slate-100 py-2 text-sm last:border-0 dark:border-slate-800">
      <span className="text-slate-500">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

/**
 * Route-local wrapper around the shared EmptyState: it owns the split-pane sizing and the
 * `[&_button]:` action styling, neither of which belongs in the shared component.
 *
 * `icon` is required on purpose. This used to render one grey square for four semantically
 * different states, and a required prop is what stops a future call site recreating it.
 */
function EmptyPanel({
  title,
  detail,
  icon,
  tone = "neutral",
  action,
}: {
  title: string;
  detail: string;
  icon: React.ReactNode;
  tone?: EmptyStateTone;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[300px] items-center justify-center p-8 text-center">
      <EmptyState
        size="sm"
        tone={tone}
        icon={icon}
        title={title}
        description={detail}
        action={
          action && (
            <div className="[&_button]:rounded-md [&_button]:bg-teal-700 [&_button]:px-4 [&_button]:py-2 [&_button]:text-sm [&_button]:font-semibold [&_button]:text-white">
              {action}
            </div>
          )
        }
      />
    </div>
  );
}

function InboxListSkeleton() {
  return (
    <div className="animate-pulse">
      {[1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="border-b border-slate-100 px-5 py-5 dark:border-slate-800">
          <div className="h-4 w-2/5 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-2 h-3 w-3/5 rounded bg-slate-100 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse p-6">
      <div className="h-5 w-2/3 rounded bg-slate-200 dark:bg-slate-700" />
      <div className="mt-3 h-4 w-1/3 rounded bg-slate-100 dark:bg-slate-800" />
      {[1, 2, 3].map((item) => (
        <div key={item} className="mt-8 space-y-2">
          <div className="h-3 w-1/4 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-16 rounded bg-slate-100 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  );
}
