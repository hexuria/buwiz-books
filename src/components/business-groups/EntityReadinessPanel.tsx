import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  ClockCountdown,
  Question,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  EntityReadiness,
  EntityReadinessStatus,
  EntityReadinessSummary,
} from "../../lib/business-groups/performance";

const statusPresentation: Record<
  EntityReadinessStatus,
  { label: string; description: string; tone: string }
> = {
  ready: {
    label: "Current",
    description: "Projection is current with the latest recorded ledger activity.",
    tone: "bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200",
  },
  missing: {
    label: "Not initialized",
    description: "This business has not completed its first projection.",
    tone: "bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-white/65",
  },
  pending: {
    label: "Queued",
    description: "Projection work is queued and waiting to start.",
    tone: "bg-sky-50 text-sky-800 dark:bg-sky-400/10 dark:text-sky-200",
  },
  building: {
    label: "Updating",
    description: "Projection work is currently rebuilding this business.",
    tone: "bg-sky-50 text-sky-800 dark:bg-sky-400/10 dark:text-sky-200",
  },
  stale: {
    label: "Delayed",
    description: "Projection work has not caught up within the expected five-minute window.",
    tone: "bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200",
  },
  failed: {
    label: "Failed",
    description: "Projection work failed. Projected totals are unavailable until it recovers.",
    tone: "bg-rose-50 text-rose-800 dark:bg-rose-400/10 dark:text-rose-200",
  },
};

function StatusIcon({ status }: { status: EntityReadinessStatus }) {
  const iconProps = { size: 14, weight: "fill" as const, "aria-hidden": true };
  if (status === "ready") return <CheckCircle {...iconProps} />;
  if (status === "failed" || status === "stale") return <WarningCircle {...iconProps} />;
  if (status === "missing") return <Question {...iconProps} />;
  if (status === "pending") return <ClockCountdown {...iconProps} />;
  return <ArrowClockwise {...iconProps} className="motion-safe:animate-spin" />;
}

export function EntityReadinessBadge({ readiness }: { readiness?: EntityReadiness }) {
  if (!readiness) return null;
  const presentation = statusPresentation[readiness.status];
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold leading-none ${presentation.tone}`}
      title={presentation.description}
    >
      <StatusIcon status={readiness.status} />
      {presentation.label}
    </span>
  );
}

function formatLag(seconds: number | null): string {
  if (seconds === null) return "Not available";
  if (seconds === 0) return "No outstanding lag";
  if (seconds < 60) return "Less than 1 minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} hours` : `${hours}h ${remainingMinutes}m`;
}

function ReadinessDatum({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-white/35">
        {label}
      </dt>
      <dd className="mt-1 text-xs leading-relaxed text-slate-700 dark:text-white/70">{children}</dd>
    </div>
  );
}

export function EntityReadinessPanel({
  readiness,
  summary,
  sourceMode,
  onPageChange,
}: {
  readiness: readonly EntityReadiness[];
  summary: EntityReadinessSummary | null;
  sourceMode: "live_ledger" | "shadow" | "projected";
  onPageChange?: (page: number) => void;
}) {
  if (!summary) return null;

  const visibleReadiness = readiness.slice(0, 25);
  const currentCount = summary.statusCounts.ready;
  const issueCount = summary.total - currentCount;
  const pageCount = Math.max(1, Math.ceil(summary.total / summary.pageSize));

  return (
    <section
      aria-labelledby="business-projection-readiness-heading"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111820]"
    >
      <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 dark:border-white/10 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h2 id="business-projection-readiness-heading" className="text-sm font-semibold">
            Business data readiness
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-white/40">
            {sourceMode === "shadow"
              ? "Live-ledger totals remain available while projection readiness is checked. Open a business for details."
              : "Open a business to inspect projection, request, and worker timing."}
          </p>
        </div>
        <p
          className={`text-xs font-semibold ${
            issueCount > 0
              ? "text-amber-700 dark:text-amber-300"
              : "text-emerald-700 dark:text-emerald-300"
          }`}
          role="status"
          aria-live="polite"
        >
          {currentCount}/{summary.total} current
        </p>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
        {visibleReadiness.map((entry) => {
          const presentation = statusPresentation[entry.status];
          return (
            <li key={entry.organizationId}>
              <details className="group">
                <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-700 dark:hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
                  <CaretRight
                    size={15}
                    weight="bold"
                    aria-hidden="true"
                    className="shrink-0 text-slate-400 transition-transform group-open:rotate-90"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900 dark:text-white">
                      {entry.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-white/40">
                      {entry.groupNames.join(", ")}
                    </span>
                  </span>
                  <EntityReadinessBadge readiness={entry} />
                </summary>
                <div className="border-t border-slate-100 bg-slate-50/70 px-5 py-4 dark:border-white/[0.06] dark:bg-white/[0.025]">
                  <p className="mb-4 text-xs leading-relaxed text-slate-600 dark:text-white/55">
                    {presentation.description}
                  </p>
                  <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                    <ReadinessDatum label="Business groups">
                      {entry.groupNames.join(", ")}
                    </ReadinessDatum>
                    <ReadinessDatum label="Last projection">
                      {entry.projectionAsOf ? (
                        <time dateTime={entry.projectionAsOf}>
                          {new Date(entry.projectionAsOf).toLocaleString()}
                        </time>
                      ) : (
                        "Not completed"
                      )}
                    </ReadinessDatum>
                    <ReadinessDatum label="Request or job activity">
                      {entry.syncActivityAt ? (
                        <time dateTime={entry.syncActivityAt}>
                          {new Date(entry.syncActivityAt).toLocaleString()}
                        </time>
                      ) : (
                        "Not recorded"
                      )}
                    </ReadinessDatum>
                    <ReadinessDatum label="Request or job age">
                      {entry.status === "ready" ? "Not waiting" : formatLag(entry.syncAgeSeconds)}
                    </ReadinessDatum>
                    <ReadinessDatum label="Ledger projection gap">
                      {entry.ledgerLagSeconds === null
                        ? "No ledger activity to compare"
                        : formatLag(entry.ledgerLagSeconds)}
                    </ReadinessDatum>
                  </dl>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      {visibleReadiness.length === 0 && (
        <p className="px-5 py-6 text-center text-sm text-slate-500 dark:text-white/45">
          No businesses are on this readiness page.
        </p>
      )}
      {onPageChange && pageCount > 1 && (
        <div className="flex items-center justify-between gap-4 border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <p className="text-xs text-slate-500 dark:text-white/40">
            Page {summary.page} of {pageCount} · showing {summary.returnedCount} of {summary.total}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={summary.page <= 1}
              onClick={() => onPageChange(Math.max(1, summary.page - 1))}
              className="min-h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-white/70"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={summary.page >= pageCount}
              onClick={() => onPageChange(Math.min(pageCount, summary.page + 1))}
              className="min-h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-white/70"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
