/**
 * Financials Page — tabbed financial reports
 * Tabs: P&L | Balance Sheet | Cash Flow | Trial Balance | Aging
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../lib/auth-client";
import { useSidebar } from "../components/SidebarContext";
import {
  getBalanceSheet,
  getProfitLoss,
  getPortfolioProfitLoss,
  getCashFlow,
  getTrialBalance,
  getApAging,
  getArAging,
} from "./api/-reports";
import type { ReportTab, ComparisonMode, AgingType } from "../db/validation/reports";
import { formatCurrency, computeChange, getBucketLabels } from "../lib/report-utils";
import { businessGroupsReturnSearch } from "../lib/business-groups/drilldown";
import { buildPortfolioProfitLossCsv } from "../lib/business-groups/portfolio-profit-loss-export";
import type { PortfolioProfitLossResult } from "../lib/business-groups/portfolio-profit-loss-model";
import SmartDateFilter from "../components/smart-date-filter/SmartDateFilter";
import {
  computePrevRange,
  computeNextRange,
  isPrevDisabled,
  isNextDisabled,
  formatRangeLabel,
} from "../components/smart-date-filter/presets";

// ============================================================================
// Route Definition
// ============================================================================

/** Default: first day of current month */
function defaultDateFrom(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Default: last day of current month */
function defaultDateTo(): string {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
}

interface FinancialsSearch {
  tab?: string;
  dateFrom?: string;
  dateTo?: string;
  compare?: string;
  agingType?: string;
  scope?: "organization" | "portfolio";
  accountId?: string;
  groupIds?: string;
  fromBusinessGroups?: boolean;
}

function parsePortfolioGroupIds(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

export const Route = createFileRoute("/financials")({
  component: FinancialsPage,
  validateSearch(search: Record<string, unknown>): FinancialsSearch {
    return {
      tab: (search.tab as string) || "profit-loss",
      dateFrom: (search.dateFrom as string) || defaultDateFrom(),
      dateTo: (search.dateTo as string) || defaultDateTo(),
      compare: (search.compare as string) || "none",
      agingType: (search.agingType as string) || "ap",
      scope: search.scope === "portfolio" ? "portfolio" : "organization",
      accountId: typeof search.accountId === "string" ? search.accountId : undefined,
      groupIds: typeof search.groupIds === "string" ? search.groupIds : undefined,
      fromBusinessGroups:
        search.fromBusinessGroups === true || search.fromBusinessGroups === "true",
    };
  },
});

// ============================================================================
// Tab Configuration
// ============================================================================

const TABS: Array<{ value: ReportTab; label: string }> = [
  { value: "profit-loss", label: "P&L" },
  { value: "balance-sheet", label: "Balance Sheet" },
  { value: "cash-flow", label: "Cash Flow" },
  { value: "trial-balance", label: "Trial Balance" },
  { value: "aging", label: "Aging" },
];

// ============================================================================
// Page Component
// ============================================================================

function FinancialsPage() {
  const { data: session } = useSession();
  const _sidebar = useSidebar();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();

  const isPortfolio = search.scope === "portfolio";
  const portfolioGroupIds = parsePortfolioGroupIds(search.groupIds);
  const portfolioScopeReady = Boolean(search.accountId && portfolioGroupIds.length > 0);
  const activeTab = (isPortfolio ? "profit-loss" : search.tab || "profit-loss") as ReportTab;
  const dateFrom = search.dateFrom || defaultDateFrom();
  const dateTo = search.dateTo || defaultDateTo();
  const compare = (search.compare || "none") as ComparisonMode;
  const agingType = (search.agingType || "ap") as AgingType;

  // ─── Tab scroll-fade indicator ──────────────────────────
  const tabsRef = useRef<HTMLElement>(null);
  const [showTabFade, setShowTabFade] = useState(false);

  const handleTabScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    // Hide fade when scrolled near the end (within 8px)
    setShowTabFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    // Check on mount & resize whether tabs overflow
    const el = tabsRef.current;
    if (!el) return;
    const check = () => {
      setShowTabFade(
        el.scrollWidth > el.clientWidth && el.scrollLeft + el.clientWidth < el.scrollWidth - 8,
      );
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const setTab = useCallback(
    (tab: ReportTab) => {
      navigate({
        search: (prev) => ({ ...prev, tab }),
      });
    },
    [navigate],
  );

  const setDateRange = useCallback(
    (from: string, to: string) => {
      navigate({
        search: (prev) => ({ ...prev, dateFrom: from, dateTo: to }),
      });
    },
    [navigate],
  );

  const toggleCompare = useCallback(
    (mode: ComparisonMode) => {
      navigate({
        search: (prev) => ({
          ...prev,
          compare: prev.compare === mode ? "none" : mode,
        }),
      });
    },
    [navigate],
  );

  const setAgingType = useCallback(
    (type: AgingType) => {
      navigate({
        search: (prev) => ({ ...prev, agingType: type }),
      });
    },
    [navigate],
  );

  const handlePrev = () => {
    const { from, to } = computePrevRange(dateFrom, dateTo);
    setDateRange(from, to);
  };
  const handleNext = () => {
    const { from, to } = computeNextRange(dateFrom, dateTo);
    setDateRange(from, to);
  };

  // ─── Queries ─────────────────────────────────────────────
  type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

  const plQuery = useQuery({
    queryKey: [
      "reports",
      "profit-loss",
      isPortfolio ? "portfolio" : "organization",
      search.accountId ?? null,
      portfolioGroupIds,
      dateFrom,
      dateTo,
      compare,
    ],
    queryFn: () =>
      isPortfolio
        ? (getPortfolioProfitLoss as ServerFnCaller)({
            data: {
              enterpriseAccountId: search.accountId,
              groupIds: portfolioGroupIds,
              dateFrom,
              dateTo,
              compare,
            },
          })
        : (getProfitLoss as ServerFnCaller)({ data: { dateFrom, dateTo, compare } }),
    enabled: activeTab === "profit-loss" && (!isPortfolio || portfolioScopeReady),
  });

  const bsQuery = useQuery({
    queryKey: ["reports", "balance-sheet", dateTo, compare],
    queryFn: () => (getBalanceSheet as ServerFnCaller)({ data: { asOf: dateTo, compare } }),
    enabled: !isPortfolio && activeTab === "balance-sheet",
  });

  const cfQuery = useQuery({
    queryKey: ["reports", "cash-flow", dateFrom, dateTo],
    queryFn: () => (getCashFlow as ServerFnCaller)({ data: { dateFrom, dateTo } }),
    enabled: !isPortfolio && activeTab === "cash-flow",
  });

  const tbQuery = useQuery({
    queryKey: ["reports", "trial-balance", dateFrom, dateTo],
    queryFn: () => (getTrialBalance as ServerFnCaller)({ data: { dateFrom, dateTo } }),
    enabled: !isPortfolio && activeTab === "trial-balance",
  });

  const apAgingQuery = useQuery({
    queryKey: ["reports", "ap-aging", dateTo],
    queryFn: () => (getApAging as ServerFnCaller)({ data: { asOf: dateTo } }),
    enabled: !isPortfolio && activeTab === "aging" && agingType === "ap",
  });

  const arAgingQuery = useQuery({
    queryKey: ["reports", "ar-aging", dateTo],
    queryFn: () => (getArAging as ServerFnCaller)({ data: { asOf: dateTo } }),
    enabled: !isPortfolio && activeTab === "aging" && agingType === "ar",
  });

  const portfolioResult = isPortfolio
    ? ((plQuery.data as PortfolioProfitLossResult | undefined) ?? null)
    : null;
  const profitLossData = isPortfolio ? portfolioResult?.report : plQuery.data;

  const returnToBusinessGroups = useCallback(() => {
    if (!search.accountId || portfolioGroupIds.length === 0) return;
    navigate({
      to: "/business-groups",
      search: businessGroupsReturnSearch({
        accountId: search.accountId,
        groupIds: portfolioGroupIds,
        dateFrom,
        dateTo,
        compare,
      }),
    });
  }, [compare, dateFrom, dateTo, navigate, portfolioGroupIds, search.accountId]);

  // ─── CSV Export ──────────────────────────────────────────
  const handleExportCsv = useCallback(() => {
    let csvContent = "";
    let filename = "report.csv";

    if (isPortfolio && portfolioResult) {
      const portfolioExport = buildPortfolioProfitLossCsv(portfolioResult);
      filename = portfolioExport.filename;
      csvContent = portfolioExport.csv;
    } else if (activeTab === "trial-balance" && tbQuery.data) {
      filename = `trial-balance-${dateFrom}.csv`;
      csvContent = "Account #,Account Name,Type,Debit,Credit\n";
      for (const acct of tbQuery.data.accounts) {
        csvContent += `"${acct.accountNumber ?? ""}","${acct.name}","${acct.accountType}",${acct.debit.toFixed(2)},${acct.credit.toFixed(2)}\n`;
      }
      csvContent += `,,TOTAL,${tbQuery.data.totalDebit.toFixed(2)},${tbQuery.data.totalCredit.toFixed(2)}\n`;
    } else if (activeTab === "profit-loss" && profitLossData) {
      filename = `profit-loss-${dateFrom}.csv`;
      csvContent = "Section,Account,Amount\n";
      const d = profitLossData;
      for (const acct of d.revenue.accounts) {
        csvContent += `Revenue,"${acct.name}",${acct.current.toFixed(2)}\n`;
      }
      csvContent += `Revenue,TOTAL,${d.revenue.total.toFixed(2)}\n`;
      for (const acct of d.costOfRevenue.accounts) {
        csvContent += `Cost of Revenue,"${acct.name}",${acct.current.toFixed(2)}\n`;
      }
      csvContent += `Cost of Revenue,TOTAL,${d.costOfRevenue.total.toFixed(2)}\n`;
      csvContent += `,,Gross Profit,${d.grossProfit.toFixed(2)}\n`;
      for (const acct of d.expenses.accounts) {
        csvContent += `Expenses,"${acct.name}",${acct.current.toFixed(2)}\n`;
      }
      csvContent += `Expenses,TOTAL,${d.expenses.total.toFixed(2)}\n`;
      if (d.otherIncome?.accounts.length) {
        for (const acct of d.otherIncome.accounts) {
          csvContent += `Other Income,"${acct.name}",${acct.current.toFixed(2)}\n`;
        }
        csvContent += `Other Income,TOTAL,${d.otherIncome.total.toFixed(2)}\n`;
      }
      if (d.otherExpenses?.accounts.length) {
        for (const acct of d.otherExpenses.accounts) {
          csvContent += `Other Expenses,"${acct.name}",${acct.current.toFixed(2)}\n`;
        }
        csvContent += `Other Expenses,TOTAL,${d.otherExpenses.total.toFixed(2)}\n`;
      }
      csvContent += `,,Net Income,${d.netIncome.toFixed(2)}\n`;
    }

    if (csvContent) {
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    }
  }, [activeTab, tbQuery.data, profitLossData, dateFrom, isPortfolio, portfolioResult]);

  // ─── Loading / Error States ──────────────────────────────
  const isLoading =
    (activeTab === "profit-loss" && plQuery.isLoading) ||
    (activeTab === "balance-sheet" && bsQuery.isLoading) ||
    (activeTab === "cash-flow" && cfQuery.isLoading) ||
    (activeTab === "trial-balance" && tbQuery.isLoading) ||
    (activeTab === "aging" && agingType === "ap" && apAgingQuery.isLoading) ||
    (activeTab === "aging" && agingType === "ar" && arAgingQuery.isLoading);

  if (!session?.user) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gradient-to-br from-[#edf5f0] via-[#f0f7f2] to-[#f8fbf9] dark:from-[#0d1117] dark:via-[#111820] dark:to-[#151c28]">
      {/* ── Header Bar ─────────────────────────────────────── */}
      <header className="flex flex-col md:flex-row md:items-center md:justify-between px-5 py-3 gap-2 md:gap-3 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] text-white shrink-0">
        {/* Row 1 on mobile: title + export */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 shrink-0">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <div>
              <h1 className="text-[15px] font-semibold text-white">
                {isPortfolio ? "Portfolio Financials" : "Financials"}
              </h1>
              {search.fromBusinessGroups && search.accountId && portfolioGroupIds.length > 0 && (
                <button
                  type="button"
                  onClick={returnToBusinessGroups}
                  className="mt-0.5 block text-[11px] text-white/65 underline-offset-2 hover:text-white hover:underline"
                >
                  ← Back to Business Groups
                </button>
              )}
            </div>
          </div>

          {/* Export — visible on mobile row 1, repositioned on md+ */}
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={isPortfolio && !portfolioResult}
            title={
              isPortfolio && !portfolioResult
                ? "Wait for the authorized portfolio scope to load."
                : isPortfolio
                  ? "Export this authorized portfolio scope, including warnings and withheld-data metadata."
                  : undefined
            }
            className="flex md:hidden items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs font-medium hover:bg-white/15 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            ↓ Export
          </button>
        </div>

        {/* Row 2 on mobile: tabs (scrollable with fade hint) */}
        <div className="relative mx-auto md:mx-0 max-w-full">
          <nav
            ref={tabsRef}
            className="flex items-center p-1 bg-white/10 rounded-full overflow-x-auto no-scrollbar"
            onScroll={handleTabScroll}
          >
            {TABS.filter((tab) => !isPortfolio || tab.value === "profit-loss").map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={`px-4 py-1 rounded-full text-[13px] font-medium transition-all whitespace-nowrap shrink-0 ${
                  activeTab === t.value
                    ? "bg-white/20 text-white shadow-sm"
                    : "text-white/50 hover:text-white hover:bg-white/10"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {/* Fade hint: more tabs to the right */}
          {showTabFade && (
            <div className="absolute right-0 top-0 bottom-0 w-8 pointer-events-none rounded-r-full bg-gradient-to-l from-white/20 to-transparent" />
          )}
        </div>

        {/* Export — desktop only (shown in header row) */}
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={isPortfolio && !portfolioResult}
          title={
            isPortfolio && !portfolioResult
              ? "Wait for the authorized portfolio scope to load."
              : isPortfolio
                ? "Export this authorized portfolio scope, including warnings and withheld-data metadata."
                : undefined
          }
          className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs font-medium hover:bg-white/15 transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↓ Export CSV
        </button>
      </header>

      {/* ── Toolbar: Period Nav + Comparison ────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] shrink-0">
        {/* Period Navigation */}
        <div className="flex items-center gap-0 bg-white/10 rounded-lg shrink-0">
          <button
            type="button"
            onClick={handlePrev}
            disabled={isPrevDisabled(dateFrom, dateTo)}
            className={`touch-target w-8 h-8 flex items-center justify-center rounded-l-lg transition-colors shrink-0 ${isPrevDisabled(dateFrom, dateTo) ? "text-white/20 cursor-not-allowed" : "text-white/70 hover:text-white hover:bg-white/10"}`}
            title="Previous period"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          {/* Date display: "As of [date]" for point-in-time tabs, range label for period tabs */}
          {activeTab === "balance-sheet" ||
          activeTab === "trial-balance" ||
          activeTab === "aging" ? (
            <span className="h-8 flex items-center px-2 text-xs font-medium text-white/70">
              As of{" "}
              {new Date(`${dateTo}T00:00:00`).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          ) : (
            <SmartDateFilter
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChange={setDateRange}
              hideChevron
              className="h-8 rounded-none border-none bg-transparent text-white/70 hover:text-white hover:bg-white/10 px-2 text-xs font-medium"
            />
          )}
          <button
            type="button"
            onClick={handleNext}
            disabled={isNextDisabled(dateFrom, dateTo)}
            className={`touch-target w-8 h-8 flex items-center justify-center rounded-r-lg transition-colors shrink-0 ${isNextDisabled(dateFrom, dateTo) ? "text-white/20 cursor-not-allowed" : "text-white/70 hover:text-white hover:bg-white/10"}`}
            title="Next period"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>

        {/* Comparison Toggle — only for tabs that support it */}
        {(activeTab === "profit-loss" || activeTab === "balance-sheet") && (
          <button
            type="button"
            onClick={() => toggleCompare("prior_period")}
            className={`px-3 py-1 rounded-md text-[12px] font-medium transition-all border text-center ${
              compare === "prior_period"
                ? "bg-white/20 text-white shadow-sm border-white/20"
                : "text-white/50 hover:text-white hover:bg-white/10 border-transparent"
            }`}
          >
            vs Prior Period
          </button>
        )}

        {/* Aging Type Toggle */}
        {activeTab === "aging" && (
          <div className="flex items-center gap-1.5 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => setAgingType("ap")}
              className={`flex-1 sm:flex-none px-3 py-1 rounded-md text-[12px] font-medium transition-all border text-center ${
                agingType === "ap"
                  ? "bg-white/20 text-white shadow-sm border-white/20"
                  : "text-white/50 hover:text-white hover:bg-white/10 border-transparent"
              }`}
            >
              Accounts Payable
            </button>
            <button
              type="button"
              onClick={() => setAgingType("ar")}
              className={`flex-1 sm:flex-none px-3 py-1 rounded-md text-[12px] font-medium transition-all border text-center ${
                agingType === "ar"
                  ? "bg-white/20 text-white shadow-sm border-white/20"
                  : "text-white/50 hover:text-white hover:bg-white/10 border-transparent"
              }`}
            >
              Accounts Receivable
            </button>
          </div>
        )}
      </div>

      {/* ── Report Content ─────────────────────────────────── */}
      <main
        className="p-3 sm:p-6"
        style={{
          flex: 1,
          overflow: "auto",
        }}
      >
        {isLoading ? (
          <ReportSkeleton />
        ) : (
          <>
            {isPortfolio && !portfolioScopeReady && (
              <PortfolioReportNotice
                title="Portfolio scope is incomplete"
                messages={[
                  "Open this report with an Enterprise account and at least one selected Business Group.",
                ]}
              />
            )}
            {isPortfolio && portfolioScopeReady && plQuery.isError && (
              <PortfolioReportNotice
                title="Portfolio report could not load"
                messages={[
                  "The selected portfolio is unavailable. Check your access and try again.",
                ]}
              />
            )}
            {isPortfolio && portfolioResult && (
              <PortfolioScopeSummary metadata={portfolioResult.metadata} />
            )}
            {activeTab === "profit-loss" && profitLossData && (
              <ProfitLossView
                data={profitLossData}
                compare={compare}
                dateFrom={dateFrom}
                dateTo={dateTo}
                currency={portfolioResult?.metadata.currency ?? undefined}
              />
            )}
            {isPortfolio && portfolioResult && !portfolioResult.report && (
              <PortfolioReportNotice
                title="Portfolio statement withheld"
                messages={portfolioResult.metadata.warnings}
              />
            )}
            {activeTab === "balance-sheet" && bsQuery.data && (
              <BalanceSheetView data={bsQuery.data} compare={compare} />
            )}
            {activeTab === "cash-flow" && cfQuery.data && (
              <CashFlowView data={cfQuery.data} dateFrom={dateFrom} dateTo={dateTo} />
            )}
            {activeTab === "trial-balance" && tbQuery.data && (
              <TrialBalanceView data={tbQuery.data} dateTo={dateTo} />
            )}
            {activeTab === "aging" && agingType === "ap" && apAgingQuery.data && (
              <AgingView data={apAgingQuery.data} type="ap" />
            )}
            {activeTab === "aging" && agingType === "ar" && arAgingQuery.data && (
              <AgingView data={arAgingQuery.data} type="ar" />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ============================================================================
// Skeleton Loader
// ============================================================================

function ReportSkeleton() {
  return (
    <div className="bg-white dark:bg-[#15192a] rounded-xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={`skel-${i}`} className="flex gap-4 mb-4 animate-pulse">
          <div className="w-[40%] h-4 bg-[#e5e7eb] dark:bg-white/10 rounded" />
          <div className="w-[20%] h-4 bg-[#e5e7eb] dark:bg-white/10 rounded" />
          <div className="w-[20%] h-4 bg-[#e5e7eb] dark:bg-white/10 rounded" />
        </div>
      ))}
    </div>
  );
}

interface PortfolioMetadataView {
  selectedGroups: Array<{ id: string; name: string }>;
  includedBusinesses: Array<{ organizationId: string; name: string }>;
  totalEntityCount: number;
  omittedEntityCount: number;
  currency: string | null;
  sourceMode: "live_ledger" | "projected";
  projectionAsOf: string | null;
  warnings: string[];
}

function PortfolioScopeSummary({ metadata }: { metadata: PortfolioMetadataView }) {
  const sourceLabel =
    metadata.sourceMode === "live_ledger" ? "Live ledgers" : "Reporting projection";
  return (
    <section className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-950 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100 sm:mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold">
            {metadata.selectedGroups.map((group) => group.name).join(", ")}
          </div>
          <div className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-100/65">
            {metadata.includedBusinesses.length} accessible business
            {metadata.includedBusinesses.length === 1 ? "" : "es"} included
            {metadata.omittedEntityCount > 0
              ? ` • ${metadata.omittedEntityCount} omitted by access controls`
              : ""}
          </div>
        </div>
        <div className="text-right text-xs text-emerald-800/80 dark:text-emerald-100/65">
          <div>{sourceLabel}</div>
          <div>
            {metadata.includedBusinesses.length === 0
              ? "No accessible businesses"
              : (metadata.currency ?? "Mixed currencies")}
          </div>
          {metadata.projectionAsOf && (
            <div>As of {new Date(metadata.projectionAsOf).toLocaleString()}</div>
          )}
        </div>
      </div>
      {metadata.warnings.length > 0 && (
        <ul className="mb-0 mt-3 list-disc space-y-1 pl-5 text-xs text-amber-800 dark:text-amber-200">
          {metadata.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PortfolioReportNotice({ title, messages }: { title: string; messages: string[] }) {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <ul className="mb-0 mt-2 list-disc space-y-1 pl-5 text-sm">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </section>
  );
}

// ============================================================================
// Report Card Wrapper
// ============================================================================

function ReportCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-[#15192a] rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)] overflow-hidden">
      <div className="px-3 sm:px-6 pt-5 pb-3 border-b border-[#f3f4f6] dark:border-white/8">
        <h2 className="text-lg font-bold text-[#111827] dark:text-white m-0">{title}</h2>
        {subtitle && (
          <p className="text-[13px] text-[#6b7280] dark:text-white/50 mt-1">{subtitle}</p>
        )}
      </div>
      <div className="px-3 sm:px-6 pb-5 overflow-x-auto">{children}</div>
    </div>
  );
}

// ============================================================================
// Change Badge
// ============================================================================

function ChangeBadge({
  amount,
  pct,
  currency,
}: {
  amount: number | null;
  pct: number | null;
  currency?: string;
}) {
  if (amount === null) return null;
  const isUp = amount > 0.005;
  const isDown = amount < -0.005;
  const color = isUp ? "#16a34a" : isDown ? "#dc2626" : "#6b7280";
  const arrow = isUp ? "▲" : isDown ? "▼" : "";

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {arrow} {formatCurrency(Math.abs(amount), currency)}
      {pct !== null && (
        <span style={{ marginLeft: 4, opacity: 0.7 }}>({Math.abs(pct).toFixed(1)}%)</span>
      )}
    </span>
  );
}

// ============================================================================
// Section Header Row
// ============================================================================

function SectionRow({
  label,
  amount,
  prior,
  isBold,
  compare,
  currency,
}: {
  label: string;
  amount: number;
  prior?: number | null;
  isBold?: boolean;
  compare?: ComparisonMode;
  currency?: string;
}) {
  const change = prior != null ? computeChange(amount, prior) : null;
  return (
    <tr className={isBold ? "bg-[#f8fafc] dark:bg-white/[0.03]" : ""}>
      <td
        className={`py-2.5 px-3 ${isBold ? "font-bold text-sm" : "font-semibold text-[13px]"} text-[#111827] dark:text-white`}
      >
        {label}
      </td>
      <td
        className={`py-2.5 px-3 text-right ${isBold ? "font-bold" : "font-semibold"} text-[13px] text-[#111827] dark:text-white`}
      >
        {formatCurrency(amount, currency)}
      </td>
      {compare && compare !== "none" && (
        <>
          <td className="py-2.5 px-3 text-right text-[13px] text-[#6b7280] dark:text-white/50">
            {prior != null ? formatCurrency(prior, currency) : "—"}
          </td>
          <td className="py-2.5 px-3 text-right">
            {change && <ChangeBadge amount={change.amount} pct={change.pct} currency={currency} />}
          </td>
        </>
      )}
    </tr>
  );
}

// ============================================================================
// Profit & Loss View
// ============================================================================

interface PLData {
  revenue: {
    label: string;
    accounts: Array<{
      id: string;
      name: string;
      current: number;
      prior: number | null;
      changeAmount: number | null;
      changePct: number | null;
    }>;
    total: number;
    priorTotal: number | null;
  };
  costOfRevenue: {
    label: string;
    accounts: Array<{
      id: string;
      name: string;
      current: number;
      prior: number | null;
      changeAmount: number | null;
      changePct: number | null;
    }>;
    total: number;
    priorTotal: number | null;
  };
  expenses: {
    label: string;
    accounts: Array<{
      id: string;
      name: string;
      current: number;
      prior: number | null;
      changeAmount: number | null;
      changePct: number | null;
    }>;
    total: number;
    priorTotal: number | null;
  };
  otherIncome?: {
    label: string;
    accounts: Array<{
      id: string;
      name: string;
      current: number;
      prior: number | null;
      changeAmount: number | null;
      changePct: number | null;
    }>;
    total: number;
    priorTotal: number | null;
  };
  otherExpenses?: {
    label: string;
    accounts: Array<{
      id: string;
      name: string;
      current: number;
      prior: number | null;
      changeAmount: number | null;
      changePct: number | null;
    }>;
    total: number;
    priorTotal: number | null;
  };
  grossProfit: number;
  priorGrossProfit: number | null;
  operatingIncome: number;
  priorOperatingIncome: number | null;
  netIncome: number;
  priorNetIncome: number | null;
}

function ProfitLossView({
  data,
  compare,
  dateFrom,
  dateTo,
  currency,
}: {
  data: PLData;
  compare: ComparisonMode;
  dateFrom: string;
  dateTo: string;
  currency?: string;
}) {
  const showCompare = compare !== "none";
  const colCount = showCompare ? 4 : 2;

  const renderSection = (section: PLData["revenue"], indent = false) => (
    <>
      <tr>
        <td
          colSpan={colCount}
          className="pt-3.5 px-3 pb-1.5 font-bold text-xs text-[#6b7280] dark:text-white/40 uppercase tracking-wider"
        >
          {section.label}
        </td>
      </tr>
      {section.accounts.map((acct) => (
        <tr key={acct.id} className="border-b border-[#f3f4f6] dark:border-white/5">
          <td
            className={`py-2 px-3 text-[13px] text-[#374151] dark:text-white/70 ${indent ? "pl-8" : ""}`}
          >
            {acct.name}
          </td>
          <td className="py-2 px-3 text-right text-[13px] font-medium tabular-nums text-[#111827] dark:text-white">
            {formatCurrency(acct.current, currency)}
          </td>
          {showCompare && (
            <>
              <td className="py-2 px-3 text-right text-[13px] tabular-nums text-[#6b7280] dark:text-white/50">
                {acct.prior != null ? formatCurrency(acct.prior, currency) : "—"}
              </td>
              <td className="py-2 px-3 text-right">
                <ChangeBadge amount={acct.changeAmount} pct={acct.changePct} currency={currency} />
              </td>
            </>
          )}
        </tr>
      ))}
      <SectionRow
        label={`Total ${section.label}`}
        amount={section.total}
        prior={section.priorTotal}
        compare={compare}
        currency={currency}
      />
    </>
  );

  return (
    <ReportCard
      title="Profit & Loss"
      subtitle={`${formatRangeLabel(dateFrom, dateTo)} • Accrual Basis`}
    >
      <table className="w-full min-w-[34rem] border-collapse mt-3">
        <thead>
          <tr className="border-b-2 border-[#e5e7eb] dark:border-white/10">
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Account
            </th>
            <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Current
            </th>
            {showCompare && (
              <>
                <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
                  Prior
                </th>
                <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
                  Change
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {renderSection(data.revenue)}
          {renderSection(data.costOfRevenue)}
          <SectionRow
            label="Gross Profit"
            amount={data.grossProfit}
            prior={data.priorGrossProfit}
            isBold
            compare={compare}
            currency={currency}
          />
          {renderSection(data.expenses, true)}
          <SectionRow
            label="Operating Income"
            amount={data.operatingIncome}
            prior={data.priorOperatingIncome}
            isBold
            compare={compare}
            currency={currency}
          />
          {data.otherIncome &&
            data.otherIncome.accounts.length > 0 &&
            renderSection(data.otherIncome)}
          {data.otherExpenses &&
            data.otherExpenses.accounts.length > 0 &&
            renderSection(data.otherExpenses, true)}
          <SectionRow
            label="Net Income"
            amount={data.netIncome}
            prior={data.priorNetIncome}
            isBold
            compare={compare}
            currency={currency}
          />
        </tbody>
      </table>
    </ReportCard>
  );
}

// ============================================================================
// Balance Sheet View
// ============================================================================

interface BSData {
  asOf: string;
  sections: Record<
    string,
    {
      label: string;
      accounts: Array<{ id: string; name: string; accountNumber: string | null; balance: number }>;
      total: number;
    }
  >;
  priorSections: Record<
    string,
    { label: string; accounts: Array<{ id: string; name: string; balance: number }>; total: number }
  > | null;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
}

function BalanceSheetView({ data, compare }: { data: BSData; compare: ComparisonMode }) {
  const showCompare = compare !== "none" && data.priorSections;
  const colCount = showCompare ? 4 : 2;

  const renderSection = (key: string) => {
    const section = data.sections[key];
    if (!section) return null;
    const priorSection = data.priorSections?.[key];

    return (
      <>
        <tr>
          <td
            colSpan={colCount}
            className="pt-3.5 px-3 pb-1.5 font-bold text-xs text-[#6b7280] dark:text-white/40 uppercase tracking-wider"
          >
            {section.label}
          </td>
        </tr>
        {section.accounts.map((acct) => {
          const priorAcct = priorSection?.accounts.find((a) => a.id === acct.id);
          const change = priorAcct ? computeChange(acct.balance, priorAcct.balance) : null;
          return (
            <tr key={acct.id} className="border-b border-[#f3f4f6] dark:border-white/5">
              <td className="py-2 px-3 text-[13px] text-[#374151] dark:text-white/70">
                {acct.accountNumber && (
                  <span className="text-[#9ca3af] dark:text-white/30 mr-2 text-[11px]">
                    {acct.accountNumber}
                  </span>
                )}
                {acct.name}
              </td>
              <td className="py-2 px-3 text-right text-[13px] font-medium tabular-nums text-[#111827] dark:text-white">
                {formatCurrency(acct.balance)}
              </td>
              {showCompare && (
                <>
                  <td className="py-2 px-3 text-right text-[13px] text-[#6b7280] dark:text-white/50 tabular-nums">
                    {priorAcct ? formatCurrency(priorAcct.balance) : "—"}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {change && <ChangeBadge amount={change.amount} pct={change.pct} />}
                  </td>
                </>
              )}
            </tr>
          );
        })}
        <SectionRow
          label={`Total ${section.label}`}
          amount={section.total}
          prior={priorSection?.total ?? null}
          isBold
          compare={compare}
        />
      </>
    );
  };

  return (
    <ReportCard
      title="Balance Sheet"
      subtitle={`As of ${new Date(`${data.asOf}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} • Accrual Basis`}
    >
      <table className="w-full min-w-[34rem] border-collapse mt-3">
        <thead>
          <tr className="border-b-2 border-[#e5e7eb] dark:border-white/10">
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Account
            </th>
            <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Balance
            </th>
            {showCompare && (
              <>
                <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
                  Prior
                </th>
                <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
                  Change
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {renderSection("asset")}
          {renderSection("liability")}
          {renderSection("equity")}
          <tr className="border-t-2 border-[#1a7fc4]">
            <td className="p-3 font-bold text-sm text-[#1a7fc4]">Total Liabilities + Equity</td>
            <td className="p-3 text-right font-bold text-sm tabular-nums text-[#1a7fc4]">
              {formatCurrency(data.totalLiabilitiesAndEquity)}
            </td>
            {showCompare && (
              <>
                <td />
                <td />
              </>
            )}
          </tr>
        </tbody>
      </table>

      {/* Balance verification */}
      {Math.abs(data.totalAssets - data.totalLiabilitiesAndEquity) > 0.01 && (
        <div className="mt-3 py-2 px-3 bg-[#fef2f2] dark:bg-red-900/20 rounded-md text-xs text-[#dc2626] dark:text-red-400 font-medium">
          ⚠ Balance sheet is out of balance. Assets ({formatCurrency(data.totalAssets)}) ≠
          Liabilities + Equity ({formatCurrency(data.totalLiabilitiesAndEquity)})
        </div>
      )}
    </ReportCard>
  );
}

// ============================================================================
// Cash Flow View
// ============================================================================

interface CFData {
  operating: { items: Array<{ name: string; amount: number }>; total: number };
  investing: { items: Array<{ name: string; amount: number }>; total: number };
  financing: { items: Array<{ name: string; amount: number }>; total: number };
  /** Balance-sheet accounts no section claims. Absent on cached older payloads. */
  unclassified?: { items: Array<{ name: string; amount: number }>; total: number };
  netChange: number;
}

function CashFlowView({
  data,
  dateFrom,
  dateTo,
}: {
  data: CFData;
  dateFrom: string;
  dateTo: string;
}) {
  const renderSection = (label: string, section: CFData["operating"]) => (
    <>
      <tr>
        <td
          colSpan={2}
          className="pt-3.5 px-3 pb-1.5 font-bold text-xs text-[#6b7280] dark:text-white/40 uppercase tracking-wider"
        >
          {label}
        </td>
      </tr>
      {section.items.map((item, i) => (
        <tr key={`${label}-${i}`} className="border-b border-[#f3f4f6] dark:border-white/5">
          <td className="py-2 px-3 pl-6 text-[13px] text-[#374151] dark:text-white/70">
            {item.name}
          </td>
          <td
            className={`py-2 px-3 text-right text-[13px] font-medium tabular-nums ${item.amount >= 0 ? "text-[#111827] dark:text-white" : "text-[#dc2626] dark:text-red-400"}`}
          >
            {formatCurrency(item.amount)}
          </td>
        </tr>
      ))}
      <tr className="bg-[#f8fafc] dark:bg-white/[0.03]">
        <td className="py-2.5 px-3 font-semibold text-[13px] text-[#111827] dark:text-white">
          Net {label}
        </td>
        <td
          className={`py-2.5 px-3 text-right font-bold text-[13px] tabular-nums ${section.total >= 0 ? "text-[#111827] dark:text-white" : "text-[#dc2626] dark:text-red-400"}`}
        >
          {formatCurrency(section.total)}
        </td>
      </tr>
    </>
  );

  return (
    <ReportCard
      title="Cash Flow Statement"
      subtitle={`${formatRangeLabel(dateFrom, dateTo)} • Accrual Basis`}
    >
      <table className="w-full min-w-[34rem] border-collapse mt-3">
        <thead>
          <tr className="border-b-2 border-[#e5e7eb] dark:border-white/10">
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Activity
            </th>
            <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {renderSection("Operating Activities", data.operating)}
          {renderSection("Investing Activities", data.investing)}
          {renderSection("Financing Activities", data.financing)}
          {/* Only rendered when non-empty. These accounts carry a subtype no
              section recognizes; they used to be dropped, which made the
              statement quietly stop tying. */}
          {(data.unclassified?.items.length ?? 0) > 0 &&
            renderSection("Unclassified — needs a subtype", data.unclassified!)}
          <tr className="border-t-2 border-[#1a7fc4]">
            <td className="p-3 font-bold text-sm text-[#1a7fc4]">
              Net Increase (Decrease) in Cash
            </td>
            <td
              className={`p-3 text-right font-bold text-sm tabular-nums ${data.netChange >= 0 ? "text-[#1a7fc4]" : "text-[#dc2626] dark:text-red-400"}`}
            >
              {formatCurrency(data.netChange)}
            </td>
          </tr>
        </tbody>
      </table>
    </ReportCard>
  );
}

// ============================================================================
// Trial Balance View
// ============================================================================

interface TBData {
  accounts: Array<{
    id: string;
    name: string;
    accountNumber: string | null;
    accountType: string;
    debit: number;
    credit: number;
  }>;
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
  difference: number;
}

function TrialBalanceView({ data, dateTo }: { data: TBData; dateTo: string }) {
  return (
    <ReportCard
      title="Trial Balance"
      subtitle={`As of ${new Date(`${dateTo}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} • Accrual Basis`}
    >
      <table className="w-full min-w-[34rem] border-collapse mt-3">
        <thead>
          <tr className="border-b-2 border-[#e5e7eb] dark:border-white/10">
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Acct #
            </th>
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Account Name
            </th>
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Type
            </th>
            <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Debit
            </th>
            <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Credit
            </th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((acct) => (
            <tr key={acct.id} className="border-b border-[#f3f4f6] dark:border-white/5">
              <td className="py-2 px-3 text-xs text-[#9ca3af] dark:text-white/30 tabular-nums">
                {acct.accountNumber ?? "—"}
              </td>
              <td className="py-2 px-3 text-[13px] text-[#374151] dark:text-white/70">
                {acct.name}
              </td>
              <td className="py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 capitalize">
                {acct.accountType.replaceAll("_", " ")}
              </td>
              <td
                className={`py-2 px-3 text-right text-[13px] font-medium tabular-nums ${acct.debit > 0 ? "text-[#111827] dark:text-white" : "text-[#d1d5db] dark:text-white/20"}`}
              >
                {acct.debit > 0 ? formatCurrency(acct.debit) : "—"}
              </td>
              <td
                className={`py-2 px-3 text-right text-[13px] font-medium tabular-nums ${acct.credit > 0 ? "text-[#111827] dark:text-white" : "text-[#d1d5db] dark:text-white/20"}`}
              >
                {acct.credit > 0 ? formatCurrency(acct.credit) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-[#e5e7eb] dark:border-white/10 bg-[#f8fafc] dark:bg-white/[0.03]">
            <td colSpan={3} className="p-3 font-bold text-sm text-[#111827] dark:text-white">
              Total
            </td>
            <td className="p-3 text-right font-bold text-sm tabular-nums text-[#111827] dark:text-white">
              {formatCurrency(data.totalDebit)}
            </td>
            <td className="p-3 text-right font-bold text-sm tabular-nums text-[#111827] dark:text-white">
              {formatCurrency(data.totalCredit)}
            </td>
          </tr>
        </tfoot>
      </table>

      {/* Balance Check */}
      <div
        className={`mt-3 py-2 px-3 rounded-md text-xs font-medium flex items-center gap-1.5 ${
          data.isBalanced
            ? "bg-[#f0fdf4] dark:bg-emerald-900/20 text-[#16a34a] dark:text-emerald-400"
            : "bg-[#fef2f2] dark:bg-red-900/20 text-[#dc2626] dark:text-red-400"
        }`}
      >
        {data.isBalanced ? "✓" : "⚠"}{" "}
        {data.isBalanced
          ? "Trial balance is in balance"
          : `Out of balance by ${formatCurrency(Math.abs(data.difference))}`}
      </div>
    </ReportCard>
  );
}

// ============================================================================
// Aging View
// ============================================================================

interface AgingData {
  asOf: string;
  type: "ap" | "ar";
  buckets: number[];
  vendors?: Array<{ vendorName: string; buckets: number[]; total: number }>;
  customers?: Array<{ customerName: string; buckets: number[]; total: number }>;
  bucketTotals: number[];
  grandTotal: number;
  /** Absent on cached older payloads. */
  warnings?: string[];
}

function AgingView({ data, type }: { data: AgingData; type: "ap" | "ar" }) {
  const labels = getBucketLabels(data.buckets);
  const entities =
    type === "ap"
      ? (data.vendors ?? []).map((v) => ({
          name: v.vendorName,
          buckets: v.buckets,
          total: v.total,
        }))
      : (data.customers ?? []).map((c) => ({
          name: c.customerName,
          buckets: c.buckets,
          total: c.total,
        }));

  return (
    <ReportCard
      title={type === "ap" ? "Accounts Payable Aging" : "Accounts Receivable Aging"}
      subtitle={`As of ${data.asOf}`}
    >
      {/* An empty aging report and "you owe nobody" look identical, so say
          when the report could not find the account it aggregates over. */}
      {(data.warnings?.length ?? 0) > 0 && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {data.warnings!.join(" ")}
        </div>
      )}
      <table className="w-full min-w-[34rem] border-collapse mt-3">
        <thead>
          <tr className="border-b-2 border-[#e5e7eb] dark:border-white/10">
            <th className="text-left py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              {type === "ap" ? "Vendor" : "Customer"}
            </th>
            {labels.map((l) => (
              <th
                key={l}
                className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold"
              >
                {l}
              </th>
            ))}
            <th className="text-right py-2 px-3 text-xs text-[#6b7280] dark:text-white/40 font-semibold">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {entities.length === 0 ? (
            <tr>
              <td
                colSpan={labels.length + 2}
                className="p-6 text-center text-[13px] text-[#9ca3af] dark:text-white/30"
              >
                No outstanding {type === "ap" ? "payables" : "receivables"}
              </td>
            </tr>
          ) : (
            entities.map((entity, i) => (
              <tr key={`entity-${i}`} className="border-b border-[#f3f4f6] dark:border-white/5">
                <td className="py-2 px-3 text-[13px] text-[#374151] dark:text-white/70 font-medium">
                  {entity.name}
                </td>
                {entity.buckets.map((val, j) => (
                  <td
                    key={`bucket-${j}`}
                    className={`py-2 px-3 text-right text-[13px] tabular-nums ${val > 0 ? (j >= 3 ? "text-[#dc2626] dark:text-red-400" : "text-[#111827] dark:text-white") : "text-[#d1d5db] dark:text-white/20"}`}
                  >
                    {val > 0 ? formatCurrency(val) : "—"}
                  </td>
                ))}
                <td className="py-2 px-3 text-right text-[13px] font-semibold tabular-nums text-[#111827] dark:text-white">
                  {formatCurrency(entity.total)}
                </td>
              </tr>
            ))
          )}
        </tbody>
        {entities.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-[#e5e7eb] dark:border-white/10 bg-[#f8fafc] dark:bg-white/[0.03]">
              <td className="p-3 font-bold text-[13px] text-[#111827] dark:text-white">Total</td>
              {data.bucketTotals.map((val, j) => (
                <td
                  key={`total-${j}`}
                  className={`p-3 text-right font-bold text-[13px] tabular-nums ${val > 0 ? (j >= 3 ? "text-[#dc2626] dark:text-red-400" : "text-[#111827] dark:text-white") : "text-[#d1d5db] dark:text-white/20"}`}
                >
                  {val > 0 ? formatCurrency(val) : "—"}
                </td>
              ))}
              <td className="p-3 text-right font-bold text-sm tabular-nums text-[#1a7fc4]">
                {formatCurrency(data.grandTotal)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </ReportCard>
  );
}
