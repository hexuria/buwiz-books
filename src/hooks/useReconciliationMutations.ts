/**
 * useReconciliationMutations — all mutation hooks for the Reconciliation Detail page.
 *
 * Encapsulates: match, finalize, reopen, delete, removeStatement,
 * resolveFlag, reconfigure, upload, applySuggestion, dismissSuggestion,
 * generateStatement, and inline-edit batch updates.
 */
import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  matchTransaction,
  finalizeReconciliation,
  reopenReconciliation,
  deleteReconciliation,
  resolveReconciliationFlag,
  uploadBankStatement,
  runStatementOcr,
  resumeStatementPipeline,
  applySuggestion,
  dismissSuggestion,
  generateBankStatementPdf,
  reconfigureReconciliation,
  removeReconciliationStatement,
} from "../routes/api/-reconciliations";
import { updateTransactionsBatch } from "../routes/api/-transactions";
import {
  pollStatementPipeline,
  statementValidationMessages,
} from "../lib/reconciliation-ocr-store";
import { createLogger } from "../lib/logger";
const logger = createLogger("ui.reconciliation");

type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

export interface ReconciliationMutationCallbacks {
  /** Clear reconcile target on match success */
  clearReconcileTarget: () => void;
  /** Flash a matched bbox */
  setLastMatchedLineId: (id: string | null) => void;
  /** Close finalize confirmation modal */
  setShowFinalizeConfirm: (v: boolean) => void;
  /** Close reconfigure modal */
  setShowReconfigureModal: (v: boolean) => void;
  /** Close delete confirmation modal */
  setShowDeleteConfirm: (v: boolean) => void;
  /** Set statement image URL (for upload/generate success) */
  setStatementImageUrl: (url: string | null) => void;
  /** Set upload error */
  setUploadError: (err: string | null) => void;
  /** Set validation warnings */
  setValidationWarnings: (warnings: string[]) => void;
  /** A statement PDF is password-protected (or the supplied password was
   *  wrong). The last upload payload is provided so the caller can retry with
   *  a password entered via the prompt modal. */
  onStatementPasswordRequired?: (
    status: "password_required" | "wrong_password",
    lastInput: {
      reconciliationId: string;
      base64Content: string;
      mimeType: string;
      fileName: string;
    },
  ) => void;
  /** Re-extraction hit a password-protected PDF (or a wrong password). */
  onRerunPasswordRequired?: (status: "password_required" | "wrong_password") => void;
}

type UploadStatementInput = {
  reconciliationId: string;
  base64Content: string;
  mimeType: string;
  fileName: string;
  password?: string;
  savePassword?: boolean;
};

