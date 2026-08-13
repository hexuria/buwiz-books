import { sql } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { buildProfitLoss, type ReportRow } from "@/lib/report-calculations";
import { moneyToCents } from "@/lib/money";
import { getPriorPeriodRange } from "@/lib/report-utils";
import { getReportingProjectionStates } from "@/lib/reporting/projection";
import type { ProjectionStateView } from "@/lib/reporting/projection-types";
import { aggregateBalances } from "@/services/reports";
import type { BusinessGroupPerformanceAccess } from "./performance-model";
import {
  buildPortfolioProfitLossMetadata,
  buildPortfolioReportScope,
  combinePortfolioReportRows,
  summarizeProjectionReadiness,
  type PortfolioProfitLossResult,
} from "./portfolio-profit-loss-model";

export * from "./portfolio-profit-loss-model";

interface ProjectedPortfolioBalanceRow {
  organizationId: string;
  accountId: string;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
  parentId: string | null;
  currentDebit: string;
  currentCredit: string;
  priorDebit: string;
  priorCredit: string;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = Array.from({ length: values.length }) as U[];
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

export async function computeLivePortfolioProfitLoss(
  groups: BusinessGroupPerformanceAccess[],
  input: {
    userId: string;
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    warnings?: string[];
  },
): Promise<PortfolioProfitLossResult> {
  const scope = buildPortfolioReportScope(groups);
  const resultMetadata = buildPortfolioProfitLossMetadata(
    scope,
    { ...input, sourceMode: "live_ledger" },
    {
      warnings: input.warnings,
    },
  );

  if (scope.organizations.length === 0 || !scope.currency) {
    return { report: null, metadata: resultMetadata };
  }

  const priorRange =
    input.compare === "prior_period" ? getPriorPeriodRange(input.dateFrom, input.dateTo) : null;
  const rows = await mapWithConcurrency(scope.organizations, 6, (organization) =>
    withOrgContext(
      organization.organizationId,
      input.userId,
      organization.role,
      async (executor) => {
        const [current, prior] = await Promise.all([
          aggregateBalances(organization.organizationId, input.dateFrom, input.dateTo, executor),
          priorRange
            ? aggregateBalances(
                organization.organizationId,
                priorRange.start,
                priorRange.end,
                executor,
              )
            : Promise.resolve([]),
        ]);
        return { current, prior };
      },
    ),
  );

  return {
    report: buildProfitLoss(
      combinePortfolioReportRows(rows.flatMap((row) => row.current)),
      input.dateFrom,
      input.dateTo,
      input.compare,
      combinePortfolioReportRows(rows.flatMap((row) => row.prior)),
    ),
    metadata: resultMetadata,
  };
}

async function loadProjectedPortfolioBalances(
  tx: DbExecutor,
  input: {
    organizationIds: readonly string[];
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
  },
): Promise<ProjectedPortfolioBalanceRow[]> {
  if (input.organizationIds.length === 0) return [];
  const prior = getPriorPeriodRange(input.dateFrom, input.dateTo);
  const lowerDate = input.compare === "prior_period" ? prior.start : input.dateFrom;
  const result = await tx.execute(sql`
    select
      activity.organization_id as "organizationId",
      activity.account_id as "accountId",
      account.account_name as "accountName",
      account.account_number as "accountNumber",
      account.account_type as "accountType",
      account.subtype,
      account.parent_id as "parentId",
      coalesce(sum(activity.total_debit) filter (
        where activity.activity_date between ${input.dateFrom}::date and ${input.dateTo}::date
      ), 0)::text as "currentDebit",
      coalesce(sum(activity.total_credit) filter (
        where activity.activity_date between ${input.dateFrom}::date and ${input.dateTo}::date
      ), 0)::text as "currentCredit",
      coalesce(sum(activity.total_debit) filter (
        where ${input.compare === "prior_period"}
          and activity.activity_date between ${prior.start}::date and ${prior.end}::date
      ), 0)::text as "priorDebit",
      coalesce(sum(activity.total_credit) filter (
        where ${input.compare === "prior_period"}
          and activity.activity_date between ${prior.start}::date and ${prior.end}::date
      ), 0)::text as "priorCredit"
    from organization_daily_account_activity activity
    join organization_reporting_accounts account
      on account.organization_id = activity.organization_id
     and account.account_id = activity.account_id
    where activity.organization_id in (${sql.join(
      input.organizationIds.map((organizationId) => sql`${organizationId}`),
      sql`, `,
    )})
      and activity.activity_date between ${lowerDate}::date and ${input.dateTo}::date
      and account.account_type in (
        'revenue', 'cost_of_revenue', 'expense', 'other_income', 'other_expense'
      )
    group by
      activity.organization_id,
      activity.account_id,
      account.account_name,
      account.account_number,
      account.account_type,
      account.subtype,
      account.parent_id
  `);
  return result as unknown as ProjectedPortfolioBalanceRow[];
}

function hasActivity(debit: string, credit: string): boolean {
  return moneyToCents(debit) !== 0 || moneyToCents(credit) !== 0;
}

function projectedReportRow(
  row: ProjectedPortfolioBalanceRow,
  totalDebit: string,
  totalCredit: string,
): ReportRow {
  return {
    accountId: row.accountId,
    accountName: row.accountName,
    accountNumber: row.accountNumber,
    accountType: row.accountType,
    subtype: row.subtype,
    parentId: row.parentId,
    totalDebit,
    totalCredit,
  };
}

export async function computeProjectedPortfolioProfitLoss(
  tx: DbExecutor,
  groups: BusinessGroupPerformanceAccess[],
  input: {
    dateFrom: string;
    dateTo: string;
    compare: "none" | "prior_period";
    projectionStates?: ReadonlyMap<string, ProjectionStateView>;
  },
): Promise<PortfolioProfitLossResult> {
  const scope = buildPortfolioReportScope(groups);
  const organizationIds = scope.organizations.map((organization) => organization.organizationId);
  const states =
    input.projectionStates ?? (await getReportingProjectionStates(tx, organizationIds));
  const readiness = summarizeProjectionReadiness(organizationIds, states);
  const readinessWarnings =
    readiness.incompleteEntityCount === 0
      ? []
      : [
          readiness.projectionStatus === "failed"
            ? "Projected financial data could not be refreshed. The statement is withheld."
            : "Projected financial data is not current for every included business. The statement is withheld until the portfolio is ready.",
        ];
  const resultMetadata = buildPortfolioProfitLossMetadata(
    scope,
    { ...input, sourceMode: "projected" },
    { ...readiness, warnings: readinessWarnings },
  );

  if (scope.organizations.length === 0 || !scope.currency || readiness.incompleteEntityCount > 0) {
    return { report: null, metadata: resultMetadata };
  }

  const rows = await loadProjectedPortfolioBalances(tx, {
    organizationIds,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    compare: input.compare,
  });
  const currentRows = rows
    .filter((row) => hasActivity(row.currentDebit, row.currentCredit))
    .map((row) => projectedReportRow(row, row.currentDebit, row.currentCredit));
  const priorRows =
    input.compare === "prior_period"
      ? rows
          .filter((row) => hasActivity(row.priorDebit, row.priorCredit))
          .map((row) => projectedReportRow(row, row.priorDebit, row.priorCredit))
      : [];

  return {
    report: buildProfitLoss(
      combinePortfolioReportRows(currentRows),
      input.dateFrom,
      input.dateTo,
      input.compare,
      combinePortfolioReportRows(priorRows),
    ),
    metadata: resultMetadata,
  };
}
