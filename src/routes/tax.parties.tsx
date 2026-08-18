/** Payee tax profiles and dated org registrations. */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  addTaxRegistration,
  listPayeeTaxProfiles,
  listTaxRegistrations,
  upsertPayeeTaxProfile,
} from "./api/-tax-parties";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/tax/parties")({
  component: TaxPartiesPage,
});

function TaxPartiesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tin, setTin] = useState("");
  const [registeredName, setRegisteredName] = useState("");
  const [payeeType, setPayeeType] = useState("corporate");
  const [defaultAtc, setDefaultAtc] = useState("");
  const [swornYear, setSwornYear] = useState("");
  const [isVatRegistered, setIsVatRegistered] = useState(false);
  const [regimeKind, setRegimeKind] = useState("vat");
  const [regValue, setRegValue] = useState("registered");
  const [effectiveFrom, setEffectiveFrom] = useState("2026-01-01");

  const payees = useQuery({
    queryKey: [...keys.tax.all(), "payees"],
    queryFn: () => (listPayeeTaxProfiles as () => Promise<Array<Record<string, unknown>>>)(),
  });
  const regs = useQuery({
    queryKey: [...keys.tax.all(), "registrations"],
    queryFn: () => (listTaxRegistrations as () => Promise<Array<Record<string, unknown>>>)(),
  });

  const savePayee = useMutation({
    mutationFn: () =>
      (upsertPayeeTaxProfile as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          name,
          tin,
          registeredName,
          payeeType,
          defaultAtc: defaultAtc || undefined,
          swornDeclarationYear: swornYear || undefined,
          isVatRegistered,
        },
      }),
    onSuccess: () => {
      setName("");
      setTin("");
      setRegisteredName("");
      queryClient.invalidateQueries({ queryKey: keys.tax.all() });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const saveReg = useMutation({
    mutationFn: () =>
      (addTaxRegistration as (o: { data: unknown }) => Promise<unknown>)({
        data: { regimeKind, value: regValue, effectiveFrom },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tax.all() }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Tax parties</h1>
        <p className="mt-1 text-sm text-slate-600">
          Payee TINs, sworn-declaration years, and dated VAT/TWA facts. Registration is never a
          boolean on the org.
        </p>
      </header>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Payee profile</h2>
        <div className="grid max-w-xl grid-cols-2 gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={tin}
            onChange={(e) => setTin(e.target.value)}
            placeholder="TIN (9 digits)"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={registeredName}
            onChange={(e) => setRegisteredName(e.target.value)}
            placeholder="Registered name"
            className="col-span-2 rounded border border-slate-300 p-2 text-sm"
          />
          <select
            value={payeeType}
            onChange={(e) => setPayeeType(e.target.value)}
            className="rounded border border-slate-300 p-2 text-sm"
          >
            <option value="corporate">Corporate</option>
            <option value="individual">Individual</option>
          </select>
          <input
            value={defaultAtc}
            onChange={(e) => setDefaultAtc(e.target.value)}
            placeholder="Default ATC"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={swornYear}
            onChange={(e) => setSwornYear(e.target.value)}
            placeholder="Sworn declaration year"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <label className="text-sm">
            <input
              type="checkbox"
              checked={isVatRegistered}
              onChange={(e) => setIsVatRegistered(e.target.checked)}
            />{" "}
            VAT-registered payee
          </label>
        </div>
        <button
          type="button"
          disabled={savePayee.isPending || !name || !tin || !registeredName}
          onClick={() => {
            setError(null);
            savePayee.mutate();
          }}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {savePayee.isPending ? "Saving…" : "Save payee"}
        </button>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(payees.data ?? []).map((row) => (
            <li key={String(row.partyId)} className="p-3 text-sm">
              {String(row.registeredName ?? row.tin)} · {String(row.tin ?? "")} ·{" "}
              {String(row.payeeType ?? "")}{" "}
              {row.swornDeclarationYear ? `· sworn ${String(row.swornDeclarationYear)}` : ""}
            </li>
          ))}
          {(payees.data ?? []).length === 0 && (
            <li className="p-3 text-sm text-slate-600">No payee profiles yet.</li>
          )}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Dated registrations</h2>
        <div className="grid max-w-xl grid-cols-2 gap-3">
          <select
            value={regimeKind}
            onChange={(e) => setRegimeKind(e.target.value)}
            className="rounded border border-slate-300 p-2 text-sm"
          >
            <option value="vat">VAT</option>
            <option value="twa">Top withholding agent</option>
            <option value="percentage_tax">Percentage tax</option>
            <option value="eight_percent">8%</option>
          </select>
          <input
            value={regValue}
            onChange={(e) => setRegValue(e.target.value)}
            placeholder="Value"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="rounded border border-slate-300 p-2 text-sm"
          />
        </div>
        <button
          type="button"
          disabled={saveReg.isPending}
          onClick={() => {
            setError(null);
            saveReg.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveReg.isPending ? "Saving…" : "Add registration"}
        </button>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(regs.data ?? []).map((row) => (
            <li key={String(row.id)} className="p-3 text-sm">
              {String(row.regimeKind)} · {String(row.value)} · from {String(row.effectiveFrom)}
              {row.effectiveTo ? ` to ${String(row.effectiveTo)}` : ""}
            </li>
          ))}
          {(regs.data ?? []).length === 0 && (
            <li className="p-3 text-sm text-slate-600">No dated registrations yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
