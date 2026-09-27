/**
 * ReviewRuleConfigForm — one organization's settings for one review rule.
 *
 * Inbox book findings read these settings live whenever a transaction is ingested or corrected
 * (src/lib/inbox/service.ts), and the ledger scan reads them when it runs. So this form decides
 * whether a check runs at all, whether its findings Stop approval or only Warn, and where its
 * thresholds sit.
 *
 * Extracted from the Review Agents page so Settings and that page edit through one component. It
 * saves only through the existing `updateReviewAgent` server function, which owns the permission
 * check (`agentRule:configure`), the per-rule bounds and the optimistic version check. The
 * client-side validation mirrors those bounds so a bad value never reaches the server as a generic
 * error; it is not the enforcement.
 *
 * Stored impact values stay `blocking` / `warning`. Only the labels say Stop / Warn.
 */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { callServerFn } from "@/lib/server-fn-client";
import {
  buildAgentConfigPayload,
  getAgentSchema,
  splitStoredConfig,
  validateAgentConfig,
  type AgentConfigField,
  type AgentConfirmCopy,
} from "@/lib/review-agents/agent-config-schema";
import { updateReviewAgent, type listReviewAgents } from "../../routes/api/-review-agents";

export type ReviewRule = Awaited<ReturnType<typeof listReviewAgents>>[number];
export type ReviewRuleImpact = "blocking" | "warning";

export const IMPACT_LABEL: Record<ReviewRuleImpact, string> = {
  blocking: "Stop",
  warning: "Warn",
};

/** Anything that is not explicitly a warning is treated as blocking, as the page always did. */
export function ruleImpact(rule: Pick<ReviewRule, "impact">): ReviewRuleImpact {
  return rule.impact === "warning" ? "warning" : "blocking";
}

