/**
 * Payroll filing index — create a period, add a TIN profile, open a run.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  createPayrollRun,
  getOrgTaxProfile,
  listPayrollRuns,
  upsertEmployeeTaxProfile,
  upsertOrgTaxProfile,
} from "./api/-payroll-runs";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/payroll")({
  component: PayrollIndexPage,
});

function PayrollIndexPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState("2026-01-01");
  const [periodEnd, setPeriodEnd] = useState("2026-01-31");
  const [name, setName] = useState("");
  const [tin, setTin] = useState("");
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [dateHired, setDateHired] = useState("2026-01-01");
  const [orgTin, setOrgTin] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgBranch, setOrgBranch] = useState("00000");

  const orgProfile = useQuery({
    queryKey: [...keys.payroll.all(), "org-profile"],
    queryFn: () =>
      (
        getOrgTaxProfile as () => Promise<{
          tin: string | null;
          registeredName: string | null;
          branchCode: string | null;
        }>
      )(),
  });

  const runs = useQuery({
    queryKey: keys.payroll.all(),
    queryFn: () => (listPayrollRuns as () => Promise<Array<Record<string, unknown>>>)(),
  });

  useEffect(() => {
    if (!orgProfile.data) return;
    if (!orgTin && orgProfile.data.tin) setOrgTin(orgProfile.data.tin);
    if (!orgName && orgProfile.data.registeredName) setOrgName(orgProfile.data.registeredName);
    if (orgBranch === "00000" && orgProfile.data.branchCode)
      setOrgBranch(orgProfile.data.branchCode);
  }, [orgProfile.data, orgTin, orgName, orgBranch]);

  const create = useMutation({
    mutationFn: () =>
      (createPayrollRun as (o: { data: unknown }) => Promise<{ id: string }>)({
        data: {
          taxableYear: Number(periodStart.slice(0, 4)),
          payrollPeriod: "monthly",
          periodStart,
          periodEnd,
        },
      }),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: keys.payroll.all() });
      await navigate({ to: "/payroll/$runId", params: { runId: run.id } });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const saveOrg = useMutation({
    mutationFn: () =>
      (upsertOrgTaxProfile as (o: { data: unknown }) => Promise<unknown>)({
        data: { tin: orgTin, registeredName: orgName, branchCode: orgBranch },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.payroll.all() }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const profile = useMutation({
    mutationFn: () =>
      (upsertEmployeeTaxProfile as (o: { data: unknown }) => Promise<unknown>)({
        data: { name, tin, lastName, firstName, dateHired },
      }),
    onSuccess: () => {
      setName("");
      setTin("");
      setLastName("");
      setFirstName("");
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Payroll filing</h1>
        <p className="mt-1 text-sm text-slate-600">
          Create a period, record employee TINs, then import the register on the run page.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">New monthly period</h2>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            Start
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="mt-1 block rounded border border-slate-300 p-2"
            />
          </label>
          <label className="text-sm">
            End
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="mt-1 block rounded border border-slate-300 p-2"
            />
          </label>
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
            className="self-end rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create run"}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Employer identity</h2>
        <p className="text-sm text-slate-600">
          2316 prints this TIN and registered name. A missing employer block is a defect at issue
          time.
        </p>
        <div className="grid max-w-xl grid-cols-2 gap-3">
          <input
            value={orgTin}
            onChange={(e) => setOrgTin(e.target.value)}
            placeholder="Employer TIN (9 digits)"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={orgBranch}
            onChange={(e) => setOrgBranch(e.target.value)}
            placeholder="Branch code"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Registered name"
            className="col-span-2 rounded border border-slate-300 p-2 text-sm"
          />
        </div>
        <button
          type="button"
          disabled={saveOrg.isPending || !orgTin || !orgName}
          onClick={() => {
            setError(null);
            saveOrg.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {saveOrg.isPending ? "Saving…" : "Save employer identity"}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Employee TIN profile</h2>
        <p className="text-sm text-slate-600">
          Import matches by this nine-digit TIN. A register row with no profile is refused.
        </p>
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
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
            className="rounded border border-slate-300 p-2 text-sm"
          />
          <input
            type="date"
            value={dateHired}
            onChange={(e) => setDateHired(e.target.value)}
            className="rounded border border-slate-300 p-2 text-sm"
          />
        </div>
        <button
          type="button"
          disabled={profile.isPending || !name || !tin || !lastName || !firstName}
          onClick={() => {
            setError(null);
            profile.mutate();
          }}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          {profile.isPending ? "Saving…" : "Save employee TIN"}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Periods</h2>
        {runs.isLoading ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200">
            {(runs.data ?? []).map((run) => (
              <li key={String(run.id)} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <p className="font-medium text-slate-900">
                    {String(run.periodStart)} to {String(run.periodEnd)}
                  </p>
                  <p className="text-slate-600">{String(run.status)}</p>
                </div>
                <Link
                  to="/payroll/$runId"
                  params={{ runId: String(run.id) }}
                  className="text-slate-900 underline"
                >
                  Open
                </Link>
              </li>
            ))}
            {(runs.data ?? []).length === 0 && (
              <li className="p-3 text-sm text-slate-600">No periods yet.</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
