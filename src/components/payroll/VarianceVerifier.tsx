/**
 * Payroll variance verifier.
 *
 * D-N7 in the interface: the product files the CLIENT's figure, records the
 * variance and the acknowledgement immutably, and refuses to advance while an
 * unacknowledged blocking variance stands. **The product is the control, not
 * the computer of record.**
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT OFFER. There is no "apply the engine's
 * figure" button. The register is what the employer actually withheld and what
 * the employees were actually paid; overwriting it here would make the ledger
 * disagree with payslips already in people's hands, and would do it with one
 * click and no record. The only action is to ACKNOWLEDGE, with a written
 * reason — a human decision that the client's figures stand.
 *
 * The two variance kinds are shown separately because they have different
 * remedies. A tax variance means the withheld amount disagrees with the
 * engine. A contribution variance means the statutory bases disagree with the
 * schedule — which matters even when the tax arithmetic is right, because it
 * may be right on a base that is itself wrong.
 */
import { useState } from "react";
import type {
  PayrollVarianceLine,
  PayrollVarianceReport,
} from "../../routes/api/-payroll-variances";

function peso(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Signed, with the direction named — "short by" reads faster than a minus sign. */
function variance(value: string | null): { text: string; tone: string } {
  if (value === null) return { text: "—", tone: "text-slate-400" };
  const n = Number(value);
  if (n === 0) return { text: "0.00", tone: "text-slate-400" };
  return n > 0
    ? { text: `${peso(value)} under-withheld`, tone: "text-amber-700" }
    : { text: `${peso(String(-n))} over-withheld`, tone: "text-sky-700" };
}

function VarianceRow({ line }: { line: PayrollVarianceLine }) {
  const v = variance(line.varianceAmount);
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-3 text-slate-900">
        {line.employeeName ?? <span className="text-slate-400">Unnamed employee</span>}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
        {peso(line.reportedTaxWithheld)}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
        {peso(line.computedTaxWithheld)}
      </td>
      <td className={`py-2 text-right tabular-nums font-medium ${v.tone}`}>{v.text}</td>
    </tr>
  );
}

function ContributionRow({ line }: { line: PayrollVarianceLine }) {
  const pairs: Array<[string, string | null, string | null]> = [
    ["SSS", line.sssEmployeeShare, line.expectedSssEmployeeShare],
    ["PhilHealth", line.philHealthEmployeeShare, line.expectedPhilHealthEmployeeShare],
    ["Pag-IBIG", line.pagIbigEmployeeShare, line.expectedPagIbigEmployeeShare],
  ];
  // Only the components that actually differ — listing all three when one moved
  // buries the finding.
  const differing = pairs.filter(([, reported, expected]) => {
    if (reported === null || expected === null) return false;
    return Number(reported) !== Number(expected);
  });

  return (
    <tr className="border-b border-slate-100 last:border-0 align-top">
      <td className="py-2 pr-3 text-slate-900">
        {line.employeeName ?? <span className="text-slate-400">Unnamed employee</span>}
      </td>
      <td className="py-2 pr-3 text-slate-600">
        {differing.length === 0 ? (
          <span className="text-slate-400">—</span>
        ) : (
          <ul className="space-y-0.5">
            {differing.map(([label, reported, expected]) => (
              <li key={label} className="tabular-nums">
                <span className="font-medium text-slate-700">{label}</span>{" "}
                <span className="text-slate-500">register {peso(reported)}</span>{" "}
                <span className="text-slate-400">·</span>{" "}
                <span className="text-slate-500">schedule {peso(expected)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="py-2 text-right tabular-nums font-medium text-amber-700">
        {peso(line.contributionVarianceAmount)}
      </td>
    </tr>
  );
}

export interface VarianceVerifierProps {
  report: PayrollVarianceReport;
  onAcknowledge: (note: string) => Promise<void>;
  isAcknowledging?: boolean;
}

export function VarianceVerifier({
  report,
  onAcknowledge,
  isAcknowledging = false,
}: VarianceVerifierProps) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hasVariances = report.taxVariances.length > 0 || report.contributionVariances.length > 0;
  const alreadyAcknowledged = report.acknowledgedAt !== null;
  const isPosted = report.journalHeaderId !== null;

  async function submit() {
    if (!note.trim()) {
      // The reason is the part that answers an assessment. A bare timestamp is
      // not an explanation, and the database refuses one anyway.
      setError("Give a reason. This is what explains the figures under assessment.");
      return;
    }
    setError(null);
    try {
      await onAcknowledge(note.trim());
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the acknowledgement.");
    }
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-900">Variance review</h2>
        <p className="text-sm text-slate-600">
          {report.periodStart} to {report.periodEnd} · {report.totalLines} employee
          {report.totalLines === 1 ? "" : "s"}
        </p>
      </header>

      {report.blockers.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">
            {isPosted ? "This run is posted" : "Posting and filing are blocked"}
          </p>
          <ul className="mt-1 space-y-1 text-sm text-amber-800">
            {report.blockers.map((blocker) => (
              <li key={blocker}>· {blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {!hasVariances && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Every line agrees with the engine and the statutory schedule. Nothing to acknowledge.
        </div>
      )}

      {report.taxVariances.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Tax variances ({report.taxVariances.length})
          </h3>
          <p className="text-sm text-slate-600">
            What the register withheld differs from what the engine computes. The register is what
            was actually withheld and what will be filed — the engine's figure is shown for
            comparison, not to replace it.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-medium">Employee</th>
                  <th className="py-2 pr-3 text-right font-medium">Register</th>
                  <th className="py-2 pr-3 text-right font-medium">Engine</th>
                  <th className="py-2 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody>
                {report.taxVariances.map((line) => (
                  <VarianceRow key={line.lineId} line={line} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report.contributionVariances.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Contribution variances ({report.contributionVariances.length})
          </h3>
          <p className="text-sm text-slate-600">
            The statutory contributions differ from the schedule. This matters even when the tax
            arithmetic is correct — the tax may be right on a base that is itself wrong.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-medium">Employee</th>
                  <th className="py-2 pr-3 font-medium">Components that differ</th>
                  <th className="py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.contributionVariances.map((line) => (
                  <ContributionRow key={line.lineId} line={line} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report.contributionChecksSkipped > 0 && (
        <p className="text-sm text-slate-500">
          {report.contributionChecksSkipped} line
          {report.contributionChecksSkipped === 1 ? "" : "s"} could not be checked against the
          schedule — contributions are monthly obligations, so a semi-monthly or weekly period
          carries a fraction that employers split by differing conventions. An unchecked line is not
          a clean one.
        </p>
      )}

      {alreadyAcknowledged ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-900">Acknowledged</p>
          <p className="mt-1 text-sm text-slate-600">
            {report.acknowledgedAt} by {report.acknowledgedBy ?? "unknown"}
          </p>
        </div>
      ) : (
        hasVariances &&
        !isPosted && (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <label htmlFor="ack-note" className="block text-sm font-medium text-slate-900">
              Why do these figures stand?
            </label>
            <p className="text-sm text-slate-600">
              Recorded immutably against this run. This is the explanation an assessment will ask
              for — &ldquo;the employee started mid-month and the register prorated&rdquo; answers a
              finding; a timestamp does not.
            </p>
            <textarea
              id="ack-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded border border-slate-300 p-2 text-sm"
              placeholder="Reason the client's figures are correct as filed"
            />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button
              type="button"
              onClick={submit}
              disabled={isAcknowledging}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {isAcknowledging ? "Recording…" : "Acknowledge and unlock posting"}
            </button>
          </div>
        )
      )}
    </section>
  );
}
