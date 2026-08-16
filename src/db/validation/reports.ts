import { z } from "zod";

// ─── Basis ───────────────────────────────────────────────────
export const accountingBasisEnum = z.enum(["accrual", "cash"]);
export type AccountingBasis = z.infer<typeof accountingBasisEnum>;

// ─── Comparison Mode ─────────────────────────────────────────
export const comparisonModeEnum = z.enum(["none", "prior_period"]);
export type ComparisonMode = z.infer<typeof comparisonModeEnum>;

// ─── Report Period ───────────────────────────────────────────
export const reportPeriodSchema = z.object({
  dateFrom: z.string().min(1, "dateFrom is required"), // ISO date string
  dateTo: z.string().min(1, "dateTo is required"),
  basis: accountingBasisEnum.default("accrual"),
  compare: comparisonModeEnum.default("none"),
});
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

// Enterprise portfolio reports are exposed through a cross-organization query
// boundary, so reject impossible calendar dates before authorization or SQL.
export const portfolioProfitLossSchema = z
  .object({
    enterpriseAccountId: z.string().uuid(),
    groupIds: z.array(z.string().uuid()).min(1).max(50),
    dateFrom: z.iso.date(),
    dateTo: z.iso.date(),
    compare: comparisonModeEnum.default("none"),
  })
  .refine((value) => value.dateFrom <= value.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateTo"],
  });
export type PortfolioProfitLossParams = z.infer<typeof portfolioProfitLossSchema>;

// ─── Balance Sheet (point-in-time snapshot) ──────────────────
export const balanceSheetSchema = z.object({
  asOf: z.string().min(1, "asOf date is required"),
  basis: accountingBasisEnum.default("accrual"),
  compare: comparisonModeEnum.default("none"),
});
export type BalanceSheetParams = z.infer<typeof balanceSheetSchema>;

// ─── Aging Report ────────────────────────────────────────────
export const agingTypeEnum = z.enum(["ap", "ar"]);
export type AgingType = z.infer<typeof agingTypeEnum>;

export const agingSchema = z.object({
  asOf: z.string().min(1, "asOf date is required"),
  type: agingTypeEnum.default("ap"),
  buckets: z.array(z.number().int().positive()).default([30, 60, 90]),
});
export type AgingParams = z.infer<typeof agingSchema>;

// ─── Report Tab ──────────────────────────────────────────────
export const reportTabEnum = z.enum([
  "profit-loss",
  "balance-sheet",
  "cash-flow",
  "trial-balance",
  "aging",
]);
export type ReportTab = z.infer<typeof reportTabEnum>;

// ─── URL Search Params (for the route validateSearch) ────────
export const financialsSearchSchema = z.object({
  tab: reportTabEnum.default("profit-loss"),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM")
    .optional(),
  compare: comparisonModeEnum.default("none"),
  agingType: agingTypeEnum.default("ap"),
});
export type FinancialsSearch = z.infer<typeof financialsSearchSchema>;
