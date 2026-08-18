/** Period-index helpers for creating a payroll run. */

export type PayrollPeriodKind = "daily" | "weekly" | "semi_monthly" | "monthly" | "annual";

export function periodIndexFromDates(period: PayrollPeriodKind, periodEnd: string): number {
  const date = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid period end ${periodEnd}`);
  }
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  switch (period) {
    case "monthly":
    case "annual":
      return month;
    case "semi_monthly":
      return (month - 1) * 2 + (day <= 15 ? 1 : 2);
    case "weekly": {
      const start = Date.UTC(date.getUTCFullYear(), 0, 1);
      return Math.floor((date.getTime() - start) / (7 * 24 * 60 * 60 * 1000)) + 1;
    }
    case "daily": {
      const start = Date.UTC(date.getUTCFullYear(), 0, 1);
      return Math.floor((date.getTime() - start) / (24 * 60 * 60 * 1000)) + 1;
    }
  }
}

export function isAnnualizationPeriod(period: PayrollPeriodKind, periodEnd: string): boolean {
  return period === "annual" || periodEnd.endsWith("-12-31");
}
