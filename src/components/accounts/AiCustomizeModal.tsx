/**
 * AI chart-of-accounts customization.
 *
 * Describe the business -> a background job drafts additional categories ->
 * they land as an `ai_action_proposals` row a human reviews on /ai-proposals.
 * Nothing is written to the chart from here: this modal starts a job and polls
 * it, and the approve step is the only thing that writes.
 */
import React, { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getCoaScaffoldStatus, startCoaScaffold } from "../../routes/api/-coa-scaffold";
import { Modal } from "../ui/Modal";

interface AiCustomizeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Queued {
  status: "queued";
  runId: string;
  jobId: string;
  reused: boolean;
}

interface RunStatus {
  run?: { status?: string; blockedReason?: unknown } | null;
  job?: { status?: string; lastError?: string | null } | null;
}

const TERMINAL = new Set(["completed", "failed", "blocked"]);

const secondaryButton =
  "h-11 px-4 text-sm font-semibold rounded-lg bg-white dark:bg-slate-700 text-[var(--color-app-text-navy)] dark:text-slate-200 border border-gray-200 dark:border-slate-600";
const primaryButton =
  "h-11 px-4 text-sm font-semibold rounded-lg bg-[var(--color-app-header-teal)] text-white disabled:opacity-50";

export const AiCustomizeModal: React.FC<AiCustomizeModalProps> = ({ isOpen, onClose }) => {
  const [description, setDescription] = useState("");
  const [queued, setQueued] = useState<Queued | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: (businessDescription: string) =>
      (startCoaScaffold as (opts: { data: unknown }) => Promise<Queued>)({
        data: { businessDescription },
      }),
    onSuccess: (data) => {
      setQueued(data);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const runStatus = useQuery<RunStatus>({
    queryKey: ["coa-scaffold", queued?.runId],
    queryFn: () =>
      (getCoaScaffoldStatus as (opts: { data: unknown }) => Promise<RunStatus>)({
        data: { runId: queued!.runId, jobId: queued!.jobId },
      }),
    enabled: Boolean(queued),
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return status && TERMINAL.has(status) ? false : 2000;
    },
  });

  useEffect(() => {
    if (!isOpen) {
      setDescription("");
      setQueued(null);
      setError(null);
    }
  }, [isOpen]);

  const status = runStatus.data?.run?.status;
  const isDone = status === "completed";
  const isFailed = status === "failed" || status === "blocked";

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Customize with AI"
      mobile="fullscreen"
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryButton}>
            {isDone || isFailed ? "Close" : "Cancel"}
          </button>
          {!queued && (
            <button
              type="button"
              disabled={description.trim().length < 10 || startMutation.isPending}
              onClick={() => startMutation.mutate(description.trim())}
              className={primaryButton}
            >
              {startMutation.isPending ? "Starting…" : "Draft suggestions"}
            </button>
          )}
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {!queued && (
        <>
          <p className="text-sm text-[#6b7c93] mb-3">
            Describe what your business does. The assistant suggests extra categories on top of your
            existing chart — it never renames, re-types, or removes anything, and nothing is added
            until you review and approve it.
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="e.g. We run a specialty coffee shop with a small wholesale roasting arm and sell beans online."
            className="w-full rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-base sm:text-sm"
          />
          <p className="text-xs text-[#6b7c93] mt-1">
            Apply a template first if you have not — the assistant extends an existing chart rather
            than creating one.
          </p>
        </>
      )}

      {queued && !isDone && !isFailed && (
        <div className="text-center py-6">
          <div className="text-sm text-[#6b7c93]">
            Drafting categories for your business…
            <br />
            This usually takes under a minute.
          </div>
        </div>
      )}

      {isDone && (
        <div className="text-center py-6">
          <div className="text-4xl mb-2">📝</div>
          <div className="font-semibold text-[var(--color-app-text-navy)] dark:text-slate-100 mb-1">
            A draft is ready for review
          </div>
          <p className="text-sm text-[#6b7c93] mb-3">
            Nothing has been added to your chart yet. Review the suggestions and choose what to
            keep.
          </p>
          <Link
            to="/ai-proposals"
            className="inline-flex h-11 items-center rounded-lg bg-[var(--color-app-header-teal)] px-4 text-sm font-semibold text-white"
          >
            Review suggestions
          </Link>
        </div>
      )}

      {isFailed && (
        <div className="text-center py-6 text-sm text-[#6b7c93]">
          The draft could not be completed.
          {runStatus.data?.job?.lastError ? ` ${runStatus.data.job.lastError}` : ""}
          <br />
          Your chart of accounts is unchanged.
        </div>
      )}
    </Modal>
  );
};

export default AiCustomizeModal;
