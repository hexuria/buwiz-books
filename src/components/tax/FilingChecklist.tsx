/**
 * The filing checklist.
 *
 * The screen a filer actually opens. It answers one question — **can I file
 * this, and if not, what do I fix first?** — and its whole design follows from
 * the observation that an unordered list of blockers is nearly useless: some
 * blockers make others unresolvable, so a filer who picks one at random fixes
 * a symptom and watches three more appear.
 *
 * So the NEXT ACTION is singular and prominent, and the rest are shown in
 * dependency order beneath it rather than sorted by severity.
 *
 * The second thing it distinguishes is who can clear a blocker. A missing
 * snapshot is a button. An unacknowledged variance needs the client to say
 * their figure stands, and a missing TIN needs the employee. Presenting those
 * identically sends a filer looking for a control that cannot exist.
 */
import type { FilingWorkspace } from "../../lib/tax/filing-workspace";

const STAGE_DOT: Record<string, string> = {
  clear: "bg-emerald-500",
  blocked: "bg-amber-500",
  not_applicable: "bg-slate-300",
};

export interface FilingChecklistProps {
  workspace: FilingWorkspace;
  /** Invoked for a blocker the product itself can clear. */
  onResolve?: (stage: string) => void;
}

export function FilingChecklist({ workspace, onResolve }: FilingChecklistProps) {
  const { blockers, nextAction, canFile } = workspace;

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-900">
          {workspace.formCode} · {workspace.periodStart} to {workspace.periodEnd}
        </h2>
        <p className="text-sm text-slate-600">
          {workspace.currentState} → {workspace.targetState}
        </p>
      </header>

      {canFile ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm font-medium text-emerald-900">Ready to file</p>
          <p className="mt-1 text-sm text-emerald-800">
            Every check has passed. Filing will take the as-filed snapshot and record the period as
            filed.
          </p>
        </div>
      ) : (
        nextAction && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-800">
              Do this next · {nextAction.stageLabel}
            </p>
            <p className="mt-1 text-sm text-amber-900">{nextAction.message}</p>
            {nextAction.resolvableInProduct ? (
              onResolve && (
                <button
                  type="button"
                  onClick={() => onResolve(nextAction.stage)}
                  className="mt-2 rounded bg-amber-900 px-3 py-1.5 text-sm font-medium text-white"
                >
                  Resolve
                </button>
              )
            ) : (
              // Saying so is the point: there is no control for this, and a
              // filer should not go looking for one.
              <p className="mt-2 text-xs text-amber-800">
                This one cannot be cleared from here — it needs something from outside the product.
              </p>
            )}
          </div>
        )
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Progress</h3>
        <ol className="space-y-1">
          {workspace.stages.map((stage) => (
            <li key={stage.stage} className="flex items-center gap-2 text-sm">
              <span
                className={`inline-block h-2 w-2 rounded-full ${STAGE_DOT[stage.status]}`}
                aria-hidden="true"
              />
              <span className={stage.status === "blocked" ? "text-slate-900" : "text-slate-500"}>
                {stage.label}
              </span>
              {stage.blockerCount > 0 && (
                <span className="text-xs text-amber-700">
                  {stage.blockerCount} blocker{stage.blockerCount === 1 ? "" : "s"}
                </span>
              )}
              <span className="sr-only">{stage.status}</span>
            </li>
          ))}
        </ol>
      </div>

      {blockers.length > 1 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Everything outstanding ({blockers.length})
          </h3>
          <p className="text-sm text-slate-600">
            In the order they have to be cleared — earlier ones make later ones unresolvable.
          </p>
          <ol className="space-y-2">
            {blockers.map((blocker, index) => (
              <li
                key={`${blocker.stage}-${index}`}
                className="rounded border border-slate-200 p-2 text-sm"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {blocker.stageLabel}
                  </span>
                  {!blocker.resolvableInProduct && (
                    <span className="text-xs text-slate-500">needs input from outside</span>
                  )}
                </div>
                <p className="mt-1 text-slate-800">{blocker.message}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
