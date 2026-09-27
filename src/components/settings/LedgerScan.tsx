/**
 * LedgerScan — the "Scan books" button and the ledger findings it leaves behind.
 *
 * The ledger checks never run on their own: they read the posted ledger only when someone asks.
 * This panel is that ask. It calls the existing `runReviewAgents` server function (permission
 * `agentRule:run`), reports what the scan flagged, and lists each check's findings through
 * `listReviewFindings` with the existing `resolveReviewFinding` action (permission
 * `review:resolve`). It replaces the run button and findings panel of the retired Review Agents
 * page; nothing here adds server behavior.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import DayPicker from "@/components/ui/DayPicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { ArrowRightIcon, CheckCircleIcon, LockIcon, PlayIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import {
  listReviewFindings,
  resolveReviewFinding,
  runReviewAgents,
} from "../../routes/api/-review-agents";
import type { ReviewRule } from "./ReviewRuleConfigForm";

type ScanResult = Awaited<ReturnType<typeof runReviewAgents>>;
type Finding = Awaited<ReturnType<typeof listReviewFindings>>["findings"][number];
type FindingsState = "open" | "all";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Display only. The amount stays a decimal string everywhere it is stored or compared. */
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

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const CARD =
  "bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6";
const PILL_BASE =
  "min-h-11 lg:min-h-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border";
const PILL_ON =
  "border-[#0d9488] bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400";
const PILL_OFF =
  "border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white";

