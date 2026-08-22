/** Reachable calculators for Stages 3b, 6 and 7. Working returns can be saved; nothing posts. */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { savePercentageTaxReturn, saveSlspReturn, saveVatReturn } from "./api/-tax-returns";
import { ATC_EXPECTED_RATE_BPS } from "../lib/tax/certificate-2307";
import { assessEwt, computeEwt, remittanceObligationsFor } from "../lib/tax/ewt";
import { buildVatReturn, extractVat } from "../lib/tax/vat";
import { assessRegime, computeEightPercent, monitorThreshold } from "../lib/tax/percentage-tax";

export const Route = createFileRoute("/tax/compute")({
  component: TaxComputePage,
});

function TaxComputePage() {
  const [gross, setGross] = useState("112000");
  const [vatInclusive, setVatInclusive] = useState(true);
  const [paymentType, setPaymentType] = useState("professional_fees");
  const [payeeType, setPayeeType] = useState<"individual" | "corporate">("corporate");
  const [isTopWithholdingAgent, setIsTopWithholdingAgent] = useState(true);
  const [hasSwornDeclaration, setHasSwornDeclaration] = useState(false);
  const [month, setMonth] = useState(1);
  const [yearReceipts, setYearReceipts] = useState("2500000");
  const [isIndividual, setIsIndividual] = useState(true);
  const [hasCompensationIncome, setHasCompensationIncome] = useState(false);
  const [electedEightPercent, setElectedEightPercent] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const ewt = useMemo(() => {
    const assessment = assessEwt({
      isTopWithholdingAgent,
      payeeType,
      paymentType,
      hasSwornDeclaration,
    });
    const vat = vatInclusive ? extractVat(gross, "vatable") : { vatAmount: "0", netAmount: gross };
    const rateBps =
      assessment.rateBps ?? (assessment.atc ? ATC_EXPECTED_RATE_BPS[assessment.atc] : null);
    const computation =
      assessment.required && assessment.atc && rateBps != null
        ? computeEwt({
            grossAmount: gross,
            vatAmount: vat.vatAmount,
            atc: assessment.atc,
            rateBps,
          })
        : null;
    return { assessment, computation, remittance: remittanceObligationsFor(month, 2026) };
  }, [
    gross,
    vatInclusive,
    paymentType,
    payeeType,
    isTopWithholdingAgent,
    hasSwornDeclaration,
    month,
  ]);

  const vat = useMemo(() => {
    const split = extractVat(gross, "vatable");
    const ret = buildVatReturn({
      quarter: 1,
      year: 2026,
      outputVat: split.vatAmount,
      creditableInputVat: "0",
    });
    return { split, ret };
  }, [gross]);

  const eight = useMemo(() => {
    const regime = assessRegime({
      grossReceipts: yearReceipts,
      isIndividual,
      hasCompensationIncome,
      isVatRegistered: false,
      electedEightPercent,
    });
    return {
      regime,
      eight: computeEightPercent({ grossReceipts: yearReceipts, hasCompensationIncome }),
      threshold: monitorThreshold(yearReceipts),
    };
  }, [yearReceipts, isIndividual, hasCompensationIncome, electedEightPercent]);

  const saveVat = useMutation({
    mutationFn: () =>
      (saveVatReturn as (o: { data: unknown }) => Promise<unknown>)({
        data: { quarter: 1, year: 2026, outputVat: vat.split.vatAmount, creditableInputVat: "0" },
      }),
    onSuccess: () => setSaved("2550Q saved"),
    onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)),
  });
  const savePct = useMutation({
    mutationFn: () =>
      (savePercentageTaxReturn as (o: { data: unknown }) => Promise<unknown>)({
        data: { quarter: 1, year: 2026, grossReceipts: yearReceipts, electedEightPercent },
      }),
    onSuccess: () => setSaved("2551Q saved"),
    onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)),
  });

  const saveSlsp = useMutation({
    mutationFn: () =>
      (saveSlspReturn as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          periodStart: vat.ret.periodStart,
          periodEnd: vat.ret.periodEnd,
          entries: [
            {
              tin: "234567890000",
              registeredName: "Reviewable SLSP line",
              netAmount: vat.split.netAmount,
              vatAmount: vat.split.vatAmount,
              treatment: "vatable",
            },
          ],
        },
      }),
    onSuccess: () => setSaved("SLSP saved"),
    onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Tax compute</h1>
        <p className="mt-1 text-sm text-slate-600">
          Stages 3b, 6 and 7 against the live engines. Saving a working return does not post a
          journal.
        </p>
      </header>
      {saveError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {saveError}
        </div>
      )}
      {saved && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {saved}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">EWT / 0619-E / 1601-EQ</h2>
        <div className="flex flex-wrap gap-3">
          <input
            value={gross}
            onChange={(e) => setGross(e.target.value)}
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
            onChange={(e) => setPayeeType(e.target.value as "individual" | "corporate")}
            className="rounded border border-slate-300 p-2 text-sm"
          >
            <option value="corporate">Corporate payee</option>
            <option value="individual">Individual payee</option>
          </select>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={vatInclusive}
              onChange={(e) => setVatInclusive(e.target.checked)}
            />{" "}
            VAT-inclusive
          </label>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={isTopWithholdingAgent}
              onChange={(e) => setIsTopWithholdingAgent(e.target.checked)}
            />{" "}
            Top withholding agent
          </label>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={hasSwornDeclaration}
              onChange={(e) => setHasSwornDeclaration(e.target.checked)}
            />{" "}
            Sworn declaration
          </label>
          <input
            type="number"
            min={1}
            max={12}
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="w-20 rounded border border-slate-300 p-2 text-sm"
          />
        </div>
        <p className="text-sm text-slate-700">{ewt.assessment.reason}</p>
        {ewt.computation ? (
          <p className="text-sm text-slate-700">
            ATC {ewt.computation.atc} · base {ewt.computation.taxBase} · withheld{" "}
            {ewt.computation.taxWithheld} · net payable {ewt.computation.netPayable}
          </p>
        ) : (
          <p className="text-sm text-slate-700">
            No withholding computed — the duty was not determined or not required.
          </p>
        )}
        <ul className="list-disc pl-5 text-sm text-slate-600">
          {ewt.remittance.map((r) => (
            <li key={r.formCode}>
              {r.formCode}: {r.dueDate} ({r.note})
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">VAT split / 2550Q</h2>
        <p className="text-sm text-slate-700">
          Net {vat.split.netAmount} · VAT {vat.split.vatAmount} · output {vat.ret.outputVat} ·
          payable {vat.ret.vatPayable} · due {vat.ret.dueDate}
        </p>
        <button
          type="button"
          disabled={saveVat.isPending}
          onClick={() => {
            setSaveError(null);
            setSaved(null);
            saveVat.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveVat.isPending ? "Saving…" : "Save 2550Q working return"}
        </button>
        <button
          type="button"
          disabled={saveSlsp.isPending}
          onClick={() => {
            setSaveError(null);
            setSaved(null);
            saveSlsp.mutate();
          }}
          className="ml-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveSlsp.isPending ? "Saving…" : "Save SLSP working return"}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">8% / threshold / 2551Q</h2>
        <div className="flex flex-wrap gap-3">
          <input
            value={yearReceipts}
            onChange={(e) => setYearReceipts(e.target.value)}
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <label className="text-sm">
            <input
              type="checkbox"
              checked={isIndividual}
              onChange={(e) => setIsIndividual(e.target.checked)}
            />{" "}
            Individual
          </label>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={hasCompensationIncome}
              onChange={(e) => setHasCompensationIncome(e.target.checked)}
            />{" "}
            Mixed income
          </label>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={electedEightPercent}
              onChange={(e) => setElectedEightPercent(e.target.checked)}
            />{" "}
            Elect 8%
          </label>
        </div>
        <p className="text-sm text-slate-700">
          Regime {eight.regime.regime ?? "none"} · 8% tax {eight.eight.taxDue} · utilization{" "}
          {eight.threshold.utilization.toFixed(2)}
        </p>
        <p className="text-sm text-slate-600">{eight.eight.deductionReason}</p>
        {eight.threshold.advisory && (
          <p className="text-sm text-amber-800">{eight.threshold.advisory}</p>
        )}
        <button
          type="button"
          disabled={savePct.isPending}
          onClick={() => {
            setSaveError(null);
            setSaved(null);
            savePct.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {savePct.isPending ? "Saving…" : "Save 2551Q working return"}
        </button>
      </section>
    </div>
  );
}
