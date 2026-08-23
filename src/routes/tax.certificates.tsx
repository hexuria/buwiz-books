/** Received 2307 capture, SAWT, CWT posting, and review-only OCR. */
import { createFileRoute } from "@tanstack/react-router";
import { PhTaxGate } from "../components/PhTaxGate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  buildReceived2307Sawt,
  captureReceived2307,
  listReceived2307s,
  postReceived2307Cwt,
} from "./api/-tax-certificates";
import { parseReceived2307Document } from "./api/-tax-ocr";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/tax/certificates")({
  component: TaxCertificatesPageGated,
});

type SawtResult = {
  totalIncomePayment: string;
  totalTaxWithheld: string;
  certificateCount: number;
  pendingCertificateCount: number;
  pendingTaxWithheld: string;
  blockingIssues: string[];
  lines: Array<{
    payorTin: string;
    payorRegisteredName: string;
    atc: string;
    incomePayment: string;
    taxWithheld: string;
    certificateCount: number;
  }>;
};

// D6 country gate: page body renders only per the PH module state
// (off → enable prompt, archived → read-only banner, active → as-is).
function TaxCertificatesPageGated() {
  return (
    <PhTaxGate>
      <TaxCertificatesPage />
    </PhTaxGate>
  );
}

function TaxCertificatesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [payorTin, setPayorTin] = useState("");
  const [payorName, setPayorName] = useState("");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [periodStart, setPeriodStart] = useState("2026-01-01");
  const [periodEnd, setPeriodEnd] = useState("2026-03-31");
  const [atc, setAtc] = useState("WC010");
  const [incomePayment, setIncomePayment] = useState("");
  const [taxWithheld, setTaxWithheld] = useState("");
  const [sawt, setSawt] = useState<SawtResult | null>(null);

  const list = useQuery({
    queryKey: keys.tax.certificates(),
    queryFn: () => (listReceived2307s as () => Promise<Array<Record<string, unknown>>>)(),
  });

  const sawtMut = useMutation({
    mutationFn: () =>
      (buildReceived2307Sawt as (o: { data: unknown }) => Promise<SawtResult>)({
        data: { periodStart, periodEnd },
      }),
    onSuccess: setSawt,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const capture = useMutation({
    mutationFn: () =>
      (
        captureReceived2307 as (o: {
          data: unknown;
        }) => Promise<{ warnings: Array<{ message: string }>; journalHeaderId: string | null }>
      )({
        data: {
          payorTin,
          payorRegisteredName: payorName,
          certificateNumber: certificateNumber || undefined,
          periodStart,
          periodEnd,
          atc,
          incomePayment,
          taxWithheld,
        },
      }),
    onSuccess: (result) => {
      setWarnings(result.warnings.map((w) => w.message));
      setPayorTin("");
      setPayorName("");
      setCertificateNumber("");
      setIncomePayment("");
      setTaxWithheld("");
      setSawt(null);
      queryClient.invalidateQueries({ queryKey: keys.tax.certificates() });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const postCwt = useMutation({
    mutationFn: (id: string) =>
      (postReceived2307Cwt as (o: { data: unknown }) => Promise<unknown>)({
        data: { certificateId: id },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tax.certificates() }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const ocr = useMutation({
    mutationFn: async (file: File) => {
      const base64Content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(new Error("Could not read the certificate file"));
        reader.readAsDataURL(file);
      });
      return (
        parseReceived2307Document as (o: { data: unknown }) => Promise<{
          needsReview: boolean;
          validationIssues: string[];
          parsed: null | {
            payorTin: string;
            payorRegisteredName: string;
            certificateNumber?: string;
            periodFrom: string;
            periodTo: string;
            lines: Array<{ atc: string; totalIncomePayment: string; taxWithheld: string }>;
          };
        }>
      )({ data: { base64Content, mimeType: file.type || "application/pdf" } });
    },
    onSuccess: (result) => {
      if (result.validationIssues.length > 0) setWarnings(result.validationIssues);
      if (!result.parsed) {
        setError("OCR could not extract a reviewable certificate.");
        return;
      }
      const line = result.parsed.lines[0];
      setPayorTin(result.parsed.payorTin);
      setPayorName(result.parsed.payorRegisteredName);
      setCertificateNumber(result.parsed.certificateNumber ?? "");
      if (result.parsed.periodFrom) setPeriodStart(result.parsed.periodFrom);
      if (result.parsed.periodTo) setPeriodEnd(result.parsed.periodTo);
      if (line) {
        setAtc(line.atc);
        setIncomePayment(line.totalIncomePayment);
        setTaxWithheld(line.taxWithheld);
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Received 2307s</h1>
        <p className="mt-1 text-sm text-slate-600">
          The paper is the only evidence the BIR accepts for CWT. OCR prefills the form for review;
          capture is still a human act.
        </p>
      </header>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 pl-8 text-sm text-amber-900">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <label className="block max-w-xl text-sm text-slate-700">
        Read a 2307 image or PDF
        <input
          type="file"
          accept="image/*,application/pdf"
          disabled={ocr.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setError(null);
            ocr.mutate(file);
          }}
          className="mt-1 block w-full text-sm"
        />
      </label>
      <section className="grid max-w-xl grid-cols-2 gap-3">
        <input
          value={payorTin}
          onChange={(e) => setPayorTin(e.target.value)}
          placeholder="Payor TIN"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={certificateNumber}
          onChange={(e) => setCertificateNumber(e.target.value)}
          placeholder="Certificate no. (optional)"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={payorName}
          onChange={(e) => setPayorName(e.target.value)}
          placeholder="Payor registered name"
          className="col-span-2 rounded border border-slate-300 p-2 text-sm"
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
        <input
          value={atc}
          onChange={(e) => setAtc(e.target.value)}
          placeholder="ATC"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={incomePayment}
          onChange={(e) => setIncomePayment(e.target.value)}
          placeholder="Income payment"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={taxWithheld}
          onChange={(e) => setTaxWithheld(e.target.value)}
          placeholder="Tax withheld"
          className="rounded border border-slate-300 p-2 text-sm"
        />
      </section>
      <div>
        <button
          type="button"
          disabled={capture.isPending || !payorTin || !payorName || !incomePayment || !taxWithheld}
          onClick={() => {
            setError(null);
            capture.mutate();
          }}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {capture.isPending ? "Saving…" : "Capture 2307"}
        </button>
        <button
          type="button"
          disabled={sawtMut.isPending}
          onClick={() => {
            setError(null);
            sawtMut.mutate();
          }}
          className="ml-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {sawtMut.isPending ? "Building…" : "Build SAWT for this period"}
        </button>
      </div>
      {sawt && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-900">
            SAWT {periodStart} to {periodEnd}
          </h2>
          <p className="text-sm text-slate-600">
            Income {sawt.totalIncomePayment} · withheld {sawt.totalTaxWithheld} · certificates{" "}
            {sawt.certificateCount} · pending {sawt.pendingCertificateCount}
            {sawt.pendingCertificateCount > 0 ? ` (${sawt.pendingTaxWithheld})` : ""}
          </p>
          {sawt.blockingIssues.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-amber-800">
              {sawt.blockingIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <ul className="divide-y divide-slate-200 rounded border border-slate-200">
            {sawt.lines.map((line) => (
              <li key={`${line.payorTin}-${line.atc}`} className="p-3 text-sm">
                {line.payorRegisteredName} · {line.atc} · {line.taxWithheld} (
                {line.certificateCount})
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-lg font-semibold text-slate-900">On file</h2>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(list.data ?? []).map((row) => (
            <li key={String(row.id)} className="flex items-start justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium text-slate-900">
                  {String(row.payorRegisteredName)} · {String(row.atc)} · {String(row.taxWithheld)}
                </p>
                <p className="text-slate-600">
                  {String(row.periodStart)} to {String(row.periodEnd)} ·{" "}
                  {String(row.certificateStatus)}
                  {row.journalHeaderId ? " · receivable posted" : " · receivable unposted"}
                </p>
              </div>
              {!row.journalHeaderId && String(row.taxWithheld) !== "0" && (
                <button
                  type="button"
                  disabled={postCwt.isPending}
                  onClick={() => {
                    setError(null);
                    postCwt.mutate(String(row.id));
                  }}
                  className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-900 disabled:opacity-50"
                >
                  Post CWT
                </button>
              )}
            </li>
          ))}
          {(list.data ?? []).length === 0 && (
            <li className="p-3 text-sm text-slate-600">None captured yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
