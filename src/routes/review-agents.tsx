import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppErrorBoundary } from "@/components/error/AppErrorBoundary";
import { EmptyCatalogNotice } from "@/components/review-agents/EmptyCatalogNotice";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BoltIcon,
  CheckCircleIcon,
  ClockIcon,
  LockIcon,
  PlayIcon,
} from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import DayPicker from "@/components/ui/DayPicker";
import { keys } from "@/lib/query-keys";
import {
  buildAgentConfigPayload,
  CADENCE_COPY,
  getAgentSchema,
  splitStoredConfig,
  validateAgentConfig,
  type AgentConfigField,
  type AgentConfirmCopy,
} from "@/lib/review-agents/agent-config-schema";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import {
  listReviewAgents,
  listReviewFindings,
  listReviewRuns,
  resolveReviewFinding,
  runReviewAgents,
  updateReviewAgent,
} from "./api/-review-agents";

type ReviewAgentsSearch = {
  agent?: string;
  findings?: "all";
};

export const Route = createFileRoute("/review-agents")({
  validateSearch: (search: Record<string, unknown>): ReviewAgentsSearch => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
    findings: search.findings === "all" ? "all" : undefined,
  }),
  component: () => (
    <AppErrorBoundary contextLabel="Review agents">
      <ReviewAgentsPage />
    </AppErrorBoundary>
  ),
});

type Agent = Awaited<ReturnType<typeof listReviewAgents>>[number];
type Finding = Awaited<ReturnType<typeof listReviewFindings>>["findings"][number];

const GROUPS = ["book", "review", "system"] as const;
type Group = (typeof GROUPS)[number];

const GROUP_LABEL: Record<Group, string> = {
  book: "Book agents",
  review: "Review agents",
  system: "System",
};

