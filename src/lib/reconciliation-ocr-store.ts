/**
 * Reconciliation OCR Background Store — Module-level singleton
 *
 * Survives route navigation because it lives outside React's component tree.
 * Components subscribe via useSyncExternalStore.
 *
 * Pipeline:
 *  1. Enqueue the server-side `bbox_scan` job (one download + rasterize, all
 *     pages scanned in the worker) and poll it to completion
 *  2. On success: invalidate queries so UI refreshes with bounding boxes
 *  3. Show floating progress card via OcrProgress component
 */

import { useSyncExternalStore } from "react";
import { clearDocumentBoundingBoxes } from "../routes/api/-documents";
// The server fn is aliased: this module already exports a client-side
// startFieldScan (the store action below), and the two must not collide.
import { startFieldScan as enqueueFieldScan, getFieldScanStatus } from "../routes/api/-ai-bill-ocr";
import type { FieldScanStatus } from "../routes/api/-ai-bill-ocr";
import { getStatementPipelineStatus } from "../routes/api/-reconciliations";
import type { StatementPipelineStatus } from "../routes/api/-reconciliations";
import { PIPELINE_POLL_TIMEOUT_MS } from "./jobs/polling-policy";

// ============================================================================
// Types
// ============================================================================

export type OcrJobStatus = "processing" | "retrying" | "deferred" | "done" | "error";

export interface OcrJob {
  id: string;
  reconciliationId: string;
  status: OcrJobStatus;
  error?: string;
  fieldCount?: number;
  /** Populated for `retrying`/`deferred` so the card can explain itself. */
  detail?: string;
}

// ============================================================================
// Store (singleton)
// ============================================================================

let jobs: OcrJob[] = [];
const listeners = new Set<() => void>();

function emitChange() {
  // Create a new array reference so useSyncExternalStore detects the change
  jobs = [...jobs];
  for (const l of listeners) l();
}

