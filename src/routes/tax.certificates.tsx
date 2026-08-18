/** Received 2307 capture — paper in hand, credit at risk until it is. */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { captureReceived2307, listReceived2307s } from "./api/-tax-certificates";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/tax/certificates")({
  component: TaxCertificatesPage,
});

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

  const list = useQuery({
    queryKey: [...keys.filing.all(), "certificates"],
    queryFn: () => (listReceived2307s as () => Promise<Array<Record<string, unknown>>>)(),
  });

  const capture = useMutation({
    mutationFn: () =>
      (
        captureReceived2307 as (o: {
          data: unknown;
        }) => Promise<{ warnings: Array<{ message: string }> }>
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
      queryClient.invalidateQueries({ queryKey: keys.filing.all() });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Received 2307s</h1>
        <p className="mt-1 text-sm text-slate-600">
          The paper is the only evidence the BIR accepts for CWT. Capture it here; the ledger
          receivable is a separate fact.
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
      <section>
        <h2 className="mb-2 text-lg font-semibold text-slate-900">On file</h2>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(list.data ?? []).map((row) => (
            <li key={String(row.id)} className="p-3 text-sm">
              <p className="font-medium text-slate-900">
                {String(row.payorRegisteredName)} · {String(row.atc)} · {String(row.taxWithheld)}
              </p>
              <p className="text-slate-600">
                {String(row.periodStart)} to {String(row.periodEnd)} ·{" "}
                {String(row.certificateStatus)}
              </p>
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