const GROUP_CADENCE: Record<Group, string> = {
  book: "Automatic · at ingest",
  review: "On demand · across the ledger",
  system: "Raised by inbound processing",
};

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(value: string | null, currency: string | null) {
  if (!value) return null;
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

function formatMonth(value: string | null) {
  if (!value) return null;
  const parsed = new Date(`${value}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================================
// Page
// ============================================================================

function ReviewAgentsPage() {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { canAccess: canConfigure } = usePermission("agentRule", "configure");
  const { canAccess: canRun } = usePermission("agentRule", "run");
  const { canAccess: canResolve } = usePermission("review", "resolve");

  const [asOfDate, setAsOfDate] = useState(todayIso);
  const [lastRun, setLastRun] = useState<{
    ruleCount: number;
    findings: number;
    asOfDate: string;
  } | null>(null);
  const [pendingAgentKey, setPendingAgentKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const agentsQuery = useQuery({
    queryKey: keys.reviewAgents.list(),
    queryFn: () => callServerFn(listReviewAgents, { data: undefined }),
  });
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const selected = agents.find((agent) => agent.key === search.agent) ?? agents[0];

  const selectAgent = (key: string) => {
    // Switching remounts the editor, which would otherwise silently drop unsaved edits.
    if (dirty && selected && key !== selected.key) {
      setPendingAgentKey(key);
      return;
    }
    navigate({ search: (previous) => ({ ...previous, agent: key }) });
  };

  /**
   * Covers leaving the page entirely — browser back/forward, a sidebar link, closing the tab.
   * Deliberately scoped to a route change: switching agents is a search-param navigation within
   * this same route, and `selectAgent` already guards that with its own confirm bar.
   */
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && next.routeId !== current.routeId,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const runMutation = useMutation({
    mutationFn: (ruleKeys?: string[]) =>
      callServerFn(runReviewAgents, { data: { asOfDate, ruleKeys } }),
    onSuccess: async (result) => {
      const findings = result.rules.reduce((sum, rule) => sum + rule.findingCount, 0);
      setLastRun({ ruleCount: result.rules.length, findings, asOfDate: result.asOfDate });
      showToast(
        findings === 0
          ? "Review run finished — no findings."
          : `Review run finished — ${findings} finding${findings === 1 ? "" : "s"}.`,
        { icon: "success" },
      );
      await queryClient.invalidateQueries({ queryKey: keys.reviewAgents.all() });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
    onError: (error) => showToast(errorMessage(error, "Review run failed."), { icon: "error" }),
  });

  const groups = useMemo(
    () =>
      Object.fromEntries(
        GROUPS.map((group) => [group, agents.filter((agent) => agent.group === group)]),
      ) as Record<Group, Agent[]>,
    [agents],
  );
  const runnableCount = groups.review.filter((agent) => agent.enabled).length;

  if (agentsQuery.isLoading) return <PageSkeleton />;

  if (agentsQuery.isError) {
    return (
      <PageShell>
        <PageHeader canRun={false} />
        <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <EmptyState
            size="md"
            tone="error"
            icon={<AlertTriangleIcon size={36} strokeWidth={1.5} />}
            title="Review agents could not be loaded"
            description={errorMessage(agentsQuery.error, "Please try again.")}
            action={
              <button
                type="button"
                onClick={() => agentsQuery.refetch()}
                className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800"
              >
                Try again
              </button>
            }
          />
        </div>
      </PageShell>
    );
  }

  // Replaces the whole two-column section, not just its right pane.
  if (agents.length === 0) {
    return (
      <PageShell>
        <PageHeader canRun={false} />
        <EmptyCatalogNotice onReload={() => agentsQuery.refetch()} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        canRun={canRun}
        asOfDate={asOfDate}
        onAsOfDateChange={setAsOfDate}
        onRun={() => runMutation.mutate(undefined)}
        running={runMutation.isPending}
        runnableCount={runnableCount}
      />

      <HowThisWorks />

      {blocker.status === "blocked" && (
        <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            You have unsaved agent settings. Leave this page and discard them?
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDirty(false);
                blocker.proceed();
              }}
              className="h-9 min-h-11 lg:min-h-0 rounded-md bg-amber-600 px-3 text-xs font-semibold text-white transition hover:bg-amber-700"
            >
              Discard and leave
            </button>
            <button
              type="button"
              onClick={() => blocker.reset()}
              className="h-9 min-h-11 lg:min-h-0 rounded-md border border-amber-300 px-3 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:text-amber-100"
            >
              Stay on this page
            </button>
          </div>
        </div>
      )}

      {lastRun && (
        <div className="mb-5 flex items-start justify-between gap-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm dark:border-teal-900 dark:bg-teal-950/40">
          <p className="text-teal-900 dark:text-teal-100">
            Ran {lastRun.ruleCount} agent{lastRun.ruleCount === 1 ? "" : "s"} as of{" "}
            {lastRun.asOfDate} · {lastRun.findings} finding{lastRun.findings === 1 ? "" : "s"}
          </p>
          <button
            type="button"
            onClick={() => setLastRun(null)}
            className="shrink-0 text-xs font-semibold text-teal-700 hover:underline dark:text-teal-300"
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="grid grid-cols-1 sm:min-h-[680px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[320px_1fr] dark:border-slate-800 dark:bg-slate-900">
        <aside className="hidden border-r border-slate-200 lg:block dark:border-slate-800">
          {GROUPS.map((group) =>
            groups[group].length === 0 ? null : (
              <div key={group}>
                <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/40">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    {GROUP_LABEL[group]}
                  </p>
                  <p className="mt-0.5 text-[11px] font-medium text-slate-400">
                    {GROUP_CADENCE[group]}
                  </p>
                </div>
                {groups[group].map((agent) => (
                  <button
                    key={agent.key}
                    type="button"
                    onClick={() => selectAgent(agent.key)}
                    aria-current={selected?.key === agent.key ? "true" : undefined}
                    className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition dark:border-slate-800 ${
                      selected?.key === agent.key
                        ? "bg-teal-50 text-teal-900 dark:bg-teal-950/40 dark:text-teal-100"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        agent.enabled ? "bg-teal-500" : "bg-slate-300 dark:bg-slate-700"
                      }`}
                    />
                    <span className="sr-only">{agent.enabled ? "Enabled" : "Disabled"}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {agent.name}
                    </span>
                    {agent.openFindingCount > 0 && (
                      <span
                        title={`${agent.openFindingCount} open findings`}
                        className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                      >
                        {agent.openFindingCount}
                        <span className="sr-only"> open findings</span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ),
          )}
        </aside>

        <div className="min-w-0 p-4 sm:p-7">
          <select
            value={selected?.key ?? ""}
            onChange={(event) => selectAgent(event.target.value)}
            aria-label="Select review agent"
            className="mb-6 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-base sm:text-sm font-semibold outline-none focus:border-teal-500 lg:hidden dark:border-slate-700 dark:bg-slate-900"
          >
            {GROUPS.map((group) =>
              groups[group].length === 0 ? null : (
                <optgroup key={group} label={GROUP_LABEL[group]}>
                  {groups[group].map((agent) => (
                    <option key={agent.key} value={agent.key}>
                      {agent.name}
                      {agent.openFindingCount > 0 ? ` (${agent.openFindingCount})` : ""}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>

          {pendingAgentKey && (
            <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                You have unsaved changes to {selected?.name}. Discard them and open{" "}
                {agents.find((agent) => agent.key === pendingAgentKey)?.name}?
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const target = pendingAgentKey;
                    setPendingAgentKey(null);
                    setDirty(false);
                    navigate({ search: (previous) => ({ ...previous, agent: target }) });
                  }}
                  className="h-9 min-h-11 lg:min-h-0 rounded-md bg-amber-600 px-3 text-xs font-semibold text-white transition hover:bg-amber-700"
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAgentKey(null)}
                  className="h-9 min-h-11 lg:min-h-0 rounded-md border border-amber-300 px-3 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:text-amber-100"
                >
                  Keep editing
                </button>
              </div>
            </div>
          )}

          {selected && (
            <AgentDetail
              key={`${selected.key}:${selected.version}`}
              agent={selected}
              canConfigure={canConfigure}
              canResolve={canResolve}
              canRun={canRun}
              showAllFindings={search.findings === "all"}
              onToggleFindings={(all) =>
                navigate({
                  search: (previous) => ({ ...previous, findings: all ? "all" : undefined }),
                })
              }
              onDirtyChange={setDirty}
              onRunAgent={() => runMutation.mutate([selected.key])}
              running={runMutation.isPending}
              onSaved={async () => {
                setDirty(false);
                await queryClient.invalidateQueries({ queryKey: keys.reviewAgents.all() });
                showToast(`${selected.name} settings saved.`, { icon: "success" });
              }}
              onError={(message) => showToast(message, { icon: "error" })}
            />
          )}
        </div>
      </section>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-full bg-slate-100 p-3 text-slate-900 sm:p-6 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-6xl">{children}</div>
    </main>
  );
}

function PageHeader({
  canRun,
  asOfDate,
  onAsOfDateChange,
  onRun,
  running,
  runnableCount,
}: {
  canRun: boolean;
  asOfDate?: string;
  onAsOfDateChange?: (value: string) => void;
  onRun?: () => void;
  running?: boolean;
  runnableCount?: number;
}) {
  const disabledReason =
    runnableCount === undefined
      ? "There are no agents to run."
      : runnableCount === 0
        ? "All review agents are turned off."
        : undefined;
  return (
    <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-400">
          Automated review
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Review agents</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
          Deterministic checks that read your books and raise findings for a person to clear. An
          agent never edits a transaction — it flags one and records who resolved it.
        </p>
      </div>
      {canRun && onRun && onAsOfDateChange && asOfDate ? (
        <div className="w-full shrink-0 sm:w-auto">
          <div className="flex flex-wrap items-end gap-2 sm:gap-3">
            <label className="text-xs font-medium text-slate-500">
              As of
              <div className="mt-1">
                <DayPicker value={asOfDate} onChange={onAsOfDateChange} variant="form" />
              </div>
            </label>
            <button
              type="button"
              onClick={onRun}
              disabled={running || Boolean(disabledReason)}
              title={disabledReason}
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-semibold whitespace-nowrap text-white transition hover:bg-teal-800 disabled:opacity-60 sm:flex-none"
            >
              {running ? (
                <>
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                  />
                  Running…
                </>
              ) : (
                <>
                  <PlayIcon size={14} />
                  Run review agents
                </>
              )}
            </button>
          </div>
          <p className="mt-2 max-w-xs text-left text-xs leading-4 text-slate-400 sm:text-right sm:text-[11px]">
            Agents evaluate the ledger as if today were this date. Set it to a period end to
            reproduce a close.
          </p>
        </div>
      ) : (
        <p className="shrink-0 text-xs text-slate-500">
          Running agents requires the “run agent rules” permission.
        </p>
      )}
    </header>
  );
}

/**
 * The strip that answers "how does this page work" without being asked. Not dismissible — this
 * page is visited rarely enough that a dismissed explainer is a bug.
 */
function HowThisWorks() {
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2">
      <article className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-teal-500/10 text-teal-600 dark:text-teal-400">
            <BoltIcon size={16} />
          </span>
          <h2 className="text-sm font-semibold">Book agents run automatically</h2>
        </div>
        <p className="mt-2 text-[13px] leading-6 text-slate-500">
          Nine checks fire the moment a transaction reaches the Inbox — uncategorized, missing
          vendor, missing receipt, possible duplicate and more. Their findings sit on the
          transaction and block approval until someone clears them. Nothing to run here.
        </p>
        <Link
          to="/inbox"
          search={{ state: "open" }}
          className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-400"
        >
          Review them in the Inbox
          <ArrowRightIcon size={12} />
        </Link>
      </article>
      <article className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <PlayIcon size={14} />
          </span>
          <h2 className="text-sm font-semibold">Review agents run when you ask</h2>
        </div>
        <p className="mt-2 text-[13px] leading-6 text-slate-500">
          Five checks scan the posted ledger for period-close problems — unusual spend, non-zero
          clearing balances, material expense, material asset, and postings to a parent category.
          Nothing runs until you press Run review agents.
        </p>
        <p className="mt-3 text-[13px] text-slate-400">
          Findings appear on the agent you select below.
        </p>
      </article>
    </div>
  );
}

function PageSkeleton() {
  return (
    <PageShell>
      <PageHeader canRun={false} />
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          />
        ))}
      </div>
      <section className="grid grid-cols-1 sm:min-h-[680px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[320px_1fr] dark:border-slate-800 dark:bg-slate-900">
        <aside className="hidden animate-pulse border-r border-slate-200 lg:block dark:border-slate-800">
          {(["book", "review"] as const).map((group) => (
            <div key={group}>
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/40">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {GROUP_LABEL[group]}
                </p>
              </div>
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className="border-b border-slate-100 px-4 py-3 dark:border-slate-800"
                >
                  <div className="h-4 w-3/5 rounded bg-slate-200 dark:bg-slate-700" />
                </div>
              ))}
            </div>
          ))}
        </aside>
        <div className="min-w-0 animate-pulse space-y-6 p-4 sm:p-7">
          <div className="h-8 w-1/3 rounded bg-slate-200 dark:bg-slate-700" />
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-24 rounded-lg bg-slate-100 dark:bg-slate-800" />
          ))}
        </div>
      </section>
    </PageShell>
  );
}