function impactHelp(group: string) {
  return group === "review"
    ? "Stop marks a finding as must-fix before the period can be closed. Warn is informational."
    : "Stop holds the transaction in the Inbox until someone resolves the finding. Warn keeps the finding visible but lets approval through.";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const INPUT_CLASS =
  "rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] px-3 py-2 text-base sm:text-sm text-[#1e293b] dark:text-white tabular-nums focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] disabled:opacity-60 transition-all";
const LABEL_CLASS = "block text-xs font-medium text-[#64748b] dark:text-white/50";
const HELP_CLASS = "mt-1 text-[11px] leading-5 text-[#94a3b8] dark:text-white/40";
const ERROR_CLASS = "mt-1 text-[11px] leading-5 text-[#ef4444] dark:text-red-400";

type ConfirmState = { copy: AgentConfirmCopy; apply: () => void } | null;

export function ReviewRuleConfigForm({
  rule,
  editable,
  onDirtyChange,
  onSaved,
  onError,
}: {
  rule: ReviewRule;
  /** Callers pass `canConfigure && rule.configurable`; the server enforces it either way. */
  editable: boolean;
  /** Must be referentially stable — it is an effect dependency. */
  onDirtyChange?: (dirty: boolean) => void;
  onSaved: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const schema = getAgentSchema(rule.key);
  const parsed = useMemo(() => {
    try {
      return JSON.parse(rule.configJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [rule.configJson]);

  const {
    values: initialValues,
    passthrough,
    hiddenAdvanced,
  } = useMemo(() => splitStoredConfig(schema, parsed), [parsed, schema]);
  const initialImpact = ruleImpact(rule);
  const initialLookback = String(rule.lookbackMonths);

  const [enabled, setEnabled] = useState(rule.enabled);
  const [impact, setImpact] = useState<ReviewRuleImpact>(initialImpact);
  const [lookback, setLookback] = useState(initialLookback);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const impactName = useId();
  const lookbackId = useId();

  const dirty =
    enabled !== rule.enabled ||
    impact !== initialImpact ||
    lookback !== initialLookback ||
    Object.keys(initialValues).some((key) => values[key] !== initialValues[key]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // A remount (the caller keys this form by version) or an unmount must not leave the caller
  // believing there are unsaved edits it can no longer reach.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

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
          definitionId: rule.definitionId,
          enabled,
          impact,
          lookbackMonths: Number(lookback),
          config: buildAgentConfigPayload(schema, values, passthrough),
          expectedVersion: rule.version,
        },
      }),
    onSuccess: async () => {
      await onSaved();
    },
    onError: (error) => onError(errorMessage(error, `${rule.name} settings could not be saved.`)),
  });

  const discard = () => {
    setEnabled(rule.enabled);
    setImpact(initialImpact);
    setLookback(initialLookback);
    setValues(initialValues);
    setConfirm(null);
  };

  const setValue = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const toggleEnabled = () => {
    const next = !enabled;
    // duplicate-engine.ts treats `enabled: false` exactly like `mode: "off"`, so the switch needs
    // the same confirmation the mode select gets.
    if (!next && schema?.disableConfirm) {
      setConfirm({ copy: schema.disableConfirm, apply: () => setEnabled(false) });
      return;
    }
    setEnabled(next);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`Enable ${rule.name}`}
            disabled={!editable}
            onClick={toggleEnabled}
            className={`touch-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 disabled:opacity-40 ${
              enabled ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/10"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-sm font-medium text-[#1e293b] dark:text-white">
            {enabled ? "Check is on" : "Check is off"}
          </span>
        </div>

        <fieldset disabled={!editable} className="min-w-0 sm:max-w-sm">
          <legend className={LABEL_CLASS}>Approval impact</legend>
          <div className="mt-1.5 inline-flex rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] p-0.5">
            {(["blocking", "warning"] as const).map((value) => (
              <label
                key={value}
                className={`relative cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#0d9488]/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${
                  impact === value
                    ? value === "blocking"
                      ? "bg-white dark:bg-[#1e293b] text-[#b91c1c] dark:text-red-300 shadow-sm"
                      : "bg-white dark:bg-[#1e293b] text-[#b45309] dark:text-amber-300 shadow-sm"
                    : "text-[#64748b] dark:text-white/50"
                }`}
              >
                <input
                  type="radio"
                  name={impactName}
                  value={value}
                  checked={impact === value}
                  onChange={() => setImpact(value)}
                  className="sr-only"
                />
                {IMPACT_LABEL[value]}
              </label>
            ))}
          </div>
          <p className={HELP_CLASS}>{impactHelp(rule.group)}</p>
        </fieldset>
      </div>

      {confirm && (
        <div
          role="alert"
          className="rounded-xl border border-[#fecaca] dark:border-red-900/40 bg-[#fef2f2] dark:bg-red-900/10 p-4 text-sm"
        >
          <p className="font-semibold text-[#b91c1c] dark:text-red-300">{confirm.copy.title}</p>
          <p className="mt-1 text-[13px] leading-6 text-[#b91c1c]/90 dark:text-red-300/80">
            {confirm.copy.body}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                confirm.apply();
                setConfirm(null);
              }}
              className="min-h-11 lg:min-h-0 rounded-lg bg-[#ef4444] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#dc2626]"
            >
              {confirm.copy.confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="min-h-11 lg:min-h-0 rounded-lg border border-[#fecaca] dark:border-red-900/40 px-3 py-1.5 text-xs font-semibold text-[#b91c1c] dark:text-red-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Never fall back to an editable textarea for a rule we don't have a schema for. */}
      {!schema && (
        <div>
          <p className="text-xs text-[#64748b] dark:text-white/50">
            This rule's thresholds aren't editable in this release. Its configuration is shown as
            stored.
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-[#f8fafc] dark:bg-[#0f172a] p-3 font-mono text-xs text-[#334155] dark:text-white/70">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        </div>
      )}

      {schema && schema.fields.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {schema.fields.map((field) => (
            <RuleFieldInput
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
        </div>
      )}

      {schema?.usesLookback ? (
        <div>
          <label htmlFor={lookbackId} className={LABEL_CLASS}>
            Lookback window
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id={lookbackId}
              type="number"
              min={1}
              max={24}
              value={lookback}
              disabled={!editable}
              aria-invalid={errors.lookbackMonths ? true : undefined}
              aria-describedby={`${lookbackId}-help`}
              onChange={(event) => setLookback(event.target.value)}
              className={`w-24 ${INPUT_CLASS}`}
            />
            <span className="text-xs text-[#64748b] dark:text-white/50">months</span>
          </div>
          <p id={`${lookbackId}-help`} className={errors.lookbackMonths ? ERROR_CLASS : HELP_CLASS}>
            {errors.lookbackMonths ?? "How far back this check reads when it runs."}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
          Runs on each transaction as it arrives — there is no lookback window.
        </p>
      )}

      {hiddenAdvanced.length > 0 && (
        <details className="rounded-lg border border-[#e2e8f0] dark:border-white/10 p-3">
          <summary className="cursor-pointer text-xs font-medium text-[#1e293b] dark:text-white">
            Advanced settings ({hiddenAdvanced.length})
          </summary>
          <p className={HELP_CLASS}>
            These settings were saved by a newer version of this rule. They're preserved when you
            save.
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-[#f8fafc] dark:bg-[#0f172a] p-3 font-mono text-xs text-[#334155] dark:text-white/70">
            {JSON.stringify(Object.fromEntries(hiddenAdvanced), null, 2)}
          </pre>
        </details>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e2e8f0] dark:border-white/10 pt-4">
        <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
          Formula v{rule.formulaVersion}
          {rule.group === "book"
            ? " · Runs automatically at ingest"
            : rule.lastRunAt
              ? ` · Last run ${new Date(rule.lastRunAt).toLocaleString()}`
              : " · Not run yet"}
        </p>
        {editable && (
          <div className="flex items-center gap-2">
            {dirty && (
              <button
                type="button"
                onClick={discard}
                disabled={saveMutation.isPending}
                className="min-h-11 lg:min-h-0 rounded-lg px-3 py-2 text-sm font-medium text-[#64748b] dark:text-white/50 transition-colors hover:text-[#1e293b] dark:hover:text-white disabled:opacity-40"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || hasErrors || !dirty}
              title={hasErrors ? "Fix the highlighted settings first." : undefined}
              className="min-h-11 lg:min-h-0 rounded-lg bg-[#0d9488] px-4 py-2 text-sm font-medium text-white transition-all hover:bg-[#0f766e] disabled:opacity-40"
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RuleFieldInput({
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
  const id = useId();
  const noteId = `${id}-note`;

  if (field.kind === "enum") {
    const active = field.options.find((option) => option.value === value);
    const note = error ?? active?.description;
    return (
      <div className="sm:col-span-2">
        <label htmlFor={id} className={LABEL_CLASS}>
          {field.label}
        </label>
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          onChange={(event) => {
            const next = event.target.value;
            const option = field.options.find((candidate) => candidate.value === next);
            if (option?.confirm) {
              onRequestConfirm(option.confirm, () => onChange(next));
              return;
            }
            onChange(next);
          }}
          className={`mt-1.5 w-full ${INPUT_CLASS}`}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {note && (
          <p id={noteId} className={error ? ERROR_CLASS : HELP_CLASS}>
            {note}
          </p>
        )}
      </div>
    );
  }

  const note = error ?? field.help;

  if (field.kind === "currency") {
    return (
      <div>
        <label htmlFor={id} className={LABEL_CLASS}>
          {field.label}
        </label>
        <input
          id={id}
          value={value}
          maxLength={3}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className={`mt-1.5 w-24 uppercase ${INPUT_CLASS}`}
        />
        {note && (
          <p id={noteId} className={error ? ERROR_CLASS : HELP_CLASS}>
            {note}
          </p>
        )}
      </div>
    );
  }

  const unit = field.kind === "percent" ? "%" : field.kind === "number" ? field.unit : undefined;
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {field.label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        {field.kind === "money" && currency && (
          <span className="text-xs font-semibold text-[#64748b] dark:text-white/50">
            {currency}
          </span>
        )}
        <input
          id={id}
          type="number"
          min={field.min}
          max={field.kind === "money" ? undefined : field.max}
          step={field.kind === "money" ? undefined : field.step}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`w-28 ${INPUT_CLASS}`}
        />
        {unit && <span className="text-xs text-[#64748b] dark:text-white/50">{unit}</span>}
      </div>
      {note && (
        <p id={noteId} className={error ? ERROR_CLASS : HELP_CLASS}>
          {note}
        </p>
      )}
    </div>
  );
}