export function LedgerScan({
  rules,
  initialRuleKey,
}: {
  /** The ledger (review-group) rules, as loaded by the section. */
  rules: ReviewRule[];
  /** Preselect this check's findings, e.g. when Settings was opened from one of its findings. */
  initialRuleKey?: string;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canRun } = usePermission("agentRule", "run");
  const { canAccess: canResolve } = usePermission("review", "resolve");
  const headingId = useId();

  const [asOfDate, setAsOfDate] = useState(todayIso);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  // Chosen once, so resolving the last open finding does not jump the list to another check.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(
    () =>
      rules.find((rule) => rule.key === initialRuleKey)?.key ??
      rules.find((rule) => rule.openFindingCount > 0)?.key ??
      rules[0]?.key,
  );
  const [findingsState, setFindingsState] = useState<FindingsState>("open");

  const selected = rules.find((rule) => rule.key === selectedKey) ?? rules[0];
  const enabledCount = rules.filter((rule) => rule.enabled).length;
  const nameByKey = new Map(rules.map((rule) => [rule.key, rule.name]));

  const scanMutation = useMutation({
    mutationFn: () => callServerFn(runReviewAgents, { data: { asOfDate } }),
    onSuccess: async (result) => {
      setLastScan(result);
      const flagged = result.rules.reduce((sum, rule) => sum + rule.findingCount, 0);
      showToast(
        flagged === 0
          ? "Scan finished — nothing flagged."
          : `Scan finished — ${plural(flagged, "finding")}.`,
        { icon: "success" },
      );
      await queryClient.invalidateQueries({ queryKey: keys.reviewAgents.all() });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
    onError: (error) => showToast(errorMessage(error, "The scan failed."), { icon: "error" }),
  });

  const flagged = lastScan?.rules.reduce((sum, rule) => sum + rule.findingCount, 0) ?? 0;

  return (
    <section aria-labelledby={headingId} className={CARD}>
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
            Scan books
          </h3>
          <p className="text-xs text-[#64748b] dark:text-white/50">
            Runs every ledger check that is on over your posted books, as if today were the date
            below. Set it to a period end to reproduce a close.
          </p>
        </div>
        {canRun ? (
          <div className="flex shrink-0 flex-wrap items-end gap-2">
            <div className="text-xs font-medium text-[#64748b] dark:text-white/50">
              As of
              <div className="mt-1">
                <DayPicker value={asOfDate} onChange={setAsOfDate} variant="form" />
              </div>
            </div>
            <button
              type="button"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending || enabledCount === 0}
              title={enabledCount === 0 ? "Every ledger check is turned off." : undefined}
              className="inline-flex min-h-11 lg:min-h-0 items-center gap-2 rounded-lg bg-[#0d9488] px-4 py-2 text-sm font-medium whitespace-nowrap text-white transition-all hover:bg-[#0f766e] disabled:opacity-40"
            >
              <PlayIcon size={14} />
              {scanMutation.isPending ? "Scanning…" : "Scan books"}
            </button>
          </div>
        ) : (
          <p className="flex shrink-0 items-center gap-1.5 text-xs text-[#64748b] dark:text-white/50">
            <LockIcon size={14} />
            Scanning the books requires the “run agent rules” permission.
          </p>
        )}
      </div>

      {lastScan && (
        <div
          role="status"
          className="mt-4 rounded-xl border border-[#99f6e4] dark:border-teal-900/50 bg-[#f0fdfa] dark:bg-teal-900/10 px-4 py-3"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-[#115e59] dark:text-teal-200">
              Scanned {lastScan.windowStart} to {lastScan.asOfDate} ·{" "}
              {plural(lastScan.rules.length, "check")} · {plural(flagged, "finding")}
            </p>
            <button
              type="button"
              onClick={() => setLastScan(null)}
              className="shrink-0 text-xs font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
            >
              Dismiss
            </button>
          </div>
          {lastScan.rules.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {lastScan.rules.map((result) => (
                <li key={result.ruleKey}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedKey(result.ruleKey);
                      setFindingsState("open");
                    }}
                    className="rounded-full border border-[#99f6e4] dark:border-teal-900/50 bg-white dark:bg-[#0f172a] px-2.5 py-1 text-[11px] font-medium text-[#115e59] dark:text-teal-200 hover:border-[#0d9488]"
                  >
                    {nameByKey.get(result.ruleKey) ?? titleCase(result.ruleKey)} ·{" "}
                    {result.findingCount}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selected && (
        <div className="mt-6 border-t border-[#e2e8f0] dark:border-white/10 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[#64748b] dark:text-white/50">
              Ledger findings
            </h4>
            <div
              role="group"
              aria-label="Which findings"
              className="flex overflow-hidden rounded-lg border border-[#e2e8f0] dark:border-white/10 text-xs font-medium"
            >
              {(["open", "all"] as const).map((state) => (
                <button
                  key={state}
                  type="button"
                  aria-pressed={findingsState === state}
                  onClick={() => setFindingsState(state)}
                  className={`px-3 py-1.5 transition-colors ${
                    findingsState === state
                      ? "bg-[#f1f5f9] dark:bg-white/10 text-[#1e293b] dark:text-white"
                      : "text-[#64748b] dark:text-white/50"
                  }`}
                >
                  {state === "open" ? "Open" : "All"}
                </button>
              ))}
            </div>
          </div>

          <div role="group" aria-label="Ledger check" className="mt-3 flex flex-wrap gap-1.5">
            {rules.map((rule) => (
              <button
                key={rule.key}
                type="button"
                aria-pressed={rule.key === selected.key}
                aria-label={
                  rule.openFindingCount > 0
                    ? `${rule.name}, ${rule.openFindingCount} open`
                    : rule.name
                }
                onClick={() => setSelectedKey(rule.key)}
                className={`${PILL_BASE} ${rule.key === selected.key ? PILL_ON : PILL_OFF}`}
              >
                {rule.name}
                {rule.openFindingCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-[#fef3c7] dark:bg-amber-900/30 px-1.5 text-[10px] font-semibold text-[#92400e] dark:text-amber-200">
                    {rule.openFindingCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          <RuleFindings
            key={`${selected.key}:${findingsState}`}
            rule={selected}
            state={findingsState}
            canResolve={canResolve}
          />
        </div>
      )}
    </section>
  );
}

function RuleFindings({
  rule,
  state,
  canResolve,
}: {
  rule: ReviewRule;
  state: FindingsState;
  canResolve: boolean;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const findingsQuery = useQuery({
    queryKey: keys.reviewAgents.findings(rule.key, { state }),
    queryFn: () =>
      callServerFn(listReviewFindings, { data: { ruleKey: rule.key, state, limit: 50 } }),
  });

  const resolveMutation = useMutation({
    mutationFn: (input: { findingId: string; resolutionNote: string }) =>
      callServerFn(resolveReviewFinding, { data: input }),
    onSuccess: async () => {
      showToast("Finding resolved.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.reviewAgents.all() });
    },
    onError: (error) =>
      showToast(errorMessage(error, "The finding could not be resolved."), { icon: "error" }),
  });

  const findings = findingsQuery.data?.findings ?? [];

  return (
    <div className="mt-4">
      {findingsQuery.isLoading && (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1].map((index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-xl bg-[#f1f5f9] dark:bg-white/5"
            />
          ))}
        </div>
      )}
      {findingsQuery.isError && (
        <p role="alert" className="text-xs text-[#ef4444] dark:text-red-400">
          {errorMessage(findingsQuery.error, "Findings could not be loaded.")}
        </p>
      )}
      {!findingsQuery.isLoading && !findingsQuery.isError && findings.length === 0 && (
        <FindingsEmptyState rule={rule} state={state} />
      )}
      {findings.length > 0 && (
        <ul aria-label={`${rule.name} findings`} className="space-y-3">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              canResolve={canResolve}
              note={notes[finding.id] ?? ""}
              onNoteChange={(value) => setNotes((current) => ({ ...current, [finding.id]: value }))}
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
        <p className="mt-3 text-[11px] text-[#94a3b8] dark:text-white/40">
          Showing the {findings.length} most recent findings. Resolve these to see older ones.
        </p>
      )}
    </div>
  );
}

function FindingsEmptyState({ rule, state }: { rule: ReviewRule; state: FindingsState }) {
  if (!rule.enabled) {
    return (
      <EmptyState
        icon={<LockIcon size={28} strokeWidth={1.5} />}
        title="This check is turned off"
        description="Turn it on under Ledger checks to include it in the next scan."
      />
    );
  }
  if (!rule.lastRunAt) {
    return (
      <EmptyState
        tone="info"
        icon={<PlayIcon size={28} strokeWidth={1.5} />}
        title="Not scanned yet"
        description="Press Scan books to check the ledger as of the date above."
      />
    );
  }
  return (
    <EmptyState
      tone="success"
      icon={<CheckCircleIcon size={28} strokeWidth={1.5} />}
      title={state === "all" ? "No findings recorded" : "No open findings"}
      description={`Last scanned ${new Date(rule.lastRunAt).toLocaleDateString()}.`}
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
    <li className="rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            finding.impact === "blocking" ? "bg-[#ef4444]" : "bg-[#f59e0b]"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm font-medium text-[#1e293b] dark:text-white">{finding.message}</p>
            <span className="rounded-full bg-[#f1f5f9] dark:bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b] dark:text-white/50">
              {open ? (finding.impact === "blocking" ? "Stop" : "Warn") : titleCase(finding.state)}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#64748b] dark:text-white/50">
            {finding.subjectType === "journal_header" && finding.subjectId ? (
              <Link
                to="/transactions/$transactionId"
                params={{ transactionId: finding.subjectId }}
                className="inline-flex items-center gap-1 font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
              >
                {finding.subjectLabel ?? "Transaction"}
                <ArrowRightIcon size={11} />
              </Link>
            ) : finding.subjectType === "account_month" && finding.subjectId ? (
              <Link
                to="/accounts/category/$categoryId"
                params={{ categoryId: finding.subjectId }}
                className="inline-flex items-center gap-1 font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
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
                  className="rounded border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#1e293b] px-1.5 py-1 text-[10px] font-medium text-[#64748b] dark:text-white/60"
                >
                  {titleCase(key)}:{" "}
                  {typeof value === "number" ? value.toLocaleString("en-US") : String(value)}
                </span>
              ))}
            </div>
          )}

          {!open && finding.resolutionNote && (
            <p className="mt-2 text-xs text-[#64748b] dark:text-white/50">
              Resolved
              {finding.resolvedAt ? ` ${new Date(finding.resolvedAt).toLocaleDateString()}` : ""}:{" "}
              {finding.resolutionNote}
            </p>
          )}

          {open && !finding.resolvableHere && (
            <div className="mt-3 text-xs">
              <p className="text-[#64748b] dark:text-white/50">
                This finding belongs to a transaction awaiting approval.
              </p>
              {finding.inboxItemId && (
                <Link
                  to="/inbox"
                  search={{ selected: finding.inboxItemId, state: "all" }}
                  className="mt-1 inline-flex items-center gap-1 font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
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
                className="min-h-11 lg:min-h-0 min-w-0 flex-1 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] px-3 py-2 text-base sm:text-xs text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488]"
              />
              <button
                type="button"
                onClick={onResolve}
                disabled={resolvePending || note.trim().length < 3}
                className="min-h-11 lg:min-h-0 shrink-0 rounded-lg bg-[#0d9488] px-3 py-2 text-xs font-medium text-white transition-all hover:bg-[#0f766e] disabled:opacity-40"
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