function getSnapshot(): OcrJob[] {
  return jobs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// React Hook
// ============================================================================

export function useOcrJobs(): OcrJob[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ============================================================================
// Actions
// ============================================================================

function updateJob(id: string, patch: Partial<OcrJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  emitChange();
}

export function removeOcrJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  emitChange();
}

export function getActiveOcrJobCount(): number {
  return jobs.filter((j) => j.status === "processing").length;
}

// ============================================================================
// Pipeline
// ============================================================================

type ServerFnCaller = (opts: { data: any }) => Promise<any>;

// ============================================================================
// Statement pipeline polling
// ============================================================================

const PIPELINE_POLL_INTERVAL_MS = 2000;
/**
 * How long a client waits before it stops watching. Exported so the server's
 * retry budget can be asserted against it in a test — the two silently
 * diverged once (a 123-minute retry curve behind a 10-minute watcher), which
 * made a permanently-failing job structurally unable to report its failure.
 */
export { PIPELINE_POLL_TIMEOUT_MS } from "./jobs/polling-policy";

const PIPELINE_TERMINAL_STATUSES = new Set(["completed", "blocked", "failed"]);

/**
 * Result of watching a job.
 *
 * `deferred` means "still running, but not worth watching any longer" — the
 * work continues server-side. Pollers used to THROW on timeout, which
 * discarded the very state the user needed to understand what was happening
 * and left them with "Refresh to check."
 */
export type PollOutcome<T> =
  | { outcome: "terminal"; status: T }
  | { outcome: "deferred"; status: T | null; reason: "timeout" | "backoff" };

/**
 * Poll a statement pipeline run until it reaches a terminal state.
 *
 * Statement extraction is now a worker job, so the upload mutation returns as
 * soon as the document is durable. This is how the UI learns the outcome.
 */
export async function pollStatementPipeline(
  runId: string,
  options: { intervalMs?: number; timeoutMs?: number; jobId?: string } = {},
): Promise<PollOutcome<StatementPipelineStatus>> {
  const intervalMs = options.intervalMs ?? PIPELINE_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? PIPELINE_POLL_TIMEOUT_MS);

  for (;;) {
    const status = (await (getStatementPipelineStatus as ServerFnCaller)({
      data: { runId, ...(options.jobId ? { jobId: options.jobId } : {}) },
    })) as StatementPipelineStatus;
    if (PIPELINE_TERMINAL_STATUSES.has(status.status)) return { outcome: "terminal", status };
    if (isBackoffBeyondDeadline(status.job?.nextRunAt, deadline)) {
      return { outcome: "deferred", status, reason: "backoff" };
    }
    if (Date.now() >= deadline) return { outcome: "deferred", status, reason: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * True when the job is provably asleep past our deadline. Continuing to poll
 * a job that cannot change for another half hour is pure waste, and the
 * honest answer is already known.
 */
function isBackoffBeyondDeadline(nextRunAt: string | null | undefined, deadline: number): boolean {
  if (!nextRunAt) return false;
  const next = Date.parse(nextRunAt);
  return Number.isFinite(next) && next > deadline;
}

/** Failed error/warning check messages, in the validator's actual shape. */
export function statementValidationMessages(
  validation: StatementPipelineStatus["validation"],
): string[] {
  if (!validation) return [];
  return validation.checks
    .filter(
      (check) => !check.passed && (check.severity === "error" || check.severity === "warning"),
    )
    .map((check) => check.message);
}

const FIELD_SCAN_POLL_INTERVAL_MS = 2000;
const FIELD_SCAN_POLL_TIMEOUT_MS = 10 * 60_000;

const FIELD_SCAN_TERMINAL_STATUSES = new Set(["completed", "failed"]);

/**
 * Poll a queued field scan until it reaches a terminal state.
 * Exported for the /documents page, which runs the same scan.
 */
export async function pollFieldScan(
  jobId: string,
  documentId: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<PollOutcome<FieldScanStatus>> {
  const intervalMs = options.intervalMs ?? FIELD_SCAN_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? FIELD_SCAN_POLL_TIMEOUT_MS);

  for (;;) {
    const status = (await (getFieldScanStatus as ServerFnCaller)({
      data: { jobId, documentId },
    })) as FieldScanStatus;
    if (FIELD_SCAN_TERMINAL_STATUSES.has(status.status)) return { outcome: "terminal", status };
    if (isBackoffBeyondDeadline(status.nextRunAt, deadline)) {
      return { outcome: "deferred", status, reason: "backoff" };
    }
    if (Date.now() >= deadline) return { outcome: "deferred", status, reason: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ============================================================================
// Watcher persistence
//
// The store survives route navigation because it is a module singleton, but a
// full reload loses the in-flight promise entirely — the job kept running
// server-side with nothing left watching it, and the only recovery on offer
// was to tell the user to refresh. Descriptors are small, so persist them and
// re-attach on mount.
// ============================================================================

const WATCHER_STORAGE_KEY = "buwiz.jobwatch.v1";
/** Older than this and the job is long done; do not resurrect a stale card. */
const WATCHER_MAX_AGE_MS = 2 * 60 * 60_000;

interface FieldScanWatcher {
  cardId: string;
  jobId: string;
  documentId: string;
  reconciliationId: string;
  startedAt: number;
}

function readWatchers(): FieldScanWatcher[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WATCHER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - WATCHER_MAX_AGE_MS;
    return parsed.filter(
      (w): w is FieldScanWatcher =>
        !!w &&
        typeof w.jobId === "string" &&
        typeof w.startedAt === "number" &&
        w.startedAt > cutoff,
    );
  } catch {
    return [];
  }
}

function writeWatchers(watchers: FieldScanWatcher[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WATCHER_STORAGE_KEY, JSON.stringify(watchers));
  } catch {
    // Private browsing / quota — persistence is best-effort, never fatal.
  }
}

function rememberWatcher(watcher: FieldScanWatcher): void {
  writeWatchers([...readWatchers().filter((w) => w.cardId !== watcher.cardId), watcher]);
}

function forgetWatcher(cardId: string): void {
  writeWatchers(readWatchers().filter((w) => w.cardId !== cardId));
}

/**
 * Re-attach to field scans that were in flight when the page was last closed.
 * Safe to call on every mount: watchers already being tracked are skipped.
 */
export function rehydrateJobWatchers(queryClient: any): void {
  for (const watcher of readWatchers()) {
    if (jobs.some((j) => j.id === watcher.cardId)) continue;
    jobs = [
      ...jobs,
      { id: watcher.cardId, reconciliationId: watcher.reconciliationId, status: "processing" },
    ];
    emitChange();
    void watchFieldScanJob(watcher, queryClient);
  }
  emitChange();
}

/**
 * Poll one field-scan job to a conclusion and settle its progress card.
 * Shared by a fresh scan and by a watcher re-attached after a reload.
 */
async function watchFieldScanJob(watcher: FieldScanWatcher, queryClient: any): Promise<void> {
  const { cardId, jobId, documentId, reconciliationId } = watcher;
  try {
    const result = await pollFieldScan(jobId, documentId);

    if (result.outcome === "deferred") {
      // Still alive server-side. Say so and keep the card, rather than
      // reporting a failure that has not happened.
      updateJob(cardId, { status: "deferred", detail: describeDeferredScan(result.status) });
      forgetWatcher(cardId);
      return;
    }
    if (result.status.status === "failed") {
      throw new Error(result.status.error || "Field scan failed");
    }

    updateJob(cardId, { status: "done", fieldCount: result.status.fieldCount });
    forgetWatcher(cardId);

    // Invalidate queries so any page showing this reconciliation refreshes
    queryClient.invalidateQueries({ queryKey: ["reconciliations", "detail", reconciliationId] });
    queryClient.invalidateQueries({ queryKey: ["document", documentId] });
  } catch (err: unknown) {
    forgetWatcher(cardId);
    updateJob(cardId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Human-readable summary of a deferred job, for progress cards and errors. */
export function describeDeferredScan(status: FieldScanStatus | null): string {
  if (!status) return "Still processing in the background.";
  if (status.status === "retrying" && status.attempt && status.maxAttempts) {
    const when = status.nextRunAt
      ? ` Next attempt at ${new Date(status.nextRunAt).toLocaleTimeString()}.`
      : "";
    return `Attempt ${status.attempt} of ${status.maxAttempts} failed.${when}`;
  }
  return "Still processing in the background.";
}

/**
 * Start a background field scan for a reconciliation's document.
 *
 * Enqueues the server-side `bbox_scan` job and polls it. The worker downloads
 * and rasterizes the document ONCE and scans every page in a single job,
 * replacing the old path that held a request open across N model calls
 * (ai_findings #20).
 *
 * @param reconciliationId - The reconciliation this scan belongs to
 * @param documentId - The statement document to scan
 * @param queryClient - React Query client for cache invalidation
 * @param forceRescan - If true, clear cached bboxes before scanning
 */
export function startFieldScan(
  reconciliationId: string,
  documentId: string,
  queryClient: any,
  forceRescan?: boolean,
) {
  // Prevent duplicate jobs for the same reconciliation
  const existing = jobs.find(
    (j) => j.reconciliationId === reconciliationId && j.status === "processing",
  );
  if (existing) return;

  // Local card id — distinct from the server job id, which arrives below.
  const cardId = crypto.randomUUID();

  jobs = [
    ...jobs,
    {
      id: cardId,
      reconciliationId,
      status: "processing",
    },
  ];
  emitChange();

  // Fire and forget — runs in background
  (async () => {
    try {
      // If forceRescan, clear cached bounding boxes first so the worker
      // rescans instead of the UI reading stale boxes while it runs.
      if (forceRescan) {
        await (clearDocumentBoundingBoxes as ServerFnCaller)({
          data: { documentId },
        });
      }

      const queued = (await (enqueueFieldScan as ServerFnCaller)({
        data: { documentId },
      })) as { status: "queued"; jobId: string | null; documentId: string };

      if (!queued.jobId) {
        throw new Error("Field scan could not be queued. Try again in a moment.");
      }

      // Record before polling: a reload during the poll must be recoverable.
      rememberWatcher({
        cardId,
        jobId: queued.jobId,
        documentId,
        reconciliationId,
        startedAt: Date.now(),
      });

      await watchFieldScanJob(
        { cardId, jobId: queued.jobId, documentId, reconciliationId, startedAt: Date.now() },
        queryClient,
      );
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      forgetWatcher(cardId);
      updateJob(cardId, {
        status: "error",
        error: errMessage || "Field scan failed",
      });
    }
  })();
}
