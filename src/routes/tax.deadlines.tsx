/** Filing calendar from the Stage 4 deadline engine. */
import { createFileRoute } from "@tanstack/react-router";
import { PhTaxGate } from "../components/PhTaxGate";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getTaxSettings, listDeadlineOverrides } from "./api/-tax-settings";
import { buildDeadlineCalendar, type DeadlineEntry } from "../lib/tax/deadlines";
import { keys } from "../lib/query-keys";

export const Route = createFileRoute("/tax/deadlines")({
  component: TaxDeadlinesPageGated,
});

// D6 country gate: page body renders only per the PH module state
// (off → enable prompt, archived → read-only banner, active → as-is).
function TaxDeadlinesPageGated() {
  return (
    <PhTaxGate>
      <TaxDeadlinesPage />
    </PhTaxGate>
  );
}

function TaxDeadlinesPage() {
  const [year, setYear] = useState(2026);
  const settings = useQuery({
    queryKey: keys.tax.settings(),
    queryFn: () =>
      (
        getTaxSettings as () => Promise<{
          profile: {
            efpsEnrolled: boolean;
            efpsIndustryGroup: "A" | "B" | "C" | "D" | "E" | null;
            fiscalYearEndMonth: number;
          };
        }>
      )(),
  });
  const overrides = useQuery({
    queryKey: [...keys.tax.deadlines(year), "overrides"],
    queryFn: () =>
      (listDeadlineOverrides as () => Promise<Array<{ formCode: string; dueDate: string }>>)(),
  });

  const calendar = useMemo(() => {
    const profile = settings.data?.profile;
    const mapped = Object.fromEntries(
      (overrides.data ?? []).map((row) => [row.formCode, row.dueDate]),
    ) as Partial<Record<DeadlineEntry["formCode"], string>>;
    return buildDeadlineCalendar({
      year,
      filingChannel: profile?.efpsEnrolled ? "efps" : "ebirforms",
      efpsGroup: profile?.efpsIndustryGroup ?? undefined,
      fiscalYearEndMonth: profile?.fiscalYearEndMonth ?? 12,
      overrides: mapped,
    });
  }, [settings.data, overrides.data, year]);

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Filing deadlines</h1>
        <p className="mt-1 text-sm text-slate-600">
          Anchored to the 2025 BIR calendar (U11). Weekend/holiday roll-forward is omitted on
          purpose — a later date is the dangerous guess.
        </p>
      </header>
      <label className="text-sm">
        Year
        <input
          type="number"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="ml-2 rounded border border-slate-300 p-2 text-sm"
        />
      </label>
      <ul className="divide-y divide-slate-200 rounded border border-slate-200">
        {calendar.map((entry: DeadlineEntry) => (
          <li
            key={`${entry.formCode}-${entry.periodStart}-${entry.dueDate}`}
            className="p-3 text-sm"
          >
            <p className="font-medium text-slate-900">
              {entry.label} · due {entry.dueDate}
              {entry.overridden ? " · override" : ""}
            </p>
            <p className="text-slate-600">
              {entry.periodStart} to {entry.periodEnd} · {entry.note}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
