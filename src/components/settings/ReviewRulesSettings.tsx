/**
 * ReviewRulesSettings — Settings home for an organization's review rule configuration.
 *
 * Inbox book findings read `review_rule_configs` live per organization (src/lib/inbox/service.ts),
 * so this section is where an organization turns a check on or off, decides whether its findings
 * Stop approval or only Warn, and tunes thresholds and lookback. It edits exactly what the Review
 * Agents page edited, through the same server functions (src/routes/api/-review-agents.ts) — the
 * permission checks, bounds and optimistic versioning live there, not here. The ledger scan and
 * its findings (LedgerScan) sit under the ledger checks they run, and rule snapshots
 * (RuleSnapshotsSettings) — frozen copies of these rules a routine can pin or shadow — close the
 * section.
 *
 * Unsaved drafts are guarded in two places. A route change (Back to app, browser back, any link
 * out) is held here with an in-page prompt. Settings sections are local state on the page, which
 * no router blocker sees, so this component reports `onUnsavedChange` and the page asks before it
 * switches sections.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EmptyCatalogNotice } from "@/components/review-agents/EmptyCatalogNotice";
import { LockIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { keys } from "@/lib/query-keys";
import { CADENCE_COPY, getAgentSchema } from "@/lib/review-agents/agent-config-schema";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import { listReviewAgents } from "../../routes/api/-review-agents";
import { LedgerScan } from "./LedgerScan";
import { RuleSnapshotsSettings } from "./RuleSnapshotsPanel";
import {
  IMPACT_LABEL,
  ReviewRuleConfigForm,
  ruleImpact,
  type ReviewRule,
  type ReviewRuleDraft,
} from "./ReviewRuleConfigForm";
import { UnsavedChangesBar } from "./UnsavedChangesBar";

const GROUPS = ["book", "review", "system"] as const;
type Group = (typeof GROUPS)[number];

const GROUP_COPY: Record<Group, { title: string; blurb: string }> = {
  book: {
    title: "Inbox checks",
    blurb:
      "Run automatically on every transaction that reaches the Inbox, before anything is posted.",
  },
  review: {
    title: "Ledger checks",
    blurb:
      "Look over your posted books for period-close problems when you press Scan books below. They never run on their own.",
  },
  system: {
    title: "System checks",
    blurb:
      "Raised by inbound processing when a source cannot be booked. Always on and always Stop — there is nothing to configure.",
  },
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Only a change of route leaves this page; a search-param update on the same route does not. */
const leavesThisRoute: ShouldBlockFn = ({ current, next }) => next.routeId !== current.routeId;

export function ReviewRulesSettings({
  focusRuleKey,
  onUnsavedChange,
}: {
  /** Open and scroll to this rule — set when Settings is opened from a finding in the Inbox. */
  focusRuleKey?: string;
  /**
   * Told whether any rule has an unsaved draft, and `false` on unmount. The Settings page uses it
   * to confirm a section switch. Must be referentially stable: it is an effect dependency.
   */
  onUnsavedChange?: (unsaved: boolean) => void;
} = {}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canConfigure, isLoading: permissionLoading } = usePermission(
    "agentRule",
    "configure",
  );

  const rulesQuery = useQuery({
    queryKey: keys.reviewAgents.list(),
    queryFn: () => callServerFn(listReviewAgents, { data: undefined }),
  });
  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);
  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        rules: rules.filter((rule) => rule.group === group),
      })).filter((entry) => entry.rules.length > 0),
    [rules],
  );

  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onDirtyChange = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const unsaved = dirtyKeys.size > 0;
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  const blocker = useBlocker({
    shouldBlockFn: leavesThisRoute,
    disabled: !unsaved,
    withResolver: true,
  });

  const onSaved = useCallback(
    async (rule: ReviewRule) => {
      await queryClient.invalidateQueries({ queryKey: keys.reviewAgents.all() });
      showToast(`${rule.name} settings saved.`, { icon: "success" });
    },
    [queryClient, showToast],
  );
  const onError = useCallback(
    (message: string) => showToast(message, { icon: "error" }),
    [showToast],
  );

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">Review Rules</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Deterministic checks that read your transactions and raise findings for a person to clear. A
        check never edits a transaction. What <strong className="font-semibold">Stop</strong> holds
        depends on the check: on an Inbox check it holds the transaction in the Inbox until someone
        resolves the finding; on a Ledger check it marks the finding as must-fix before the period
        can be closed. <strong className="font-semibold">Warn</strong> keeps the finding visible
        without holding anything.
      </p>

      {blocker.status === "blocked" && (
        <UnsavedChangesBar
          message="You have unsaved review rule changes. Leave this page and discard them?"
          confirmLabel="Discard and leave"
          onConfirm={blocker.proceed}
          onCancel={blocker.reset}
        />
      )}

      {!permissionLoading && !canConfigure && (
        <div
          role="status"
          className="mb-6 flex items-start gap-2 rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] px-4 py-3 text-xs text-[#64748b] dark:text-white/50"
        >
          <LockIcon size={14} className="mt-0.5 shrink-0" />
          <span>
            You can view these rules but not change them. Ask an owner or admin for the “configure
            agent rules” permission.
          </span>
        </div>
      )}

      {rulesQuery.isLoading ? (
        <RulesSkeleton />
      ) : rulesQuery.isError ? (
        <div
          role="alert"
          className="rounded-2xl border border-[#fecaca] dark:border-red-900/40 bg-[#fef2f2] dark:bg-red-900/10 p-6"
        >
          <p className="text-sm font-medium text-[#b91c1c] dark:text-red-300">
            Review rules could not be loaded
          </p>
          <p className="mt-1 text-xs text-[#b91c1c]/80 dark:text-red-300/70">
            {errorMessage(rulesQuery.error, "Please try again.")}
          </p>
          <button
            type="button"
            onClick={() => rulesQuery.refetch()}
            className="mt-3 rounded-lg bg-[#0d9488] px-4 py-2 text-sm font-medium text-white transition-all hover:bg-[#0f766e]"
          >
            Try again
          </button>
        </div>
      ) : rules.length === 0 ? (
        <EmptyCatalogNotice onReload={() => rulesQuery.refetch()} />
      ) : (
        <div className="space-y-6">
          {groups.map(({ group, rules: groupRules }) => (
            <Fragment key={group}>
              <RuleGroup
                group={group}
                rules={groupRules}
                canConfigure={canConfigure}
                focusRuleKey={focusRuleKey}
                onDirtyChange={onDirtyChange}
                onSaved={onSaved}
                onError={onError}
              />
              {group === "review" && <LedgerScan rules={groupRules} focusRuleKey={focusRuleKey} />}
            </Fragment>
          ))}
          <RuleSnapshotsSettings />
        </div>
      )}
    </div>
  );
}