// ============================================================================
// Agent detail
// ============================================================================

function AgentDetail({
  agent,
  canConfigure,
  canResolve,
  canRun,
  showAllFindings,
  onToggleFindings,
  onDirtyChange,
  onRunAgent,
  running,
  onSaved,
  onError,
}: {
  agent: Agent;
  canConfigure: boolean;
  canResolve: boolean;
  canRun: boolean;
  showAllFindings: boolean;
  onToggleFindings: (all: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRunAgent: () => void;
  running: boolean;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const schema = getAgentSchema(agent.key);
  const editable = canConfigure && agent.configurable;
  const cadence = schema?.cadence ?? (agent.group === "review" ? "on_demand" : "ingest");
  const runnable = cadence === "on_demand" || cadence === "ingest_and_on_demand";

  return (
    <div className="max-w-3xl">
      <div className="min-w-0">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {GROUP_LABEL[agent.group as Group] ?? titleCase(agent.group)}
        </span>
        <h2 className="mt-2 text-2xl font-semibold">{agent.name}</h2>
        <p className="mt-2 leading-6 text-slate-600 dark:text-slate-300">{agent.description}</p>
        <p className="mt-2 text-[13px] text-slate-500">{CADENCE_COPY[cadence]}</p>
        {schema?.cadenceNote && (
          <p className="mt-1 text-[13px] text-slate-400">{schema.cadenceNote}</p>
        )}
      </div>

      {!agent.configurable && (
        <Banner
          icon={<LockIcon size={16} />}
          text="This is a system agent. It is raised automatically by inbound processing and has no settings to change."
        />
      )}
      {agent.configurable && !canConfigure && (
        <Banner
          icon={<LockIcon size={16} />}
          text="You can view these settings but not change them. Ask an owner or admin for the “configure agent rules” permission."
        />
      )}

      <FindingsPanel
        agent={agent}
        canResolve={canResolve}
        canRun={canRun}
        runnable={runnable}
        showAll={showAllFindings}
        onToggle={onToggleFindings}
        onRunAgent={onRunAgent}
        running={running}
        onError={onError}
      />

      {schema && schema.method.length > 0 && (
        <section className="mt-8 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="border-b border-slate-200 px-5 py-3 dark:border-slate-700">
            <h3 className="font-semibold">What this agent checks</h3>
          </div>
          <ol className="space-y-4 p-5 text-sm">
            {schema.method.map((step, index) => (
              <li key={step} className="grid grid-cols-[24px_1fr] gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold dark:bg-slate-800">
                  {index + 1}
                </span>
                <span className="leading-6">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {agent.configurable && (
        <AgentConfigForm
          agent={agent}
          editable={editable}
          onDirtyChange={onDirtyChange}
          onSaved={onSaved}
          onError={onError}
        />
      )}

      {runnable && <RunHistory ruleKey={agent.key} />}
    </div>
  );
}

function Banner({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div
      role="status"
      className="mt-5 flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

// ============================================================================
// Findings
// ============================================================================

function FindingsPanel({
  agent,
  canResolve,
  canRun,
  runnable,
  showAll,
  onToggle,
  onRunAgent,
  running,
  onError,
}: {
  agent: Agent;
  canResolve: boolean;
  canRun: boolean;
  runnable: boolean;
  showAll: boolean;
  onToggle: (all: boolean) => void;
  onRunAgent: () => void;
  running: boolean;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const state = showAll ? "all" : "open";
  const [notes, setNotes] = useState<Record<string, string>>({});

  const findingsQuery = useQuery({
    queryKey: keys.reviewAgents.findings(agent.key, { state }),
    queryFn: () =>
      callServerFn(listReviewFindings, { data: { ruleKey: agent.key, state, limit: 50 } }),
  });

  const resolveMutation = useMutation({
    mutationFn: (input: { findingId: string; resolutionNote: string }) =>
      callServerFn(resolveReviewFinding, { data: input }),
    onSuccess: async () => {
      showToast("Finding resolved.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.reviewAgents.all() });
    },
    onError: (error) => onError(errorMessage(error, "Finding could not be resolved.")),
  });

  const findings = findingsQuery.data?.findings ?? [];

  return (
    <section className="mt-8 rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Findings</h3>
          {agent.openFindingCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {agent.openFindingCount} open
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {runnable && canRun && (
            <button
              type="button"
              onClick={onRunAgent}
              disabled={running || !agent.enabled}
              title={agent.enabled ? undefined : "This agent is turned off."}
              className="inline-flex h-8 min-h-11 lg:min-h-0 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-xs font-semibold transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <PlayIcon size={12} />
              {running ? "Running…" : "Run this agent"}
            </button>
          )}
          <div className="flex overflow-hidden rounded-md border border-slate-200 text-xs font-semibold dark:border-slate-700">
            <button
              type="button"
              onClick={() => onToggle(false)}
              className={`px-3 py-1.5 transition ${!showAll ? "bg-slate-100 dark:bg-slate-800" : ""}`}
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => onToggle(true)}
              className={`px-3 py-1.5 transition ${showAll ? "bg-slate-100 dark:bg-slate-800" : ""}`}
            >
              All
            </button>
          </div>
        </div>
      </div>

      <div className="p-5">
        {findingsQuery.isLoading && (
          <div className="space-y-3">
            {[0, 1].map((index) => (
              <div
                key={index}
                className="h-16 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800"
              />
            ))}
          </div>
        )}
        {findingsQuery.isError && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {errorMessage(findingsQuery.error, "Findings could not be loaded.")}
          </p>
        )}
        {!findingsQuery.isLoading && !findingsQuery.isError && findings.length === 0 && (
          <FindingsEmptyState agent={agent} runnable={runnable} showAll={showAll} />
        )}
        {findings.length > 0 && (
          <ul className="space-y-4">
            {findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                canResolve={canResolve}
                note={notes[finding.id] ?? ""}
                onNoteChange={(value) =>
                  setNotes((current) => ({ ...current, [finding.id]: value }))
                }
                onResolve={() =>
                  resolveMutation.mutate({
                    findingId: finding.id,
                    resolutionNote: (notes[finding.id] ?? "").trim(),
                  })
                }
                resolvePending={resolveMutation.isPending}
              />
            ))}
          </ul>
        )}
        {findingsQuery.data?.nextCursor && (
          <p className="mt-4 text-xs text-slate-500">
            Showing the {findings.length} most recent findings. Resolve these to see older ones.
          </p>
        )}
      </div>
    </section>
  );
}

function FindingsEmptyState({
  agent,
  runnable,
  showAll,
}: {
  agent: Agent;
  runnable: boolean;
  showAll: boolean;
}) {
  if (!agent.enabled) {
    return (
      <EmptyState
        icon={<LockIcon size={28} strokeWidth={1.5} />}
        title="This agent is turned off"
        description="Turn it on below and run it to see findings."
      />
    );
  }
  if (!runnable) {
    return (
      <EmptyState
        tone="success"
        icon={<CheckCircleIcon size={28} strokeWidth={1.5} />}
        title={showAll ? "No findings recorded" : "No open findings"}
        description="Every transaction currently in the Inbox passes this check."
      />
    );
  }
  if (!agent.lastRunAt) {
    return (
      <EmptyState
        tone="info"
        icon={<PlayIcon size={28} strokeWidth={1.5} />}
        title="This agent hasn't run yet"
        description="Press Run review agents to scan the ledger as of the date in the header."
      />
    );
  }
  return (
    <EmptyState
      tone="success"
      icon={<CheckCircleIcon size={28} strokeWidth={1.5} />}
      title={showAll ? "No findings recorded" : "No open findings"}
      description={`The last run on ${new Date(agent.lastRunAt).toLocaleDateString()} flagged nothing.`}
    />
  );
}

function FindingRow({
  finding,
  canResolve,
  note,
  onNoteChange,
  onResolve,
  resolvePending,
}: {
  finding: Finding;
  canResolve: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onResolve: () => void;
  resolvePending: boolean;
}) {
  const open = finding.state === "open";
  const amount = money(finding.subjectAmount, finding.subjectCurrency);
  const subjectDate =
    finding.subjectType === "account_month"
      ? formatMonth(finding.subjectDate)
      : finding.subjectDate;
  const chips = Object.entries(finding.evidence).filter(
    ([, value]) => typeof value === "number" || typeof value === "string",
  );

  return (
    <li className="rounded-md border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            finding.impact === "blocking" ? "bg-rose-500" : "bg-amber-500"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm font-medium">{finding.message}</p>
            {!open && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {titleCase(finding.state)}
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {finding.subjectType === "journal_header" && finding.subjectId ? (
              <Link
                to="/transactions/$transactionId"
                params={{ transactionId: finding.subjectId }}
                className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline dark:text-teal-400"
              >
                {finding.subjectLabel ?? "Transaction"}
                <ArrowRightIcon size={11} />
              </Link>
            ) : finding.subjectType === "account_month" && finding.subjectId ? (
              <Link
                to="/accounts/category/$categoryId"
                params={{ categoryId: finding.subjectId }}
                className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline dark:text-teal-400"
              >
                {finding.subjectLabel ?? "Category"}
                {finding.subjectSublabel ? ` (${finding.subjectSublabel})` : ""}
                <ArrowRightIcon size={11} />
              </Link>
            ) : null}
            {subjectDate && <span>· {subjectDate}</span>}
            {amount && <span className="tabular-nums">· {amount}</span>}
          </div>

          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chips.map(([key, value]) => (
                <span
                  key={key}
                  className="rounded border border-amber-200 bg-white px-1.5 py-1 text-[10px] font-medium text-amber-900 dark:border-amber-900 dark:bg-slate-900 dark:text-amber-200"
                >
                  {titleCase(key)}:{" "}
                  {typeof value === "number" ? value.toLocaleString("en-US") : String(value)}
                </span>
              ))}
            </div>
          )}

          {!open && finding.resolutionNote && (
            <p className="mt-2 text-xs text-slate-500">
              Resolved
              {finding.resolvedAt ? ` ${new Date(finding.resolvedAt).toLocaleDateString()}` : ""}:{" "}
              {finding.resolutionNote}
            </p>
          )}

          {open && !finding.resolvableHere && (
            <div className="mt-3 text-xs">
              <p className="text-slate-500">
                This finding belongs to a transaction awaiting approval.
              </p>
              {finding.inboxItemId && (
                <Link
                  to="/inbox"
                  search={{ selected: finding.inboxItemId, state: "all" }}
                  className="mt-1 inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline dark:text-teal-400"
                >
                  Open in Inbox
                  <ArrowRightIcon size={11} />
                </Link>
              )}
            </div>
          )}

          {open && finding.resolvableHere && canResolve && (
            <div className="mt-3 flex gap-2">
              <input
                value={note}
                onChange={(event) => onNoteChange(event.target.value)}
                placeholder="Resolution or documented exception"
                aria-label={`Resolution note for ${finding.message}`}
                className="h-9 min-h-11 lg:min-h-0 min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-3 text-base sm:text-xs outline-none focus:border-teal-500 dark:border-amber-900 dark:bg-slate-900"
              />
              <button
                type="button"
                onClick={onResolve}
                disabled={resolvePending || note.trim().length < 3}
                className="h-9 min-h-11 lg:min-h-0 shrink-0 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
              >
                {resolvePending ? "Resolving…" : "Resolve"}
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ============================================================================
// Run history
// ============================================================================

function RunHistory({ ruleKey }: { ruleKey: string }) {
  const runsQuery = useQuery({
    queryKey: keys.reviewAgents.runs(ruleKey),
    queryFn: () => callServerFn(listReviewRuns, { data: { ruleKey, limit: 5 } }),
  });
  const runs = runsQuery.data ?? [];

  return (
    <section className="mt-8 rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="border-b border-slate-200 px-5 py-3 dark:border-slate-700">
        <h3 className="font-semibold">Run history</h3>
      </div>
      <div className="p-5">
        {runs.length === 0 ? (
          <p className="text-sm text-slate-500">No runs recorded yet.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ClockIcon size={14} className="shrink-0 text-slate-400" />
                <span className="font-medium">{new Date(run.startedAt).toLocaleString()}</span>
                <span className="text-slate-500">· {run.counts.findings} findings</span>
                <span className="text-slate-500">· {run.counts.scanned} scanned</span>
                <span className="text-slate-400">
                  · {run.windowStart} → {run.windowEnd}
                </span>
                {run.status !== "completed" && (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                    {titleCase(run.status)}
                  </span>
                )}
                {run.lastError && (
                  <span className="w-full text-rose-600 dark:text-rose-400">{run.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Configuration
// ============================================================================

type ConfirmState = { copy: AgentConfirmCopy; apply: () => void } | null;

function AgentConfigForm({
  agent,
  editable,
  onDirtyChange,
  onSaved,
  onError,
}: {
  agent: Agent;
  editable: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const schema = getAgentSchema(agent.key);
  const parsed = useMemo(() => {
    try {
      return JSON.parse(agent.configJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [agent.configJson]);

  const {
    values: initialValues,
    passthrough,
    hiddenAdvanced,
  } = useMemo(() => splitStoredConfig(schema, parsed), [parsed, schema]);

  const [enabled, setEnabled] = useState(agent.enabled);
  const [impact, setImpact] = useState<"blocking" | "warning">(
    agent.impact === "warning" ? "warning" : "blocking",
  );
  const [lookback, setLookback] = useState(String(agent.lookbackMonths));
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const markDirty = () => onDirtyChange(true);

  const errors = useMemo(
    () =>
      validateAgentConfig(schema?.fields ?? [], values, lookback, schema?.usesLookback ?? false),
    [schema, values, lookback],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const saveMutation = useMutation({
    mutationFn: () =>
      callServerFn(updateReviewAgent, {
        data: {
          definitionId: agent.definitionId,
          enabled,
          impact,
          lookbackMonths: Number(lookback),
          config: buildAgentConfigPayload(schema, values, passthrough),
          expectedVersion: agent.version,
        },
      }),
    onSuccess: onSaved,
    onError: (error) => onError(errorMessage(error, "Agent instructions could not be saved.")),
  });

  const setValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    markDirty();
  };

  return (
    <section className="mt-8 rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3 dark:border-slate-700">
        <h3 className="font-semibold">Configuration</h3>
        <label className="inline-flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!editable}
            onChange={(event) => {
              const next = event.target.checked;
              // duplicate-engine.ts treats `enabled: false` exactly like `mode: "off"`, so the
              // checkbox needs the same confirmation the mode select gets.
              if (!next && schema?.disableConfirm) {
                setConfirm({
                  copy: schema.disableConfirm,
                  apply: () => {
                    setEnabled(false);
                    markDirty();
                  },
                });
                return;
              }
              setEnabled(next);
              markDirty();
            }}
            className="h-4 w-4 accent-teal-700"
          />
          Enabled
        </label>
      </div>

      <div className="space-y-6 p-5">
        {confirm && (
          <div className="rounded-md border border-rose-300 bg-rose-50 p-4 text-sm dark:border-rose-900 dark:bg-rose-950/40">
            <p className="font-semibold text-rose-900 dark:text-rose-100">{confirm.copy.title}</p>
            <p className="mt-1 leading-6 text-rose-800 dark:text-rose-200">{confirm.copy.body}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  confirm.apply();
                  setConfirm(null);
                }}
                className="h-9 min-h-11 lg:min-h-0 rounded-md bg-rose-600 px-3 text-xs font-semibold text-white transition hover:bg-rose-700"
              >
                {confirm.copy.confirmLabel}
              </button>
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="h-9 min-h-11 lg:min-h-0 rounded-md border border-rose-300 px-3 text-xs font-semibold text-rose-900 dark:border-rose-800 dark:text-rose-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Never fall back to an editable textarea for an agent we don't have a schema for. */}
        {!schema && (
          <div>
            <p className="text-sm text-slate-500">
              This agent's settings aren't editable in this release. Its configuration is shown as
              stored.
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-200">
              {JSON.stringify(parsed, null, 2)}
            </pre>
          </div>
        )}

        {schema?.fields.map((field) => (
          <ConfigFieldInput
            key={field.key}
            field={field}
            value={values[field.key] ?? ""}
            currency={
              field.kind === "money" && field.currencyKey ? values[field.currencyKey] : undefined
            }
            error={errors[field.key]}
            disabled={!editable}
            onChange={(value) => setValue(field.key, value)}
            onRequestConfirm={(copy, apply) => setConfirm({ copy, apply })}
          />
        ))}

        {schema?.usesLookback ? (
          <label className="block text-sm font-medium">
            Lookback window
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={24}
                value={lookback}
                disabled={!editable}
                onChange={(event) => {
                  setLookback(event.target.value);
                  markDirty();
                }}
                className="h-9 min-h-11 lg:min-h-0 w-24 rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm tabular-nums outline-none focus:border-teal-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
              />
              <span className="text-xs text-slate-500">months</span>
            </div>
            {errors.lookbackMonths ? (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                {errors.lookbackMonths}
              </p>
            ) : (
              <p className="mt-1 text-xs leading-5 text-slate-500">
                How far back this agent reads when it runs.
              </p>
            )}
          </label>
        ) : (
          <p className="text-xs text-slate-500">
            Runs on each transaction as it arrives — there is no lookback window.
          </p>
        )}

        <label className="block text-sm font-medium">
          Approval impact
          <select
            value={impact}
            disabled={!editable}
            onChange={(event) => {
              setImpact(event.target.value as "blocking" | "warning");
              markDirty();
            }}
            className="mt-1 h-10 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-3 text-base sm:text-sm outline-none focus:border-teal-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="blocking">Blocking</option>
            <option value="warning">Warning</option>
          </select>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {agent.group === "review"
              ? "Blocking marks these as must-fix before you close the period. Warnings are informational."
              : "Blocking findings stop Inbox approval until someone resolves them. Warnings stay visible but let approval through."}
          </p>
        </label>

        {hiddenAdvanced.length > 0 && (
          <details className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced settings ({hiddenAdvanced.length})
            </summary>
            <p className="mt-2 text-xs text-slate-500">
              These settings were saved by a newer version of this agent. They're preserved when you
              save.
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-200">
              {JSON.stringify(Object.fromEntries(hiddenAdvanced), null, 2)}
            </pre>
          </details>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-slate-200 px-5 py-3 dark:border-slate-700">
        <p className="text-xs text-slate-500">
          Formula v{agent.formulaVersion}
          {agent.group === "book"
            ? " · Runs automatically at ingest"
            : agent.lastRunAt
              ? ` · Last run ${new Date(agent.lastRunAt).toLocaleString()}`
              : " · Not run yet"}
        </p>
        {editable && (
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || hasErrors}
            title={hasErrors ? "Fix the highlighted settings first." : undefined}
            className="h-10 min-h-11 lg:min-h-0 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-60"
          >
            {saveMutation.isPending ? "Saving…" : "Save settings"}
          </button>
        )}
      </div>
    </section>
  );
}

function ConfigFieldInput({
  field,
  value,
  currency,
  error,
  disabled,
  onChange,
  onRequestConfirm,
}: {
  field: AgentConfigField;
  value: string;
  currency?: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRequestConfirm: (copy: AgentConfirmCopy, apply: () => void) => void;
}) {
  if (field.kind === "enum") {
    const active = field.options.find((option) => option.value === value);
    return (
      <label className="block text-sm font-medium">
        {field.label}
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            const option = field.options.find((candidate) => candidate.value === next);
            if (option?.confirm) {
              onRequestConfirm(option.confirm, () => onChange(next));
              return;
            }
            onChange(next);
          }}
          className="mt-1 h-10 min-h-11 lg:min-h-0 w-full rounded-md border border-slate-200 bg-white px-3 text-base sm:text-sm outline-none focus:border-teal-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {active?.description && (
          <p className="mt-1 text-xs leading-5 text-slate-500">{active.description}</p>
        )}
        {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      </label>
    );
  }

  if (field.kind === "currency") {
    return (
      <label className="block text-sm font-medium">
        {field.label}
        <input
          value={value}
          maxLength={3}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="mt-1 h-9 min-h-11 lg:min-h-0 w-24 rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm uppercase outline-none focus:border-teal-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
        />
        {field.help && <p className="mt-1 text-xs leading-5 text-slate-500">{field.help}</p>}
        {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      </label>
    );
  }

  const unit = field.kind === "percent" ? "%" : field.kind === "number" ? field.unit : undefined;
  return (
    <label className="block text-sm font-medium">
      {field.label}
      <div className="mt-1 flex items-center gap-2">
        {field.kind === "money" && currency && (
          <span className="text-xs font-semibold text-slate-500">{currency}</span>
        )}
        <input
          type="number"
          min={field.min}
          max={field.kind === "money" ? undefined : field.max}
          step={field.kind === "money" ? undefined : field.step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 min-h-11 lg:min-h-0 w-28 rounded-md border border-slate-200 bg-white px-2 text-base sm:text-sm tabular-nums outline-none focus:border-teal-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
        />
        {unit && <span className="text-xs text-slate-500">{unit}</span>}
      </div>
      {error ? (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : (
        field.help && <p className="mt-1 text-xs leading-5 text-slate-500">{field.help}</p>
      )}
    </label>
  );
}