export function useReconciliationMutations(
  reconciliationId: string,
  callbacks: ReconciliationMutationCallbacks,
) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Extraction is a worker job now: the mutation resolves at enqueue time, so
  // the "processing" affordance has to outlive it.
  const [statementPipelinePending, setStatementPipelinePending] = useState(false);

  const invalidateDetail = () => {
    queryClient.invalidateQueries({
      queryKey: ["reconciliations", "detail", reconciliationId],
    });
    queryClient.invalidateQueries({
      queryKey: ["reconciliations", "activity", reconciliationId],
    });
  };

  // ── Match / Unmatch / Ignore ───────────────────────────────

  const matchMutation = useMutation({
    mutationFn: (data: {
      reconciliationId: string;
      statementLineId: string;
      journalLineId: string | null;
      action: "match" | "unmatch" | "ignore";
    }) => (matchTransaction as ServerFnCaller)({ data }),
    onSuccess: (_result, variables) => {
      callbacks.clearReconcileTarget();
      if (variables.action === "match") {
        callbacks.setLastMatchedLineId(variables.statementLineId);
        setTimeout(() => callbacks.setLastMatchedLineId(null), 1500);
      }
      invalidateDetail();
    },
  });

  // ── Finalize ───────────────────────────────────────────────

  const finalizeMutation = useMutation({
    mutationFn: () =>
      (finalizeReconciliation as ServerFnCaller)({
        data: { id: reconciliationId },
      }),
    onSuccess: () => {
      callbacks.setShowFinalizeConfirm(false);
      invalidateDetail();
    },
  });

  // ── Reopen ─────────────────────────────────────────────────

  const reopenMutation = useMutation({
    mutationFn: () =>
      (reopenReconciliation as ServerFnCaller)({
        data: { id: reconciliationId },
      }),
    onSuccess: () => invalidateDetail(),
  });

  // ── Remove Statement ──────────────────────────────────────

  const removeStatementMutation = useMutation({
    mutationFn: () =>
      (removeReconciliationStatement as ServerFnCaller)({
        data: { reconciliationId },
      }),
    onSuccess: () => {
      invalidateDetail();
      callbacks.setStatementImageUrl(null);
    },
  });

  // ── Resolve Flag ──────────────────────────────────────────

  const resolveFlagMutation = useMutation({
    mutationFn: (data: { flagId: string; action: string }) =>
      (resolveReconciliationFlag as ServerFnCaller)({
        data: { reconciliationId, ...data },
      }),
    onSuccess: () => invalidateDetail(),
  });

  // ── Reconfigure ───────────────────────────────────────────

  const reconfigureMutation = useMutation({
    mutationFn: (data: {
      id: string;
      periodStart: string;
      periodEnd: string;
      statementEndingBalance?: string;
      statementBeginningBalance?: string;
      charges?: string;
      payments?: string;
    }) => (reconfigureReconciliation as ServerFnCaller)({ data }),
    onSuccess: () => {
      callbacks.setShowReconfigureModal(false);
      invalidateDetail();
    },
  });

  // ── Delete ────────────────────────────────────────────────

  const deleteMutation = useMutation({
    mutationFn: () =>
      (deleteReconciliation as ServerFnCaller)({
        data: { id: reconciliationId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reconciliations"] });
      callbacks.setShowDeleteConfirm(false);
      navigate({ to: "/reconciliations" as string & {} });
    },
  });

  // ── Statement pipeline (async worker job) ─────────────────

  /**
   * Follow a queued statement run to its terminal state.
   *
   * A run blocked on validation is terminal by design — the human decides.
   * Confirming re-enqueues a NEW forced run via resumeStatementPipeline; the
   * blocked run stays as the record of what was shown.
   */
  const watchStatementPipeline = useCallback(
    async (runId: string, documentId: string, jobId?: string) => {
      setStatementPipelinePending(true);
      try {
        // jobId is what surfaces retry state; the run row alone cannot say
        // "failed twice, next attempt in 20s".
        let outcome = await pollStatementPipeline(runId, jobId ? { jobId } : {});

        if (outcome.outcome === "terminal" && outcome.status.status === "blocked") {
          const validation = outcome.status.validation;
          if (validation) {
            const failures = statementValidationMessages(validation);
            callbacks.setValidationWarnings(failures);
            const proceed =
              typeof window !== "undefined" &&
              window.confirm(
                `This statement failed validation:\n\n${failures.join("\n")}\n\nImport it anyway?`,
              );
            if (!proceed) return;
            const resumed = await (resumeStatementPipeline as ServerFnCaller)({
              data: { runId, reconciliationId, documentId },
            });
            outcome = await pollStatementPipeline(
              resumed.runId,
              resumed.jobId ? { jobId: resumed.jobId } : {},
            );
          }
        }

        if (outcome.outcome === "deferred") {
          // Still running server-side. Say what is actually happening
          // instead of the old "Refresh to check."
          const job = outcome.status?.job;
          callbacks.setUploadError(
            job?.status === "retrying" && job.nextRunAt
              ? `Statement processing hit an error and is retrying (attempt ${job.attempt} of ${job.maxAttempts}, next at ${new Date(job.nextRunAt).toLocaleTimeString()}).`
              : "Statement processing is still running in the background. This page will update when it finishes.",
          );
          return;
        }

        const result = outcome.status;
        if (result.status === "blocked") {
          const kind = (result.blockedReason as { kind?: string } | null)?.kind;
          callbacks.setUploadError(
            kind === "password_required"
              ? "The statement PDF is password-protected — re-run extraction with its password."
              : "The statement could not be read. Check the file and try again.",
          );
          return;
        }
        if (result.status === "failed") {
          const detail = (result.blockedReason as { error?: string } | null)?.error;
          callbacks.setUploadError(
            detail
              ? `Statement processing failed: ${detail}`
              : "Statement processing failed. Try again.",
          );
          return;
        }

        callbacks.setUploadError(null);
        callbacks.setValidationWarnings(statementValidationMessages(result.validation));
      } catch (err: any) {
        callbacks.setUploadError(err?.message || "Failed to process bank statement");
      } finally {
        setStatementPipelinePending(false);
        // Same invalidation set the old synchronous success path used.
        queryClient.invalidateQueries({
          queryKey: ["reconciliations", "detail", reconciliationId],
        });
        queryClient.invalidateQueries({
          queryKey: ["reconciliations", "activity", reconciliationId],
        });
        queryClient.invalidateQueries({
          queryKey: ["reconciliations", "suggestions", reconciliationId],
        });
      }
    },
    [callbacks, queryClient, reconciliationId],
  );

  // ── Upload Bank Statement ─────────────────────────────────

  const uploadStatementMutation = useMutation({
    mutationFn: (data: UploadStatementInput) => (uploadBankStatement as ServerFnCaller)({ data }),
    onSuccess: (result: any, variables: UploadStatementInput) => {
      // Locked-PDF gate: the server did no writes — prompt for a password.
      if (result?.status === "password_required" || result?.status === "wrong_password") {
        callbacks.onStatementPasswordRequired?.(result.status, {
          reconciliationId: variables.reconciliationId,
          base64Content: variables.base64Content,
          mimeType: variables.mimeType,
          fileName: variables.fileName,
        });
        return;
      }

      callbacks.setUploadError(null);
      callbacks.setValidationWarnings([]);
      if (result?.imageBase64) {
        const dataUrl = `data:${result.imageMimeType || "image/png"};base64,${result.imageBase64}`;
        callbacks.setStatementImageUrl(dataUrl);
      }
      // The document row is durable; extraction runs in the worker.
      queryClient.invalidateQueries({ queryKey: ["reconciliations", "detail", reconciliationId] });
      if (result?.runId) void watchStatementPipeline(result.runId, result.documentId, result.jobId);
    },
    onError: (err: any) => {
      callbacks.setUploadError(err?.message || "Failed to process bank statement");
    },
  });

  // ── Re-run full statement extraction (lines + balances) ───

  const rerunExtractionMutation = useMutation({
    mutationFn: (data?: { password?: string; savePassword?: boolean }) =>
      (runStatementOcr as ServerFnCaller)({ data: { reconciliationId, ...data } }),
    onSuccess: (result: any) => {
      if (result?.status === "password_required" || result?.status === "wrong_password") {
        callbacks.onRerunPasswordRequired?.(result.status);
        return;
      }
      callbacks.setUploadError(result?.previewWarning || null);
      callbacks.setValidationWarnings([]);
      if (result?.imageBase64) {
        callbacks.setStatementImageUrl(`data:image/png;base64,${result.imageBase64}`);
      }
      invalidateDetail();
      if (result?.runId) void watchStatementPipeline(result.runId, result.documentId, result.jobId);
    },
    onError: (err: any) => {
      callbacks.setUploadError(err?.message || "Failed to re-extract statement");
    },
  });

  // ── AI Suggestions ────────────────────────────────────────

  const applySuggestionMutation = useMutation({
    mutationFn: (suggestionId: string) =>
      (applySuggestion as ServerFnCaller)({
        data: { suggestionId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reconciliations", "detail", reconciliationId] });
      queryClient.invalidateQueries({
        queryKey: ["reconciliations", "suggestions", reconciliationId],
      });
      queryClient.invalidateQueries({
        queryKey: ["reconciliations", "activity", reconciliationId],
      });
    },
  });

  const dismissSuggestionMutation = useMutation({
    mutationFn: (suggestionId: string) =>
      (dismissSuggestion as ServerFnCaller)({
        data: { suggestionId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["reconciliations", "suggestions", reconciliationId],
      });
    },
  });

  // ── Generate Statement ────────────────────────────────────

  const generateStatementMutation = useMutation({
    mutationFn: () =>
      (generateBankStatementPdf as ServerFnCaller)({
        data: { reconciliationId },
      }),
    onSuccess: (result: any) => {
      if (result.imageBase64) {
        const dataUrl = `data:${result.imageMimeType || "image/png"};base64,${result.imageBase64}`;
        callbacks.setStatementImageUrl(dataUrl);
      }
      queryClient.invalidateQueries({ queryKey: ["reconciliations", "detail", reconciliationId] });
      queryClient.invalidateQueries({
        queryKey: ["reconciliations", "activity", reconciliationId],
      });
    },
    onError: (err: any) => {
      callbacks.setUploadError(err?.message || "Failed to generate statement");
    },
  });

  // ── Inline-edit batch update ──────────────────────────────

  const updateBatchMutation = useMutation({
    mutationFn: (data: {
      ids: string[];
      updates: any;
      lineAccountId?: string;
      transactionType?: string;
    }) => (updateTransactionsBatch as ServerFnCaller)({ data }),
    onError: (err: any) => {
      logger.error("Failed to update transactions", { error: err.message });
    },
  });

  return {
    matchMutation,
    finalizeMutation,
    reopenMutation,
    removeStatementMutation,
    resolveFlagMutation,
    reconfigureMutation,
    deleteMutation,
    uploadStatementMutation,
    rerunExtractionMutation,
    /** True while a queued statement pipeline run is still being followed. */
    statementPipelinePending,
    applySuggestionMutation,
    dismissSuggestionMutation,
    generateStatementMutation,
    updateBatchMutation,
    queryClient,
  };
}
