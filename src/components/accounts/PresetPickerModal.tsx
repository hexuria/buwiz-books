/**
 * Chart-of-Accounts Preset Picker
 *
 * Pick a pack -> see exactly what will change -> apply. The preview and the
 * apply run the SAME planner server-side, and the apply sends back the
 * `planHash` it was shown, so a chart that changed underneath the preview is
 * rejected rather than silently applied.
 */
import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyCoaPreset, listCoaPresets, previewCoaPreset } from "../../routes/api/-coa-presets";
import { keys as queryKeys } from "../../lib/query-keys";
import { Modal } from "../ui/Modal";

interface PresetPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PresetSummary {
  id: string;
  version: number;
  label: string;
  description: string;
  industries: readonly string[];
  accountCount: number;
}

interface PresetCatalog {
  appliedPresetId: string | null;
  recommendedPresetId: string;
  industry: string | null;
  presets: PresetSummary[];
}

interface PresetPreview {
  presetId: string;
  presetLabel: string;
  planHash: string;
  isNoop: boolean;
  willCreate: Array<{
    name: string;
    accountNumber: string;
    accountType: string;
    subtype: string | null;
    renumberedFrom: string | null;
    synthesizedFor: string | null;
  }>;
  willReuse: Array<{ name: string; accountNumber: string | null; matchedBy: string }>;
  willFillSubtype: Array<{ name: string; subtype: string }>;
  willMap: Array<{ mappingType: string; sourceKey: string; source: string }>;
  keepsExistingMappings: number;
  conflicts: Array<{
    accountNumber: string;
    existingAccountType: string;
    presetAccountType: string;
  }>;
  warnings: string[];
}

type Step = "choose" | "preview" | "done";

/**
 * Preview and apply MUST plan with identical options — the options are part of
 * the planHash, so a mismatch would reject every apply. "renumber" is the right
 * policy for a user-facing template: a number collision moves the template's
 * account, never the org's existing one.
 */
const PLAN_OPTIONS = { onConflict: "renumber" as const };

const call =
  <T,>(fn: unknown) =>
  (data: unknown) =>
    (fn as (opts: { data: unknown }) => Promise<T>)({ data });

const secondaryButton =
  "h-11 px-4 text-sm font-semibold rounded-lg bg-white dark:bg-slate-700 text-[var(--color-app-text-navy)] dark:text-slate-200 border border-gray-200 dark:border-slate-600";
const primaryButton =
  "h-11 px-4 text-sm font-semibold rounded-lg bg-[var(--color-app-header-teal)] text-white disabled:opacity-50";

