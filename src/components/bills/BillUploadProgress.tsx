/**
 * BillUploadProgress — Floating bottom-right card showing active upload jobs
 *
 * Uses useSyncExternalStore to subscribe to the module-level bill upload store,
 * so it stays in sync even when rendered from different routes.
 *
 * Confirm-first: jobs pause at "awaiting_review" after AI extraction and show
 * an inline preview (vendor, amount, invoice #, line items) with
 * Create bill / Dismiss actions — nothing is written until the user applies.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  useBillUploadJobs,
  removeJob,
  confirmBillUpload,
  dismissBillUpload,
} from "../../lib/bill-upload-store";
import type { BillUploadJob, JobStatus } from "../../lib/bill-upload-store";

const STATUS_LABELS: Record<JobStatus, string> = {
  uploading: "Uploading…",
  processing: "Analyzing with AI…",
  awaiting_review: "Ready for review",
  creating: "Creating bill…",
  done: "Complete",
  error: "Failed",
};

const STATUS_COLORS: Record<JobStatus, string> = {
  uploading: "text-blue-500 dark:text-blue-400",
  processing: "text-amber-500 dark:text-amber-400",
  awaiting_review: "text-violet-500 dark:text-violet-400",
  creating: "text-indigo-500 dark:text-indigo-400",
  done: "text-emerald-500 dark:text-emerald-400",
  error: "text-red-500 dark:text-red-400",
};

export function BillUploadProgress() {
  const jobs = useBillUploadJobs();

  if (jobs.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9998] flex flex-col gap-2 w-80">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  );
}

function JobCard({ job }: { job: BillUploadJob }) {
  const queryClient = useQueryClient();
  const isTerminal = job.status === "done" || job.status === "error";
  const isReview = job.status === "awaiting_review";

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-slide-up">
      {/* Progress bar */}
      {!isTerminal && !isReview && (
        <div className="h-0.5 bg-slate-100 dark:bg-slate-700">
          <div
            className={`h-full transition-all duration-700 ease-out ${
              job.status === "uploading"
                ? "w-1/4 bg-blue-500"
                : job.status === "processing"
                  ? "w-2/3 bg-amber-500"
                  : "w-[90%] bg-indigo-500"
            }`}
          />
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
          ) : isReview ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-violet-500">
              <path
                d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
            </svg>
          ) : (
            <div className="w-[18px] h-[18px] rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-blue-500 animate-spin" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-white truncate">
            {job.fileName}
          </p>
          <p className={`text-xs mt-0.5 ${STATUS_COLORS[job.status]}`}>
            {job.error || STATUS_LABELS[job.status]}
          </p>
          {job.status === "creating" && job.vendorName && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">
              {job.vendorName}
              {job.amount ? ` • $${job.amount}` : ""}
            </p>
          )}
        </div>

        {/* Dismiss */}
        {isTerminal && (
          <button
            type="button"
            onClick={() => removeJob(job.id)}
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

      {/* Review preview — confirm-first: nothing is created until "Create bill" */}
      {isReview && job.parsed && (
        <div className="px-4 pb-3 border-t border-slate-100 dark:border-slate-700/60">
          <dl className="mt-2.5 space-y-1">
            <ReviewRow label="Vendor" value={job.parsed.vendor?.name || "—"} />
            <ReviewRow
              label="Amount"
              value={
                job.parsed.invoice?.amount != null
                  ? `$${Number(job.parsed.invoice.amount).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}`
                  : "—"
              }
            />
            <ReviewRow label="Invoice #" value={job.parsed.invoice?.invoiceNumber || "—"} />
            <ReviewRow label="Line items" value={String(job.parsed.lineItems?.length ?? 0)} />
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => confirmBillUpload(job.id, queryClient)}
              className="flex-1 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition-colors"
            >
              Create bill
            </button>
            <button
              type="button"
              onClick={() => dismissBillUpload(job.id)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">{label}</dt>
      <dd className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate text-right">
        {value}
      </dd>
    </div>
  );
}
