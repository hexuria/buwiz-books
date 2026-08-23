/** Org-level tax identity: eFPS, fiscal year, classification, branches, year elections. */
import { createFileRoute } from "@tanstack/react-router";
import { PhTaxGate } from "../components/PhTaxGate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getTaxSettings,
  upsertTaxBranch,
  upsertTaxSettings,
  upsertTaxYearElection,
} from "./api/-tax-settings";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/tax/settings")({
  component: TaxSettingsPageGated,
});

type TaxSettings = {
  profile: {
    tin: string | null;
    branchCode: string | null;
    rdoCode: string | null;
    registeredName: string | null;
    taxpayerClassification: "micro" | "small" | "medium" | "large" | null;
    efpsEnrolled: boolean;
    efpsIndustryGroup: "A" | "B" | "C" | "D" | "E" | null;
    fiscalYearEndMonth: number;
    isNga: boolean;
  };
  branches: Array<{
    id: string;
    branchCode: string;
    name: string | null;
    rdoCode: string | null;
    isWithholdingAgent: boolean;
  }>;
  elections: Array<{
    taxableYear: number;
    regime: "vat" | "percentage_tax" | "eight_percent";
    hasCompensationIncome: boolean;
    irrevocable: boolean;
  }>;
};

// D6 country gate: page body renders only per the PH module state
// (off → enable prompt, archived → read-only banner, active → as-is).
function TaxSettingsPageGated() {
  return (
    <PhTaxGate>
      <TaxSettingsPage />
    </PhTaxGate>
  );
}

function TaxSettingsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [tin, setTin] = useState("");
  const [registeredName, setRegisteredName] = useState("");
  const [branchCode, setBranchCode] = useState("00000");
  const [rdoCode, setRdoCode] = useState("");
  const [classification, setClassification] = useState("");
  const [efpsEnrolled, setEfpsEnrolled] = useState(false);
  const [efpsGroup, setEfpsGroup] = useState("");
  const [fiscalYearEndMonth, setFiscalYearEndMonth] = useState(12);
  const [branchName, setBranchName] = useState("");
  const [newBranchCode, setNewBranchCode] = useState("");
  const [branchRdo, setBranchRdo] = useState("");
  const [branchIsAgent, setBranchIsAgent] = useState(false);
  const [taxableYear, setTaxableYear] = useState(2026);
  const [regime, setRegime] = useState("percentage_tax");
  const [hasCompensationIncome, setHasCompensationIncome] = useState(false);
  const [taxpayerKind, setTaxpayerKind] = useState<"individual" | "corporation">("individual");

  const settings = useQuery({
    queryKey: keys.tax.settings(),
    queryFn: () => (getTaxSettings as () => Promise<TaxSettings>)(),
  });

  useEffect(() => {
    const profile = settings.data?.profile;
    if (!profile) return;
    if (profile.tin) setTin(profile.tin);
    if (profile.registeredName) setRegisteredName(profile.registeredName);
    if (profile.branchCode) setBranchCode(profile.branchCode);
    if (profile.rdoCode) setRdoCode(profile.rdoCode);
    if (profile.taxpayerClassification) setClassification(profile.taxpayerClassification);
    setEfpsEnrolled(profile.efpsEnrolled);
    setEfpsGroup(profile.efpsIndustryGroup ?? "");
    setFiscalYearEndMonth(profile.fiscalYearEndMonth);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      (upsertTaxSettings as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          tin: tin || undefined,
          registeredName: registeredName || undefined,
          branchCode,
          rdoCode: rdoCode || undefined,
          taxpayerClassification: classification || undefined,
          efpsEnrolled,
          efpsIndustryGroup: efpsGroup || null,
          fiscalYearEndMonth,
          isNga: false,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tax.settings() }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const saveBranch = useMutation({
    mutationFn: () =>
      (upsertTaxBranch as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          branchCode: newBranchCode,
          name: branchName,
          rdoCode: branchRdo || undefined,
          isWithholdingAgent: branchIsAgent,
        },
      }),
    onSuccess: () => {
      setNewBranchCode("");
      setBranchName("");
      setBranchRdo("");
      setBranchIsAgent(false);
      queryClient.invalidateQueries({ queryKey: keys.tax.settings() });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const saveElection = useMutation({
    mutationFn: () =>
      (upsertTaxYearElection as (o: { data: unknown }) => Promise<unknown>)({
        data: {
          taxableYear,
          regime:
            taxpayerKind === "corporation" && regime === "eight_percent"
              ? "percentage_tax"
              : regime,
          hasCompensationIncome,
          taxpayerKind,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tax.settings() }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Tax settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          1601-C uses the earliest eFPS date when the group is unknown. Set it here so deadlines and
          filings stop guessing.
        </p>
      </header>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      <section className="grid max-w-xl grid-cols-2 gap-3">
        <input
          value={tin}
          onChange={(e) => setTin(e.target.value)}
          placeholder="TIN (9 digits)"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={branchCode}
          onChange={(e) => setBranchCode(e.target.value)}
          placeholder="Head-office branch"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={registeredName}
          onChange={(e) => setRegisteredName(e.target.value)}
          placeholder="Registered name"
          className="col-span-2 rounded border border-slate-300 p-2 text-sm"
        />
        <input
          value={rdoCode}
          onChange={(e) => setRdoCode(e.target.value)}
          placeholder="RDO"
          className="rounded border border-slate-300 p-2 text-sm"
        />
        <select
          value={classification}
          onChange={(e) => setClassification(e.target.value)}
          className="rounded border border-slate-300 p-2 text-sm"
        >
          <option value="">Classification</option>
          <option value="micro">Micro</option>
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
        </select>
        <label className="text-sm">
          <input
            type="checkbox"
            checked={efpsEnrolled}
            onChange={(e) => setEfpsEnrolled(e.target.checked)}
          />{" "}
          eFPS enrolled
        </label>
        <select
          value={efpsGroup}
          onChange={(e) => setEfpsGroup(e.target.value)}
          className="rounded border border-slate-300 p-2 text-sm"
        >
          <option value="">eFPS group</option>
          <option value="A">A (15th)</option>
          <option value="B">B (14th)</option>
          <option value="C">C (13th)</option>
          <option value="D">D (12th)</option>
          <option value="E">E (11th)</option>
        </select>
        <label className="text-sm">
          Fiscal year ends
          <input
            type="number"
            min={1}
            max={12}
            value={fiscalYearEndMonth}
            onChange={(e) => setFiscalYearEndMonth(Number(e.target.value))}
            className="mt-1 block rounded border border-slate-300 p-2 text-sm"
          />
        </label>
      </section>
      <button
        type="button"
        disabled={save.isPending}
        onClick={() => {
          setError(null);
          save.mutate();
        }}
        className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {save.isPending ? "Saving…" : "Save tax settings"}
      </button>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Year election</h2>
        <p className="text-sm text-slate-600">
          The 8% option is irrevocable for the year. A corporation cannot hold it.
        </p>
        <div className="grid max-w-xl grid-cols-2 gap-3">
          <input
            type="number"
            value={taxableYear}
            onChange={(e) => setTaxableYear(Number(e.target.value))}
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <select
            value={regime}
            onChange={(e) => setRegime(e.target.value)}
            className="rounded border border-slate-300 p-2 text-sm"
          >
            <option value="percentage_tax">Percentage tax</option>
            <option value="eight_percent">8%</option>
            <option value="vat">VAT</option>
          </select>
          <select
            value={taxpayerKind}
            onChange={(e) => setTaxpayerKind(e.target.value as "individual" | "corporation")}
            className="rounded border border-slate-300 p-2 text-sm"
          >
            <option value="individual">Individual / professional</option>
            <option value="corporation">Corporation</option>
          </select>
          <label className="text-sm col-span-2">
            <input
              type="checkbox"
              checked={hasCompensationIncome}
              onChange={(e) => setHasCompensationIncome(e.target.checked)}
            />{" "}
            Mixed income (no ₱250,000 deduction on 8%)
          </label>
        </div>
        <button
          type="button"
          disabled={
            saveElection.isPending || (taxpayerKind === "corporation" && regime === "eight_percent")
          }
          onClick={() => {
            setError(null);
            saveElection.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveElection.isPending ? "Saving…" : "Save year election"}
        </button>
        {taxpayerKind === "corporation" && regime === "eight_percent" && (
          <p className="text-sm text-amber-800">
            A corporation cannot hold the 8% option. Choose percentage tax or VAT.
          </p>
        )}
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(settings.data?.elections ?? []).map((election) => (
            <li key={election.taxableYear} className="p-3 text-sm">
              {election.taxableYear} · {election.regime}
              {election.hasCompensationIncome ? " · mixed income" : ""}
              {election.irrevocable ? " · irrevocable" : ""}
            </li>
          ))}
          {(settings.data?.elections ?? []).length === 0 && (
            <li className="p-3 text-sm text-slate-600">No year election recorded yet.</li>
          )}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Registered branches</h2>
        <p className="text-sm text-slate-600">
          Stored now. v1 still computes head-office consolidated; per-branch splitting is post-v1.
        </p>
        <div className="grid max-w-xl grid-cols-2 gap-3">
          <input
            value={newBranchCode}
            onChange={(e) => setNewBranchCode(e.target.value)}
            placeholder="Branch code (5 digits)"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="Branch name"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={branchRdo}
            onChange={(e) => setBranchRdo(e.target.value)}
            placeholder="RDO"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <label className="text-sm">
            <input
              type="checkbox"
              checked={branchIsAgent}
              onChange={(e) => setBranchIsAgent(e.target.checked)}
            />{" "}
            Withholding agent
          </label>
        </div>
        <button
          type="button"
          disabled={saveBranch.isPending || !newBranchCode || !branchName}
          onClick={() => {
            setError(null);
            saveBranch.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveBranch.isPending ? "Saving…" : "Add / update branch"}
        </button>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {(settings.data?.branches ?? []).map((branch) => (
            <li key={branch.id} className="p-3 text-sm">
              {branch.branchCode} · {branch.name} ·{" "}
              {branch.isWithholdingAgent ? "withholding agent" : "not an agent"}
            </li>
          ))}
          {(settings.data?.branches ?? []).length === 0 && (
            <li className="p-3 text-sm text-slate-600">No branches recorded yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
