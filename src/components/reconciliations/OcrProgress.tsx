/**
 * OcrProgress — Floating bottom-right card showing active OCR jobs
 *
 * Uses useSyncExternalStore to subscribe to the module-level OCR store,
 * so it stays in sync even when rendered from different routes.
 */
import { useOcrJobs, removeOcrJob } from "../../lib/reconciliation-ocr-store";
import type { OcrJob, OcrJobStatus } from "../../lib/reconciliation-ocr-store";

const STATUS_LABELS: Record<OcrJobStatus, string> = {
  processing: "Running AI OCR…",
  retrying: "Retrying…",
  deferred: "Still working in the background",
  done: "OCR Complete",
  error: "OCR Failed",
};

const STATUS_COLORS: Record<OcrJobStatus, string> = {
  processing: "text-blue-500 dark:text-blue-400",
  retrying: "text-amber-500 dark:text-amber-400",
  deferred: "text-slate-500 dark:text-slate-400",
  done: "text-emerald-500 dark:text-emerald-400",
  error: "text-red-500 dark:text-red-400",
};

export function OcrProgress() {
  const jobs = useOcrJobs();

  if (jobs.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9998] flex flex-col gap-2 w-80">
      {jobs.map((job) => (
        <OcrJobCard key={job.id} job={job} />
      ))}
    </div>
  );
}

function OcrJobCard({ job }: { job: OcrJob }) {
  // `deferred` is dismissible even though the work continues: we have stopped
  // watching, so the card can no longer update itself.
  const isTerminal = job.status === "done" || job.status === "error" || job.status === "deferred";

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-slide-up">
      {/* Progress bar */}
      {!isTerminal && (
        <div className="h-0.5 bg-slate-100 dark:bg-slate-700">
          <div className="h-full w-2/3 bg-blue-500 transition-all duration-700 ease-out animate-pulse" />
        </div>
      )}

      <div className="px-4 py-3 flex items-start gap-3">
        {/* Icon */}
        <div className="mt-0.5 shrink-0">
          {job.status === "done" ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              className="text-emerald-500"
            >
              <path
                d="M20 6L9 17l-5-5"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : job.status === "error" ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-red-500">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path
                d="M15 9l-6 6M9 9l6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <div className="w-[18px] h-[18px] rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-blue-500 animate-spin" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-white">Scanning Fields</p>
          <p className={`text-xs mt-0.5 ${STATUS_COLORS[job.status]}`}>
            {job.error || STATUS_LABELS[job.status]}
          </p>
          {job.status === "done" && job.fieldCount != null && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
              {job.fieldCount} fields detected
            </p>
          )}
        </div>

        {/* Dismiss */}
        {isTerminal && (
          <button
            type="button"
            onClick={() => removeOcrJob(job.id)}
            className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
