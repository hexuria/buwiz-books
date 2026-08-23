/**
 * Stage 4 deadline engine.
 *
 * Dates are data, not guesses. When the channel or eFPS group is unknown the
 * earliest applicable date is used — being early costs nothing, being late
 * costs a surcharge. Weekend/holiday roll-forward is deliberately omitted:
 * a hard-coded later date is the dangerous direction to be wrong in.
 *
 * Anchored to the 2025 BIR calendar (U11). A 2026 calendar, once located,
 * changes this catalog rather than callers.
 */
import { dueDateFor, type EfpsGroup, type FilingChannel } from "./form-1601c";
import { remittanceObligationsFor } from "./ewt";

export type DeadlineFormCode = "1601C" | "0619E" | "1601EQ" | "2550Q" | "2551Q" | "1604C" | "2316";

export interface DeadlineInput {
  year: number;
  filingChannel: FilingChannel;
  efpsGroup?: EfpsGroup | null;
  /**
   * Fiscal year-end month from /tax/settings (default 12 = calendar year).
   * VAT quarters follow the TAXPAYER'S adopted year: with a June year-end,
   * 2550Q quarters end in September, December, March, and June — the fixed
   * calendar quarters were wrong for every non-December filer.
   */
  fiscalYearEndMonth?: number;
  /** ISO date of an official override, e.g. RMC 30-2026. */
  overrides?: Partial<Record<DeadlineFormCode, string>>;
}

export interface DeadlineEntry {
  formCode: DeadlineFormCode;
  label: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  note: string;
  overridden: boolean;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function quarterDue(
  year: number,
  quarter: 1 | 2 | 3 | 4,
  fiscalYearEndMonth = 12,
): {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
} {
  // Quarter ends walk back from the fiscal year-end month in steps of three,
  // normalized into the calendar year being displayed. FYE 12 reproduces the
  // familiar Mar/Jun/Sep/Dec ends exactly.
  const endMonth = ((fiscalYearEndMonth - (4 - quarter) * 3 - 1 + 24) % 12) + 1;
  const startMonth = ((endMonth - 3 + 12) % 12) + 1;
  const startYear = startMonth > endMonth ? year - 1 : year;
  const periodStart = iso(startYear, startMonth, 1);
  const periodEnd = iso(year, endMonth, lastDayOfMonth(year, endMonth));
  const due = new Date(`${periodEnd}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 25);
  return { periodStart, periodEnd, dueDate: due.toISOString().slice(0, 10) };
}

export function buildDeadlineCalendar(input: DeadlineInput): DeadlineEntry[] {
  const entries: DeadlineEntry[] = [];
  const channel = input.filingChannel;
  const group = input.efpsGroup ?? undefined;

  for (let month = 1; month <= 12; month += 1) {
    const { dueDate, usesDecemberException } = dueDateFor(month, input.year, channel, group);
    entries.push({
      formCode: "1601C",
      label: "1601-C monthly withholding on compensation",
      periodStart: iso(input.year, month, 1),
      periodEnd: iso(input.year, month, lastDayOfMonth(input.year, month)),
      dueDate,
      note: usesDecemberException
        ? "December exception: due 15 January regardless of channel or group."
        : channel === "efps" && !group
          ? "eFPS group unset — earliest group date (E) is shown."
          : "Monthly remittance of tax withheld from employees.",
      overridden: false,
    });

    for (const obligation of remittanceObligationsFor(month, input.year)) {
      entries.push({
        formCode: obligation.formCode,
        label:
          obligation.formCode === "0619E"
            ? "0619-E monthly expanded withholding"
            : "1601-EQ quarterly expanded withholding",
        periodStart: obligation.periodStart,
        periodEnd: obligation.periodEnd,
        dueDate: obligation.dueDate,
        note: obligation.note,
        overridden: false,
      });
    }
  }

  for (const quarter of [1, 2, 3, 4] as const) {
    const q = quarterDue(input.year, quarter, input.fiscalYearEndMonth ?? 12);
    entries.push({
      formCode: "2550Q",
      label: "2550Q quarterly VAT",
      ...q,
      note: "Due within 25 days after quarter close. Monthly 2550M no longer exists under EOPT.",
      overridden: false,
    });
    entries.push({
      formCode: "2551Q",
      label: "2551Q quarterly percentage tax",
      ...q,
      note: "Same 25-day window as 2550Q. Do not file if the 8% option was elected.",
      overridden: false,
    });
  }

  entries.push({
    formCode: "1604C",
    label: "1604-C annual alphalist",
    periodStart: iso(input.year, 1, 1),
    periodEnd: iso(input.year, 12, 31),
    dueDate: iso(input.year + 1, 1, 31),
    note: "Annual information return. Schedule 2 stays untranscribed until the layouts are complete.",
    overridden: false,
  });
  entries.push({
    formCode: "2316",
    label: "2316 certificates of compensation",
    periodStart: iso(input.year, 1, 1),
    periodEnd: iso(input.year, 12, 31),
    dueDate: iso(input.year + 1, 1, 31),
    note: "Furnish every employee a 2316 by 31 January. Failure is a ground for mandatory audit.",
    overridden: false,
  });

  return entries
    .map((entry) => {
      const override = input.overrides?.[entry.formCode];
      if (!override) return entry;
      return {
        ...entry,
        dueDate: override,
        overridden: true,
        note: `${entry.note} Official override applied.`,
      };
    })
    .sort((a, b) =>
      a.dueDate === b.dueDate
        ? a.formCode.localeCompare(b.formCode)
        : a.dueDate.localeCompare(b.dueDate),
    );
}