export const PresetPickerModal: React.FC<PresetPickerModalProps> = ({ isOpen, onClose }) => {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("choose");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PresetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ created: number; mappingsWritten: number } | null>(null);

  const { data: catalog } = useQuery<PresetCatalog>({
    queryKey: queryKeys.coaPresets.all(),
    queryFn: () =>
      (listCoaPresets as (opts: { data: unknown }) => Promise<PresetCatalog>)({ data: {} }),
    enabled: isOpen,
    staleTime: 5 * 60 * 1000,
  });

  const previewMutation = useMutation({
    mutationFn: (presetId: string) =>
      call<PresetPreview>(previewCoaPreset)({ presetId, options: PLAN_OPTIONS }),
    onSuccess: (data) => {
      setPreview(data);
      setStep("preview");
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const applyMutation = useMutation({
    mutationFn: (input: { presetId: string; expectedPlanHash: string }) =>
      call<{ created: number; mappingsWritten: number }>(applyCoaPreset)({
        ...input,
        options: PLAN_OPTIONS,
      }),
    onSuccess: (data) => {
      setApplied(data);
      setStep("done");
      setError(null);
      // Prefix invalidation: refreshes the tree, every by-type list, and the
      // resolved-mapping caches the bill/bank forms read.
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.categoryMappings.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.coaPresets.all() });
    },
    onError: (e: Error) => setError(e.message),
  });

  const handleClose = () => {
    setStep("choose");
    setSelectedId(null);
    setPreview(null);
    setApplied(null);
    setError(null);
    onClose();
  };

  const hasConflicts = (preview?.conflicts.length ?? 0) > 0;

  const footer = (
    <>
      {step === "choose" && (
        <>
          <button type="button" onClick={handleClose} className={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedId || previewMutation.isPending}
            onClick={() => selectedId && previewMutation.mutate(selectedId)}
            className={primaryButton}
          >
            {previewMutation.isPending ? "Checking…" : "Continue"}
          </button>
        </>
      )}
      {step === "preview" && preview && (
        <>
          <button type="button" onClick={() => setStep("choose")} className={secondaryButton}>
            Back
          </button>
          <button
            type="button"
            disabled={preview.isNoop || applyMutation.isPending}
            onClick={() =>
              applyMutation.mutate({
                presetId: preview.presetId,
                expectedPlanHash: preview.planHash,
              })
            }
            className={primaryButton}
          >
            {applyMutation.isPending ? "Applying…" : "Apply template"}
          </button>
        </>
      )}
      {step === "done" && (
        <button type="button" onClick={handleClose} className={primaryButton}>
          Done
        </button>
      )}
    </>
  );

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="Start from a template"
      mobile="fullscreen"
      size="md"
      footer={footer}
    >
      {error && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {step === "choose" && (
        <>
          <p className="text-sm text-[#6b7c93] mb-3">
            Each template creates a complete chart of accounts and fills in every category mapping,
            so bills and invoices can post straight away. Nothing you already have is renamed,
            retyped, or deleted.
          </p>
          <div className="flex flex-col gap-2">
            {(catalog?.presets ?? []).map((preset) => {
              const isRecommended = preset.id === catalog?.recommendedPresetId;
              const isApplied = preset.id === catalog?.appliedPresetId;
              const isSelected = preset.id === selectedId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSelectedId(preset.id)}
                  className={`text-left rounded-xl border p-3 transition-all ${
                    isSelected
                      ? "border-[var(--color-app-header-teal)] bg-[#f0f9f9] dark:bg-slate-700"
                      : "border-gray-200 dark:border-slate-600 hover:bg-[#f5f6f9] dark:hover:bg-slate-700"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-[var(--color-app-text-navy)] dark:text-slate-100">
                      {preset.label}
                    </span>
                    {isRecommended && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--color-app-header-teal)] text-white">
                        Recommended
                      </span>
                    )}
                    {isApplied && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 dark:bg-slate-600 text-[#6b7c93] dark:text-slate-300">
                        Applied
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[#6b7c93] dark:text-slate-400">
                    {preset.description}
                  </div>
                  <div className="text-xs text-[#6b7c93] dark:text-slate-500 mt-1">
                    {preset.accountCount} categories
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {step === "preview" && preview && (
        <>
          <div className="text-sm font-semibold mb-2 text-[var(--color-app-text-navy)] dark:text-slate-100">
            {preview.presetLabel}
          </div>

          {preview.isNoop ? (
            <p className="text-sm text-[#6b7c93]">
              Nothing to do — this template is already fully applied.
            </p>
          ) : (
            <ul className="text-sm text-[#6b7c93] dark:text-slate-300 space-y-1 mb-3">
              <li>
                <strong>{preview.willCreate.length}</strong> categories will be created
              </li>
              {preview.willReuse.length > 0 && (
                <li>
                  <strong>{preview.willReuse.length}</strong> existing categories will be reused
                  as-is
                </li>
              )}
              {preview.willFillSubtype.length > 0 && (
                <li>
                  <strong>{preview.willFillSubtype.length}</strong> categories will have a missing
                  subtype filled in
                </li>
              )}
              <li>
                <strong>{preview.willMap.length}</strong> category mappings will be set
                {preview.keepsExistingMappings > 0 &&
                  ` (${preview.keepsExistingMappings} you already set are left alone)`}
              </li>
              <li className="text-xs pt-1">No categories are removed, renamed, or re-typed.</li>
            </ul>
          )}

          {hasConflicts && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200 mb-3">
              <div className="font-semibold mb-1">
                {preview.conflicts.length} category number
                {preview.conflicts.length === 1 ? " is" : "s are"} already in use by a different
                account type
              </div>
              <ul className="text-xs space-y-0.5">
                {preview.conflicts.slice(0, 5).map((c) => (
                  <li key={c.accountNumber}>
                    {c.accountNumber} is {c.existingAccountType}, template expects{" "}
                    {c.presetAccountType}
                  </li>
                ))}
              </ul>
              <div className="text-xs mt-1">
                Applying will give the template&apos;s categories new numbers instead. Your existing
                accounts are not touched.
              </div>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <ul className="text-xs text-[#6b7c93] space-y-0.5 mb-3">
              {preview.warnings.slice(0, 6).map((w) => (
                <li key={w}>• {w}</li>
              ))}
            </ul>
          )}

          {preview.willCreate.length > 0 && (
            <details className="text-xs text-[#6b7c93]">
              <summary className="cursor-pointer select-none py-3.5">
                Show the {preview.willCreate.length} categories
              </summary>
              <ul className="mt-2 max-h-48 overflow-y-auto space-y-0.5">
                {preview.willCreate.map((a) => (
                  <li key={a.accountNumber}>
                    <span className="font-mono">{a.accountNumber}</span> {a.name}
                    {a.renumberedFrom && (
                      <span className="text-amber-600"> (was {a.renumberedFrom})</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {step === "done" && applied && (
        <div className="text-center py-6">
          <div className="text-4xl mb-2">✅</div>
          <div className="font-semibold text-[var(--color-app-text-navy)] dark:text-slate-100 mb-1">
            Chart of accounts ready
          </div>
          <p className="text-sm text-[#6b7c93]">
            {applied.created} categories created and {applied.mappingsWritten} mappings set.
          </p>
          <p className="text-xs text-[#6b7c93] mt-2">
            Next: connect a bank account under Entities → Banks.
          </p>
        </div>
      )}
    </Modal>
  );
};

export default PresetPickerModal;
