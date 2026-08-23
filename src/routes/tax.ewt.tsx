/** Stage 3b: record tax we withheld from a supplier, build the QAP, issue 2307, remit. */
import { createFileRoute } from "@tanstack/react-router";
import { PhTaxGate } from "../components/PhTaxGate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  buildStoredQap,
  captureWithholdingPayment,
  issueWithholding2307,
  listWithholdingPayments,
  remitWithholding,
  saveStoredQap,
} from "./api/-tax-ewt";

import { issueStoredQapDat } from "./api/-tax-ewt";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/tax/ewt")({
  component: TaxEwtPageGated,
});

// D6 country gate: page body renders only per the PH module state
// (off → enable prompt, archived → read-only banner, active → as-is).
function TaxEwtPageGated() {
  return (
    <PhTaxGate>
      <TaxEwtPage />
    </PhTaxGate>
  );
}

function TaxEwtPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [payeeTin, setPayeeTin] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [periodStart, setPeriodStart] = useState("2026-01-01");
  const [periodEnd, setPeriodEnd] = useState("2026-03-31");
  const [paymentType, setPaymentType] = useState("professional_fees");
  const [payeeType, setPayeeType] = useState("corporate");
  const [isTopWithholdingAgent, setIsTopWithholdingAgent] = useState(false);
  const [hasSwornDeclaration, setHasSwornDeclaration] = useState(false);
  const [grossAmount, setGrossAmount] = useState("");
  const [vatAmount, setVatAmount] = useState("");
  const [certificateIssued, setCertificateIssued] = useState(false);
  const [qap, setQap] = useState<null | {
    qap: {
      totalTaxWithheld: string;
      paymentCount: number;
      certificatesNotIssued: number;
      blockingIssues: string[];
      lines: Array<{ payeeRegisteredName: string; atc: string; taxWithheld: string }>;
    };
    remittance: Array<{ formCode: string; dueDate: string; note: string }>;
  }>(null);

  const list = useQuery({
    queryKey: [...keys.tax.all(), "ewt"],
    queryFn: () => (listWithholdingPayments as () => Promise<Array<Record<string, unknown>>>)(),
  });

  const capture = useMutation({
    mutationFn: () =>
      (captureWithholdingPayment as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          payeeTin,
          payeeRegisteredName: payeeName,
          periodStart,
          periodEnd,
          paymentType,
          payeeType,
          isTopWithholdingAgent,
          hasSwornDeclaration,
          grossAmount,
          vatAmount: vatAmount || undefined,
          certificateIssued,
        },
      }),
    onSuccess: () => {
      setPayeeTin("");
      setPayeeName("");
      setGrossAmount("");
      setVatAmount("");
      queryClient.invalidateQueries({ queryKey: keys.tax.all() });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const build = useMutation({
    mutationFn: () =>
      (buildStoredQap as (o: { data: unknown }) => Promise<NonNullable<typeof qap>>)({
        data: { periodStart, periodEnd },
      }),
    onSuccess: setQap,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const saveQap = useMutation({
    mutationFn: () =>
      (saveStoredQap as (o: { data: unknown }) => Promise<unknown>)({
        data: { periodStart, periodEnd },
      }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const issue = useMutation({
    mutationFn: (paymentId: string) =>
      (
        issueWithholding2307 as (o: {
          data: unknown;
        }) => Promise<{ pdfBase64: string; certificateNumber: string; blockingIssues: string[] }>
      )({
        data: { paymentId },
      }),
    onSuccess: (result) => {
      if (result.blockingIssues.length > 0) setError(result.blockingIssues.join(" "));
      const bytes = Uint8Array.from(atob(result.pdfBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${result.certificateNumber}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      queryClient.invalidateQueries({ queryKey: keys.tax.all() });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const remit = useMutation({
    mutationFn: () =>
      (
        remitWithholding as (o: {
          data: unknown;
        }) => Promise<{ formCode: string; taxWithheld: string; dueDate: string }>
      )({
        data: { month: Number(periodEnd.slice(5, 7)), year: Number(periodEnd.slice(0, 4)) },
      }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const qapDat = useMutation({
    mutationFn: () =>
      (
        issueStoredQapDat as (o: {
          data: unknown;
        }) => Promise<{ fileName: string; content: string; blockingIssues: string[] }>
      )({
        data: { periodStart, periodEnd },
      }),
    onSuccess: (issued) => {
      const dat = new Blob([issued.content], { type: "text/plain" });
      const url = URL.createObjectURL(dat);
      const link = document.createElement("a");
      link.href = url;
      link.download = issued.fileName;
      link.click();
      URL.revokeObjectURL(url);
      if (issued.blockingIssues.length > 0) setError(issued.blockingIssues.join(" "));
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Expanded withholding</h1>
        <p className="mt-1 text-sm text-slate-600">
          Record a payment we withheld from, issue the substitute 2307, save the QAP, and remit
          0619-E / 1601-EQ. The original bill journal is still the purchase-side posting path.
        </p>
      </header>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      <section className="grid max-w-xl grid-cols-2 gap-3">
        <input
          value={payeeTin}
          onChange={(e) => setPayeeTin(e.target.value)}
          placeholder="Payee TIN"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={payeeName}
          onChange={(e) => setPayeeName(e.target.value)}
          placeholder="Payee registered name"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          type="date"
          value={periodStart}
          onChange={(e) => setPeriodStart(e.target.value)}
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          type="date"
          value={periodEnd}
          onChange={(e) => setPeriodEnd(e.target.value)}
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <select
          value={paymentType}
          onChange={(e) => setPaymentType(e.target.value)}
          className="rounded border border-slate-300 p-2 text-sm"
        >
          <option value="professional_fees">Professional fees</option>
          <option value="rental">Rental</option>
          <option value="contractor">Contractor</option>
          <option value="goods">Goods</option>
          <option value="services">Services</option>
        </select>
        <select
          value={payeeType}
          onChange={(e) => setPayeeType(e.target.value)}
          className="rounded border border-slate-300 p-2 text-sm"
        >
          <option value="corporate">Corporate</option>
          <option value="individual">Individual</option>
        </select>
        <input
          value={grossAmount}
          onChange={(e) => setGrossAmount(e.target.value)}
          placeholder="Gross amount"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={vatAmount}
          onChange={(e) => setVatAmount(e.target.value)}
          placeholder="VAT amount (optional)"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <label className="text-sm">
          <input
            type="checkbox"
            checked={isTopWithholdingAgent}
            onChange={(e) => setIsTopWithholdingAgent(e.target.checked)}
          />{" "}
          We are a TWA
        </label>
        <label className="text-sm">
          <input
            type="checkbox"
            checked={hasSwornDeclaration}
            onChange={(e) => setHasSwornDeclaration(e.target.checked)}
          />{" "}
          Sworn declaration
        </label>
        <label className="text-sm col-span-2">
          <input
            type="checkbox"
            checked={certificateIssued}
            onChange={(e) => setCertificateIssued(e.target.checked)}
          />{" "}
          2307 already issued to the payee
        </label>
      </section>
      <div>
        <button
          type="button"
          disabled={capture.isPending || !payeeTin || !payeeName || !grossAmount}
          onClick={() => {
            setError(null);
            capture.mutate();
          }}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {capture.isPending ? "Saving…" : "Record withholding"}
        </button>
        <button
          type="button"
          disabled={build.isPending}
          onClick={() => {
            setError(null);
            build.mutate();
          }}
          className="ml-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {build.isPending ? "Building…" : "Build QAP for this period"}
        </button>
        <button
          type="button"
          disabled={saveQap.isPending}
          onClick={() => {
            setError(null);
            saveQap.mutate();
          }}
          className="ml-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveQap.isPending ? "Saving…" : "Save QAP working return"}
        </button>
        <button
          type="button"
          disabled={remit.isPending}
          onClick={() => {
            setError(null);
            remit.mutate();
          }}
          className="ml-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {remit.isPending ? "Remitting…" : "Remit 0619-E / 1601-EQ"}
        </button>
        <button
          type="button"
          disabled={qapDat.isPending}
          onClick={() => {
            setError(null);
            qapDat.mutate();
          }}
          className="ml-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {qapDat.isPending ? "Encoding…" : "Download QAP .DAT"}
        </button>
      </div>
      {qap && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">
            QAP {periodStart} to {periodEnd}
          </h2>
          <p className="text-sm text-slate-600">
            Withheld {qap.qap.totalTaxWithheld} · payments {qap.qap.paymentCount} · unissued 2307s{" "}
            {qap.qap.certificatesNotIssued}
          </p>
          {qap.qap.blockingIssues.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-amber-800">
              {qap.qap.blockingIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <ul className="list-disc pl-5 text-sm text-slate-600">
            {qap.remittance.map((r) => (
              <li key={r.formCode}>
                {r.formCode}: {r.dueDate} ({r.note})
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-lg font-semibold">On file</h2>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(list.data ?? []).map((row) => (
            <li key={String(row.id)} className="flex items-start justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium text-slate-900">
                  {String(row.payeeRegisteredName)} · {String(row.atc)} · {String(row.taxWithheld)}
                </p>
                <p className="text-slate-600">
                  {String(row.periodStart)} to {String(row.periodEnd)} ·{" "}
                  {row.certificateIssued ? "2307 issued" : "2307 not issued"}
                </p>
              </div>
              <button
                type="button"
                disabled={issue.isPending}
                onClick={() => {
                  setError(null);
                  issue.mutate(String(row.id));
                }}
                className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-900 disabled:opacity-50"
              >
                {row.certificateIssued ? "Re-download 2307" : "Issue 2307"}
              </button>
            </li>
          ))}
          {(list.data ?? []).length === 0 && (
            <li className="p-3 text-sm text-slate-600">None recorded yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
