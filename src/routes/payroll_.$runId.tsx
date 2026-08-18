/**
 * The payroll filing journey — one period, end to end.
 *
 * Everything before this existed as engines nothing could reach. This is the
 * screen a bookkeeper actually works in: it walks one payroll period from
 * computed figures through variance review, ledger posting, the as-filed
 * snapshot, and finally to filed.
 *
 * WHY THE CHECKLIST DRIVES THE PAGE RATHER THAN A WIZARD. A wizard implies the
 * steps are sequential and each is reachable once. They are not — a period
 * bounces backwards (a variance is found after posting, a certificate arrives
 * late), and the same blocker can recur. So the page renders whatever
 * `buildFilingWorkspace` currently says, in dependency order, and the "do this
 * next" is derived rather than remembered. Reload the page and it tells you the
 * truth about right now.
 *
 * THE ACTIONS ARE NOT THE GATE. Every button here calls a server function that
 * re-derives the workspace and refuses what is blocked. Hiding a button is a
 * courtesy to the user, not a control — someone calling the endpoint directly
 * meets the same wall.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getPayrollVarianceReport,
  acknowledgePayrollVariances,
  type PayrollVarianceReport,
} from "./api/-payroll-variances";
import { getFilingWorkspace, takeFilingSnapshot, markPeriodFiled } from "./api/-filing";
import {
  importPayrollRegister,
  computePayrollFilingRun,
  postPayrollFilingRun,
  issuePayrollFilingArtifacts,
} from "./api/-payroll-runs";
import type { FilingWorkspace } from "../lib/tax/filing-workspace";
import { keys } from "../lib/query-keys";
import { VarianceVerifier } from "../components/payroll/VarianceVerifier";
import { FilingChecklist } from "../components/tax/FilingChecklist";

export const Route = createFileRoute("/payroll_/$runId")({
  component: PayrollFilingPage,
});

function PayrollFilingPage() {
  const { runId } = Route.useParams();
  const queryClient = useQueryClient();
  const [filingReference, setFilingReference] = useState("");
  const [registerText, setRegisterText] = useState("");
  const [importIssues, setImportIssues] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const variances = useQuery({
    queryKey: keys.payroll.variances(runId),
    queryFn: () =>
      (getPayrollVarianceReport as (o: { data: unknown }) => Promise<PayrollVarianceReport>)({
        data: { runId },
      }),
  });

  const workspace = useQuery({
    queryKey: keys.filing.workspace(runId),
    queryFn: () =>
      (getFilingWorkspace as (o: { data: unknown }) => Promise<FilingWorkspace>)({
        data: { runId },
      }),
  });

  // Both views read the same underlying state, so any mutation has to
  // invalidate both — otherwise the checklist and the verifier disagree on
  // screen, and the user cannot tell which is stale.
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: keys.payroll.run(runId) });
    queryClient.invalidateQueries({ queryKey: keys.filing.workspace(runId) });
  };

  const acknowledge = useMutation({
    mutationFn: (note: string) =>
      (acknowledgePayrollVariances as (o: { data: unknown }) => Promise<unknown>)({
        data: { runId, note },
      }),
    onSuccess: refreshAll,
  });

  const importRegister = useMutation({
    mutationFn: (table: string[][]) =>
      (
        importPayrollRegister as (o: { data: unknown }) => Promise<{
          persisted: number;
          canProceed: boolean;
          issues: Array<{ message: string }>;
          unmappedColumns: string[];
        }>
      )({
        data: { runId, table },
      }),
    onSuccess: (result) => {
      setImportIssues([
        ...result.issues.map((issue) => issue.message),
        ...result.unmappedColumns.map((column) => `Unmapped column: ${column}`),
      ]);
      if (result.canProceed) refreshAll();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const compute = useMutation({
    mutationFn: () =>
      (computePayrollFilingRun as (o: { data: unknown }) => Promise<unknown>)({
        data: { runId },
      }),
    onSuccess: refreshAll,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const post = useMutation({
    mutationFn: () =>
      (postPayrollFilingRun as (o: { data: unknown }) => Promise<unknown>)({
        data: { runId },
      }),
    onSuccess: refreshAll,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const snapshot = useMutation({
    mutationFn: () =>
      (takeFilingSnapshot as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          runId,
        },
      }),
    onSuccess: refreshAll,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const issue = useMutation({
    mutationFn: () =>
      (
        issuePayrollFilingArtifacts as (o: { data: unknown }) => Promise<{
          alphalist: { fileName: string; content: string; blockingIssues: string[] };
          certificates: Array<{
            employeeName: string;
            pdfBase64: string;
            blockingIssues: string[];
          }>;
        }>
      )({ data: { runId } }),
    onSuccess: (issued) => {
      const dat = new Blob([issued.alphalist.content], { type: "text/plain" });
      const datUrl = URL.createObjectURL(dat);
      const datLink = document.createElement("a");
      datLink.href = datUrl;
      datLink.download = issued.alphalist.fileName;
      datLink.click();
      URL.revokeObjectURL(datUrl);
      for (const cert of issued.certificates) {
        const pdf = Uint8Array.from(atob(cert.pdfBase64), (c) => c.charCodeAt(0));
        const pdfUrl = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
        const link = document.createElement("a");
        link.href = pdfUrl;
        link.download = `2316-${cert.employeeName.replace(/[^A-Za-z0-9]+/g, "_")}.pdf`;
        link.click();
        URL.revokeObjectURL(pdfUrl);
      }
      if (issued.alphalist.blockingIssues.length > 0) {
        setActionError(issued.alphalist.blockingIssues.join(" "));
      }
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const file = useMutation({
    mutationFn: () =>
      (markPeriodFiled as (o: { data: unknown }) => Promise<unknown>)({
        data: { runId, filingReference: filingReference.trim() },
      }),
    onSuccess: () => {
      setFilingReference("");
      refreshAll();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  if (variances.isLoading || workspace.isLoading) {
    return <p className="p-6 text-sm text-slate-600">Loading period…</p>;
  }

  if (variances.error || workspace.error) {
    const error = variances.error ?? workspace.error;
    return (
      <div className="p-6">
        <p className="text-sm text-red-700">
          {error instanceof Error ? error.message : "Could not load this payroll period."}
        </p>
      </div>
    );
  }

  const report = variances.data!;
  const space = workspace.data!;
  const nextStage = space.nextAction?.stage ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <FilingChecklist
        workspace={space}
        onResolve={(stage) => {
          setActionError(null);
          // Only the snapshot is a one-click resolution. The others are
          // resolved by doing the work elsewhere on this page, so scrolling to
          // them is more honest than a button that appears to act and does not.
          if (stage === "snapshot") snapshot.mutate();
          else if (stage === "computation") compute.mutate();
          else if (stage === "posting") post.mutate();
          else document.getElementById(`stage-${stage}`)?.scrollIntoView({ behavior: "smooth" });
        }}
      />

      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {actionError}
        </div>
      )}

      <div id="stage-computation" className="space-y-3 border-t border-slate-200 pt-6">
        <h2 className="text-lg font-semibold text-slate-900">Register and computation</h2>
        <p className="text-sm text-slate-600">
          Paste a CSV using the published template headers. Employees are matched by TIN on party
          tax profiles — a missing profile is a data problem, not a prompt to invent one.
        </p>
        <textarea
          value={registerText}
          onChange={(event) => setRegisterText(event.target.value)}
          className="h-40 w-full rounded border border-slate-300 p-2 font-mono text-xs"
          placeholder="employeeTin,employeeLastName,employeeFirstName,basicSalary,reportedTaxWithheld"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!registerText.trim() || importRegister.isPending}
            onClick={() => {
              setActionError(null);
              const table = registerText
                .trim()
                .split(/\r?\n/)
                .map((line) => line.split(",").map((cell) => cell.trim()));
              importRegister.mutate(table);
            }}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {importRegister.isPending ? "Importing…" : "Import register"}
          </button>
          <button
            type="button"
            disabled={compute.isPending}
            onClick={() => {
              setActionError(null);
              compute.mutate();
            }}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            {compute.isPending ? "Computing…" : "Compute run"}
          </button>
          <button
            type="button"
            disabled={post.isPending}
            onClick={() => {
              setActionError(null);
              post.mutate();
            }}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            {post.isPending ? "Posting…" : "Post to ledger"}
          </button>
          <button
            type="button"
            disabled={issue.isPending}
            onClick={() => {
              setActionError(null);
              issue.mutate();
            }}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            {issue.isPending ? "Issuing…" : "Download 2316 + 1604-C"}
          </button>
        </div>
        {importIssues.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
            {importIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>

      <div id="stage-posting" />

      <div id="stage-variance_review" className="border-t border-slate-200 pt-6">
        <VarianceVerifier
          report={report}
          isAcknowledging={acknowledge.isPending}
          onAcknowledge={async (note) => {
            setActionError(null);
            await acknowledge.mutateAsync(note);
          }}
        />
      </div>

      <div id="stage-submission" className="space-y-3 border-t border-slate-200 pt-6">
        <h2 className="text-lg font-semibold text-slate-900">Submission</h2>

        {nextStage === "submission" || space.canFile ? (
          <>
            <p className="text-sm text-slate-600">
              Submit the return through eBIRForms or eFPS, then record the reference the BIR
              returned. The period is not marked filed until that reference exists — an unreferenced
              &ldquo;filed&rdquo; period cannot be traced back to a submission.
            </p>
            <label htmlFor="filing-ref" className="block text-sm font-medium text-slate-900">
              BIR filing reference
            </label>
            <input
              id="filing-ref"
              value={filingReference}
              onChange={(e) => setFilingReference(e.target.value)}
              className="w-full max-w-sm rounded border border-slate-300 p-2 text-sm"
              placeholder="e.g. 1604C-2026-000123"
            />
            <div>
              <button
                type="button"
                disabled={!filingReference.trim() || file.isPending}
                onClick={() => {
                  setActionError(null);
                  file.mutate();
                }}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {file.isPending ? "Recording…" : "Mark period filed"}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-600">
            Clear the blockers above first. The reference is recorded last, once the return has
            actually been submitted.
          </p>
        )}
      </div>
    </div>
  );
}