function RuleGroup({
  group,
  rules,
  canConfigure,
  focusRuleKey,
  onDirtyChange,
  onSaved,
  onError,
}: {
  group: Group;
  rules: ReviewRule[];
  canConfigure: boolean;
  focusRuleKey?: string;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSaved: (rule: ReviewRule) => Promise<void>;
  onError: (message: string) => void;
}) {
  const headingId = useId();
  const copy = GROUP_COPY[group];
  return (
    <section
      aria-labelledby={headingId}
      className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6"
    >
      <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
        {copy.title}
      </h3>
      <p className="text-xs text-[#64748b] dark:text-white/50 mb-4">{copy.blurb}</p>
      <ul className="divide-y divide-[#e2e8f0] dark:divide-white/10">
        {rules.map((rule) => (
          <RuleRow
            key={rule.key}
            rule={rule}
            canConfigure={canConfigure}
            focused={rule.key === focusRuleKey}
            onDirtyChange={onDirtyChange}
            onSaved={onSaved}
            onError={onError}
          />
        ))}
      </ul>
    </section>
  );
}

function RuleRow({
  rule,
  canConfigure,
  focused,
  onDirtyChange,
  onSaved,
  onError,
}: {
  rule: ReviewRule;
  canConfigure: boolean;
  focused: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSaved: (rule: ReviewRule) => Promise<void>;
  onError: (message: string) => void;
}) {
  // A rule linked from an Inbox finding starts open, so the link lands on its settings.
  const [open, setOpen] = useState(focused && rule.configurable);
  // Mounted on first open and then only hidden, so collapsing a row never drops unsaved edits.
  const [mounted, setMounted] = useState(focused && rule.configurable);
  const panelId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  // Settings stays mounted when only the search changes (a second Inbox link, back/forward), so a
  // rule linked after mount is opened here too, not just by the initial state above. Other open
  // rows stay open: rows open independently.
  useEffect(() => {
    if (!focused) return;
    if (rule.configurable) {
      setMounted(true);
      setOpen(true);
    }
    // Optional call: jsdom has no scrollIntoView.
    rowRef.current?.scrollIntoView?.({ block: "center" });
  }, [focused, rule.configurable]);
  const editable = canConfigure && rule.configurable;
  const toggleLabel = open ? "Close" : editable ? "Edit" : "View";
  // The unsaved draft, if any, so a collapsed row reads what will be saved, not what is stored.
  const [draft, setDraft] = useState<ReviewRuleDraft | null>(null);
  const { key } = rule;
  const handleDraftChange = useCallback(
    (next: ReviewRuleDraft | null) => {
      setDraft(next);
      onDirtyChange(key, next !== null);
    },
    [onDirtyChange, key],
  );

  return (
    <li
      ref={rowRef}
      className={
        focused
          ? "-mx-3 rounded-xl bg-[#0d9488]/5 px-3 py-3 dark:bg-teal-900/10"
          : "py-3 first:pt-0 last:pb-0"
      }
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium text-[#1e293b] dark:text-white">{rule.name}</p>
          {rule.description && (
            <p className="mt-0.5 text-[11px] leading-5 text-[#94a3b8] dark:text-white/40">
              {rule.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RuleStateChips rule={rule} draft={draft} />
          {rule.configurable ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={mounted ? panelId : undefined}
              aria-label={`${toggleLabel} ${rule.name}`}
              onClick={() => {
                setMounted(true);
                setOpen((current) => !current);
              }}
              className="ml-1 min-h-11 lg:min-h-0 rounded-lg border border-[#e2e8f0] dark:border-white/10 px-3 py-1.5 text-xs font-medium text-[#0d9488] dark:text-teal-400 transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/5"
            >
              {toggleLabel}
            </button>
          ) : (
            <span
              title="Raised automatically by inbound processing. Nothing to configure."
              className="ml-1 flex h-7 w-7 items-center justify-center text-[#94a3b8] dark:text-white/40"
            >
              <LockIcon size={14} />
              <span className="sr-only">Not configurable</span>
            </span>
          )}
        </div>
      </div>
      {mounted && (
        <div
          id={panelId}
          hidden={!open}
          className="mt-3 rounded-xl border border-[#e2e8f0] dark:border-white/5 bg-[#f8fafc] dark:bg-[#0f172a] p-4"
        >
          <RuleCadence rule={rule} />
          <ReviewRuleConfigForm
            key={`${rule.key}:${rule.version}`}
            rule={rule}
            editable={editable}
            onDraftChange={handleDraftChange}
            onSaved={() => onSaved(rule)}
            onError={onError}
          />
        </div>
      )}
    </li>
  );
}

/** When the check actually evaluates. The schema is authoritative; the DB group is only a hint. */
function RuleCadence({ rule }: { rule: ReviewRule }) {
  const schema = getAgentSchema(rule.key);
  const cadence = schema?.cadence ?? (rule.group === "review" ? "on_demand" : "ingest");
  return (
    <div className="mb-4 text-[11px] leading-5 text-[#64748b] dark:text-white/50">
      <p>{CADENCE_COPY[cadence]}</p>
      {schema?.cadenceNote && (
        <p className="text-[#94a3b8] dark:text-white/40">{schema.cadenceNote}</p>
      )}
    </div>
  );
}

const CHIP = "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide";

function RuleStateChips({ rule, draft }: { rule: ReviewRule; draft: ReviewRuleDraft | null }) {
  if (!rule.configurable) {
    return (
      <>
        <span className={`${CHIP} bg-[#f1f5f9] dark:bg-white/5 text-[#64748b] dark:text-white/50`}>
          Always on
        </span>
        <span
          className={`${CHIP} bg-[#fef2f2] dark:bg-red-900/20 text-[#b91c1c] dark:text-red-300`}
        >
          {IMPACT_LABEL.blocking}
        </span>
      </>
    );
  }
  const enabled = draft?.enabled ?? rule.enabled;
  const impact = draft?.impact ?? ruleImpact(rule);
  return (
    <>
      {draft && (
        <span
          title="Changed here but not saved yet"
          className={`${CHIP} bg-[#fef3c7] dark:bg-amber-900/30 text-[#92400e] dark:text-amber-200`}
        >
          Unsaved
        </span>
      )}
      <span
        className={`${CHIP} ${
          enabled
            ? "bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400"
            : "bg-[#f1f5f9] dark:bg-white/5 text-[#64748b] dark:text-white/50"
        }`}
      >
        {enabled ? "On" : "Off"}
      </span>
      <span
        className={`${CHIP} ${enabled ? "" : "opacity-50"} ${
          impact === "blocking"
            ? "bg-[#fef2f2] dark:bg-red-900/20 text-[#b91c1c] dark:text-red-300"
            : "bg-[#fffbeb] dark:bg-amber-900/20 text-[#b45309] dark:text-amber-300"
        }`}
      >
        {IMPACT_LABEL[impact]}
      </span>
    </>
  );
}

function RulesSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      {[0, 1].map((card) => (
        <div
          key={card}
          className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-4"
        >
          <div className="w-32 h-4 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center justify-between gap-4">
              <div className="w-1/2 h-4 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse" />
              <div className="w-24 h-6 bg-[#e2e8f0] dark:bg-white/10 rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
