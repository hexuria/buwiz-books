/**
 * Transaction Ledger Page — 3-panel layout
 * COA Sidebar + Main Ledger Content (Header, Date Nav, Search, Summary, List/Balances)
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useActiveOrganization } from "../hooks/useActiveOrganization";
import { useIsCompactNav, useIsMobile, usePrefersReducedMotion } from "../hooks/useBreakpoint";
import { useToast } from "../components/ui/Toast";
import { Button } from "../components/ui/Actions";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";
import { setClosedThrough } from "./api/-transactions";
import { listParties } from "./api/-parties";
import { listDepartments, listLocations } from "./api/-dimensions";
import {
  exportCSVToDocuments,
  exportFinancialPackage,
  exportTransactionsCSV,
} from "./api/-export-transactions";
import { callServerFn } from "../lib/server-fn-client";

import LedgerHeader from "../components/ledger/LedgerHeader";
import { useSidebar } from "../components/SidebarContext";
import DateRangeNavigator from "../components/ledger/DateRangeNavigator";
import LedgerSearchBar from "../components/ledger/LedgerSearchBar";
import AccountSidebar from "../components/ledger/AccountSidebar";
import type { SidebarAccount } from "../components/ledger/AccountSidebar";
import AccountSummaryCard from "../components/ledger/AccountSummaryCard";
import LedgerRow from "../components/ledger/LedgerRow";
import {
  LEDGER_CHECKBOX_WIDTH,
  LEDGER_GRID_COLS,
  LEDGER_GRID_COLS_NO_BALANCE,
  LEDGER_GRID_MIN_WIDTH,
} from "../components/ledger/LedgerRow";
import type { LedgerRowData } from "../components/ledger/LedgerRow";
import AccountGroupedList from "../components/ledger/AccountGroupedList";
import ConfirmModal from "../components/shared/ConfirmModal";
import LedgerFilters from "../components/ledger/LedgerFilters";
import BatchActionBar from "../components/ledger/BatchActionBar";
import InlineEditBar from "../components/ledger/InlineEditBar";
import MatchConfirmModal from "../components/ledger/MatchConfirmModal";
import ManageCloseModal from "../components/ledger/ManageCloseModal";
import { ImportBankTransactionsModal } from "../components/transactions/ImportBankTransactionsModal";
import { ImportJournalEntriesModal } from "../components/transactions/ImportJournalEntriesModal";
import FinancialPackageModal from "../components/transactions/FinancialPackageModal";

// Extracted hooks
import { useTransactionFilters, type TransactionsSearch } from "../hooks/useTransactionFilters";
import { useTransactionQueries } from "../hooks/useTransactionQueries";
import { useBatchActions } from "../hooks/useBatchActions";
import { useInlineEditing } from "../hooks/useInlineEditing";

// ============================================================================
// Route Definition
// ============================================================================

export const Route = createFileRoute("/transactions")({
  component: TransactionsRouteComponent,
  validateSearch(search: Record<string, unknown>): TransactionsSearch {
    return {
      accountId: (search.accountId as string) || undefined,
      selected: (search.selected as string) || undefined,
      mode: (search.mode as string) || undefined,

      types: (search.types as string) || undefined,
      statuses: (search.statuses as string) || undefined,
      sources: (search.sources as string) || undefined,
      matched: (search.matched as string) || undefined,
      amountMin: (search.amountMin as string) || undefined,
      amountMax: (search.amountMax as string) || undefined,
      partyIds: (search.partyIds as string) || undefined,
      departmentIds: (search.departmentIds as string) || undefined,
      locationIds: (search.locationIds as string) || undefined,
      dateFrom: (search.dateFrom as string) || undefined,
      dateTo: (search.dateTo as string) || undefined,
    };
  },
});

function TransactionsRouteComponent() {
  return (
    <AppErrorBoundary contextLabel="Transactions">
      <TransactionsPage />
    </AppErrorBoundary>
  );
}

type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

// ============================================================================
// Page Component
// ============================================================================

function TransactionsPage() {
  const search = Route.useSearch() as TransactionsSearch;
  const queryClient = useQueryClient();
  const { toggle: toggleSidebar, collapsed } = useSidebar();
  const { data: activeOrg } = useActiveOrganization();
  const currency = activeOrg?.currency || "USD";
  const { showToast } = useToast();
  const activeOrgName = activeOrg?.name ?? "My Organization";

  // ── Responsive breakpoints ────────────────────────────────────────────
  // `lg` is the navigation boundary (the COA panel stops being persistent), `md` the data boundary
  // (the ledger grid becomes a card list). Both are hydration-safe, so the first client render is
  // already the phone layout instead of flashing the 1022px grid.
  const isCompactNav = useIsCompactNav();
  const isMobile = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();

  // ── COA sidebar state ─────────────────────────────────────────────────
  const [panelOpen, setPanelOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("ledger-sidebar-open");
    return stored === null ? true : stored === "true";
  });
  const [allCollapsed, setAllCollapsed] = useState(false);

  useEffect(() => {
    if (isCompactNav) setPanelOpen(false);
    else {
      const stored = localStorage.getItem("ledger-sidebar-open");
      setPanelOpen(stored === null ? true : stored === "true");
    }
  }, [isCompactNav]);

  useEffect(() => {
    if (!isCompactNav) localStorage.setItem("ledger-sidebar-open", String(panelOpen));
  }, [panelOpen, isCompactNav]);

  // The account drawer is an overlay below `md`, so it owes the user the overlay contract.
  useEffect(() => {
    if (!isMobile || !panelOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, panelOpen]);

  // ── Extracted hooks ───────────────────────────────────────────────────

  const filters = useTransactionFilters(search);

  const queries = useTransactionQueries({
    selectedAccountId: filters.selectedAccountId,
    typeFilter: filters.typeFilter,
    statusFilter: filters.statusFilter,
    partyFilter: filters.partyFilter,
    departmentFilter: filters.departmentFilter,
    locationFilter: filters.locationFilter,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    debouncedSearchQuery: filters.debouncedSearchQuery,
    checkedAccountIds: filters.checkedAccountIds,
  });

  const batch = useBatchActions({
    pageMode: filters.pageMode,
    transactions: queries.transactions,
    groupedData: queries.groupedData,
  });

  // ── Edit mode reference data ──────────────────────────────────────────

  const { data: allParties = [] } = useQuery({
    queryKey: ["parties"],
    queryFn: () => callServerFn(listParties, { data: {} }),
    enabled: filters.pageMode === "edit",
  });

  const { data: allDepartments = [] } = useQuery({
    queryKey: ["departments"],
    queryFn: () => callServerFn(listDepartments, { data: {} }),
    enabled: filters.pageMode === "edit",
  });

  const { data: allLocations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: () => callServerFn(listLocations, { data: {} }),
    enabled: filters.pageMode === "edit",
  });

  const inline = useInlineEditing({
    pageMode: filters.pageMode,
    allParties,
    flatAccounts: queries.flatAccounts,
    allDepartments,
    allLocations,
  });

  // ── Close-through mutation ────────────────────────────────────────────

  const setClosedThroughMutation = useMutation({
    mutationFn: (date: string | null) =>
      callServerFn(setClosedThrough, {
        data: { closedThrough: date },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["closedThrough"] });
    },
  });

  const [manageCloseOpen, setManageCloseOpen] = useState(false);
  const [importBankOpen, setImportBankOpen] = useState(false);
  const [importJournalOpen, setImportJournalOpen] = useState(false);
  const [financialPackageOpen, setFinancialPackageOpen] = useState(false);
  const [exportLoading, setExportLoading] = useState<"csv" | "csvDoc" | "package" | null>(null);

  // ── Filter panel data ─────────────────────────────────────────────────

  const { data: partyOptionsForFilter = [] } = useQuery({
    queryKey: ["parties", "filter"],
    queryFn: () => callServerFn(listParties, { data: {} }),
  });

  const { data: allDepartmentsForFilter = [] } = useQuery({
    queryKey: ["departments", "filter"],
    queryFn: () => callServerFn(listDepartments, { data: {} }),
  });

  const { data: allLocationsForFilter = [] } = useQuery({
    queryKey: ["locations", "filter"],
    queryFn: () => callServerFn(listLocations, { data: {} }),
  });

  const filteredPartyOptions = filters.filterPartyOptions(partyOptionsForFilter);
  const filteredDepartmentOptions = filters.filterDepartmentOptions(allDepartmentsForFilter);
  const filteredLocationOptions = filters.filterLocationOptions(allLocationsForFilter);

  const filterChips = useMemo(
    () =>
      filters.buildFilterChips(
        queries.accountTree,
        partyOptionsForFilter,
        allDepartmentsForFilter,
        allLocationsForFilter,
      ),
    [
      filters.buildFilterChips,
      queries.accountTree,
      partyOptionsForFilter,
      allDepartmentsForFilter,
      allLocationsForFilter,
    ],
  );

  const toggleCollapse = () => setAllCollapsed((prev) => !prev);

  // Both list shapes render the balance column, so the grid needs the wider of the two minimums
  // before its fixed tracks start being clipped. Edit mode adds the checkbox gutter.
  const gridMinWidth =
    LEDGER_GRID_MIN_WIDTH + (filters.pageMode === "edit" ? LEDGER_CHECKBOX_WIDTH : 0);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full bg-white dark:bg-slate-900">
      {/* ── COA Sidebar ─── */}
      {isMobile ? (
        <>
          {panelOpen && (
            <button
              type="button"
              aria-label="Close accounts panel"
              className="fixed inset-0 bg-black/30 z-40 transition-opacity"
              onClick={() => setPanelOpen(false)}
            />
          )}
          <div
            role="dialog"
            aria-modal={panelOpen}
            aria-label="Accounts"
            aria-hidden={!panelOpen}
            // `invisible` while shut, not just translated away: an off-screen panel that keeps its
            // visibility is still focusable, so tabbing through the ledger walks into the account
            // tree that is not on screen.
            className={`fixed top-0 left-0 bottom-0 z-50 flex w-[min(85vw,300px)] flex-col bg-white pt-safe pb-safe pl-safe shadow-2xl dark:bg-slate-900 ${
              panelOpen ? "visible" : "invisible"
            } ${reducedMotion ? "" : "transition-[transform,visibility] duration-300"}`}
            style={{ transform: panelOpen ? "translateX(0)" : "translateX(-100%)" }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-[#e5e7eb] pl-4 pr-2 py-2 dark:border-slate-700">
              <span className="text-sm font-semibold text-[#1e293b] dark:text-slate-100">
                Accounts
              </span>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                aria-label="Close accounts panel"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[#94a3b8] transition-colors hover:bg-[#f1f5f9] hover:text-[#475569] dark:hover:bg-slate-700"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain">
              <AccountSidebar
                accounts={queries.accountTree as SidebarAccount[]}
                selectedAccountId={filters.selectedAccountId}
                onSelectAccount={(id) => {
                  filters.handleSelectAccount(id);
                  setPanelOpen(false);
                }}
                accountBalances={queries.sidebarBalanceMap}
                checkedAccountIds={filters.checkedAccountIds}
                onToggleAccount={filters.handleToggleAccount}
              />
            </div>
          </div>
        </>
      ) : (
        <div
          className="shrink-0 flex flex-col overflow-hidden transition-all duration-200"
          style={{ width: panelOpen ? 240 : 0 }}
        >
          <AccountSidebar
            accounts={queries.accountTree as SidebarAccount[]}
            selectedAccountId={filters.selectedAccountId}
            onSelectAccount={filters.handleSelectAccount}
            accountBalances={queries.sidebarBalanceMap}
            checkedAccountIds={filters.checkedAccountIds}
            onToggleAccount={filters.handleToggleAccount}
          />
        </div>
      )}

      {/* ── Main Content ─── */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-300 relative ${
          collapsed
            ? "border-l border-[#e5e7eb] dark:border-slate-700"
            : "overflow-hidden border-y border-[#e5e7eb] dark:border-slate-700 md:m-4 md:rounded-lg md:border md:shadow-sm"
        }`}
      >
        {/* Floating Batch Action Bar */}
        {filters.pageMode === "edit" && batch.selectedTransactionIds.size > 0 && (
          <BatchActionBar
            selectedTransactions={batch.selectedTransactionsList}
            allParties={allParties}
            allCategories={queries.flatAccounts}
            allDepartments={allDepartments}
            allLocations={allLocations}
            onClear={batch.handleClearSelection}
            onUpdate={batch.handleBatchUpdate}
            onDelete={batch.handleBatchDelete}
            onMatch={batch.canMatchJournals ? batch.handleMatchRequest : undefined}
          />
        )}

        {/* Floating Inline Edit Bar */}
        {filters.pageMode === "edit" &&
          inline.pendingEdits.size > 0 &&
          batch.selectedTransactionIds.size === 0 && (
            <InlineEditBar
              editCount={inline.pendingEdits.size}
              isApplying={inline.updateBatchMutation.isPending}
              onCancel={inline.handleInlineCancel}
              onApply={inline.handleInlineApply}
            />
          )}

        {/* Header */}
        <LedgerHeader
          mode={filters.pageMode === "edit" ? "edit" : "view"}
          onModeChange={filters.handleModeChange}
          onMaximize={toggleSidebar}
          isMaximized={collapsed}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen(!panelOpen)}
        />

        {/* Date range navigator */}
        <DateRangeNavigator
          dateFrom={filters.dateFrom}
          dateTo={filters.dateTo}
          onAddTransaction={filters.handleNewTransaction}
          onDateChange={filters.handleDateChange}
          onManageClose={() => setManageCloseOpen(true)}
          onImportBankTransactions={() => setImportBankOpen(true)}
          onImportJournalEntries={() => setImportJournalOpen(true)}
          closedDate={queries.closedDate}
          closedBy={queries.closedDate ? "System" : null}
          exportLoading={exportLoading}
          onDownloadCSV={async () => {
            try {
              setExportLoading("csv");
              const result = await (exportTransactionsCSV as ServerFnCaller)({
                data: {
                  dateFrom: filters.dateFrom,
                  dateTo: filters.dateTo,
                  types: filters.typeFilter,
                  statuses: filters.statusFilter,
                  partyIds: filters.partyFilter,
                  accountId: filters.selectedAccountId || undefined,
                  departmentIds: filters.departmentFilter,
                  locationIds: filters.locationFilter,
                  search: filters.searchQuery || undefined,
                },
              });
              const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = result.filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              showToast?.("CSV downloaded successfully", { icon: "success" });
            } catch (err: unknown) {
              const errMessage = err instanceof Error ? err.message : String(err);
              showToast?.(errMessage || "Failed to download CSV", { icon: "error" });
            } finally {
              setExportLoading(null);
            }
          }}
          onExportCSVToDocuments={async () => {
            try {
              setExportLoading("csvDoc");
              const result = await (exportCSVToDocuments as ServerFnCaller)({
                data: {
                  dateFrom: filters.dateFrom,
                  dateTo: filters.dateTo,
                  types: filters.typeFilter,
                  statuses: filters.statusFilter,
                  partyIds: filters.partyFilter,
                  accountId: filters.selectedAccountId || undefined,
                  departmentIds: filters.departmentFilter,
                  locationIds: filters.locationFilter,
                  search: filters.searchQuery || undefined,
                },
              });
              showToast?.("CSV exported to Documents", { icon: "success" });
              // Re-use the navigate from filters for navigation
              window.location.href = `/documents/${result.documentId}`;
            } catch (err: unknown) {
              const errMessage = err instanceof Error ? err.message : String(err);
              showToast?.(errMessage || "Failed to export CSV to Documents", { icon: "error" });
            } finally {
              setExportLoading(null);
            }
          }}
          onDownloadFinancialPackage={() => setFinancialPackageOpen(true)}
        />

        {/* Manage Close modal */}
        <ManageCloseModal
          isOpen={manageCloseOpen}
          onClose={() => setManageCloseOpen(false)}
          onSave={(date) => {
            setClosedThroughMutation.mutate(date);
          }}
          orgName={activeOrgName}
          initialClosedDate={queries.closedDate}
          suggestedDate={filters.dateTo}
        />

        {/* Import modals */}
        <ImportBankTransactionsModal
          isOpen={importBankOpen}
          onClose={() => setImportBankOpen(false)}
        />
        <ImportJournalEntriesModal
          isOpen={importJournalOpen}
          onClose={() => setImportJournalOpen(false)}
        />
        <FinancialPackageModal
          open={financialPackageOpen}
          onClose={() => setFinancialPackageOpen(false)}
          dateFrom={filters.dateFrom}
          dateTo={filters.dateTo}
          loading={exportLoading === "package"}
          onDownload={async (options) => {
            try {
              setExportLoading("package");
              const result = await (exportFinancialPackage as ServerFnCaller)({
                data: {
                  dateFrom: filters.dateFrom,
                  dateTo: filters.dateTo,
                  ...options,
                },
              });
              const binaryStr = atob(result.zipBase64);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: "application/zip" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = result.filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              setFinancialPackageOpen(false);
              showToast?.("Financial package downloaded", { icon: "success" });
            } catch (err: unknown) {
              const errMessage = err instanceof Error ? err.message : String(err);
              showToast?.(errMessage || "Failed to generate financial package", { icon: "error" });
            } finally {
              setExportLoading(null);
            }
          }}
        />

        {/* Main Content Area */}
        <div className="flex-1 min-w-0 flex flex-col h-full relative">
          <div className="relative">
            <LedgerSearchBar
              transactionCount={queries.transactions.length}
              searchQuery={filters.searchQuery}
              onSearchChange={filters.setSearchQuery}
              allCollapsed={allCollapsed}
              onToggleCollapse={toggleCollapse}
              onToggleFilters={() => filters.setFiltersOpen(!filters.filtersOpen)}
              hasActiveFilters={filters.hasActiveFilters}
              filterChips={filterChips}
              onRemoveChip={filters.handleRemoveChip}
              onClearAll={filters.clearAllFilters}
            />

            <LedgerFilters
              isOpen={filters.filtersOpen}
              onClose={() => filters.setFiltersOpen(false)}
              typeFilter={filters.typeFilter}
              statusFilter={filters.statusFilter}
              sourceFilter={filters.sourceFilter}
              matchedFilter={filters.matchedFilter}
              amountMin={filters.amountMin}
              amountMax={filters.amountMax}
              partyFilter={filters.partyFilter}
              partyOptions={filteredPartyOptions}
              partySearch={filters.partySearch}
              onPartySearchChange={filters.setPartySearch}
              onToggleParty={filters.togglePartyFilter}
              departmentFilter={filters.departmentFilter}
              departmentOptions={filteredDepartmentOptions}
              departmentSearch={filters.departmentSearch}
              onDepartmentSearchChange={filters.setDepartmentSearch}
              onToggleDepartment={filters.toggleDepartmentFilter}
              locationFilter={filters.locationFilter}
              locationOptions={filteredLocationOptions}
              locationSearch={filters.locationSearch}
              onLocationSearchChange={filters.setLocationSearch}
              onToggleLocation={filters.toggleLocationFilter}
              onToggleType={filters.toggleTypeFilter}
              onToggleStatus={filters.toggleStatusFilter}
              onToggleSource={filters.toggleSourceFilter}
              onToggleMatched={filters.toggleMatchedFilter}
              onAmountChange={filters.handleAmountChange}
              onClearAll={filters.clearAllFilters}
            />
          </div>

          {/* List Content */}
          {/* Below `md` this is a card list, which must never scroll sideways. At `md` and up the
              grid's fixed tracks add up to more than the pane, so the axis has to be scrollable or
              the right-hand columns are clipped by the `overflow-hidden` shell and unreachable. */}
          <div className="flex-1 overflow-y-auto md:overflow-auto min-h-0 relative">
            {queries.isLoading ? (
              <LedgerStateMessage>Loading transactions...</LedgerStateMessage>
            ) : queries.transactions.length === 0 ? (
              <LedgerStateMessage
                action={
                  filters.hasActiveFilters ? (
                    <Button variant="secondary" onClick={filters.clearAllFilters}>
                      Clear filters
                    </Button>
                  ) : null
                }
              >
                No transactions found matching your filters.
              </LedgerStateMessage>
            ) : (
              <div style={isMobile ? undefined : { minWidth: gridMinWidth }}>
                {filters.selectedAccountId ? (
                  // Flat list for single account
                  <div>
                    {/* Column Headers — the card list carries its own labels below `md` */}
                    <div
                      className="hidden md:grid items-center px-0 py-2 border-b border-[#f1f5f9] dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider sticky top-0 bg-white dark:bg-[#0f172a] z-10"
                      style={{
                        gridTemplateColumns: filters.selectedAccountId
                          ? LEDGER_GRID_COLS
                          : LEDGER_GRID_COLS_NO_BALANCE,
                      }}
                    >
                      <div />
                      <div className="px-2 text-center">Date</div>
                      <div className="px-2">Party</div>
                      <div className="text-center">Src</div>
                      <div className="px-2">Category</div>
                      <div className="px-2">Department</div>
                      <div className="px-2">Location</div>
                      <div className="px-2 text-right">Amount</div>
                      {filters.selectedAccountId && <div className="px-2 text-right">Balance</div>}
                      <div />
                    </div>

                    <div className="pb-24 md:pb-20">
                      {(queries.transactionsWithBalance as LedgerRowData[]).map((txn) => (
                        <LedgerRow
                          key={txn.id}
                          transaction={txn}
                          isSelected={filters.selected === txn.id}
                          showBalance={!!filters.selectedAccountId}
                          onSelect={filters.handleSelect}
                          hasCheckbox={filters.pageMode === "edit"}
                          isChecked={batch.selectedTransactionIds.has(txn.id)}
                          onToggleSelection={batch.handleSelectTransaction}
                          isEditMode={filters.pageMode === "edit"}
                          pendingEdits={
                            inline.pendingEdits.get(
                              txn.categoryAccountId ? `${txn.id}:${txn.categoryAccountId}` : txn.id,
                            ) ?? inline.pendingEdits.get(txn.id)
                          }
                          onFieldChange={inline.handleInlineFieldChange}
                          allParties={inline.partyOptions}
                          allCategories={inline.categoryOptions}
                          allDepartments={inline.departmentOptions}
                          allLocations={inline.locationOptions}
                          cardMode={isMobile}
                          currency={currency}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  // Grouped list for All Accounts
                  <AccountGroupedList
                    groups={queries.filteredGroupedData}
                    isLoading={queries.isGroupedLoading}
                    error={queries.groupedError as Error | null}
                    onSelectTransaction={filters.handleSelect}
                    selectedTransactionId={filters.selected}
                    onLoadMore={queries.handleLoadMore}
                    loadingAccountIds={queries.loadingAccountIds}
                    selectionMode={filters.pageMode === "edit"}
                    selectedIds={batch.selectedTransactionIds}
                    onToggleSelection={batch.handleSelectTransaction}
                    isEditMode={filters.pageMode === "edit"}
                    pendingEditsMap={inline.pendingEdits}
                    onFieldChange={inline.handleInlineFieldChange}
                    allParties={inline.partyOptions}
                    allCategories={inline.categoryOptions}
                    allDepartments={inline.departmentOptions}
                    allLocations={inline.locationOptions}
                    isSmallScreen={isMobile}
                    allCollapsed={allCollapsed}
                    onAllCollapsedChange={setAllCollapsed}
                    currency={currency}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Account summary card (when account selected) */}
        {queries.selectedAccountInfo && (
          <AccountSummaryCard
            accountName={queries.selectedAccountInfo?.name ?? ""}
            accountNumber={queries.selectedAccountInfo?.accountNumber ?? ""}
            accountType={queries.selectedAccountInfo?.accountType ?? ""}
            balance={queries.selectedAccountBalance?.balance ?? "0"}
            transactionCount={queries.selectedAccountBalance?.count ?? 0}
            currency={currency}
          />
        )}
      </div>

      {/* Match Confirm Modal */}
      {batch.matchModalIds && (
        <MatchConfirmModal
          transactions={
            batch.selectedTransactionsList
              .filter((t) => batch.matchModalIds!.includes(t.id))
              .slice(0, 2) as [any, any]
          }
          isLoading={batch.matchMutation.isPending}
          isPreviewing={batch.previewMatchMutation.isPending}
          onPreview={batch.handleMatchPreview}
          onConfirm={batch.handleMatchConfirm}
          onCancel={() => batch.setMatchModalIds(null)}
        />
      )}

      {/* Delete Confirm Modal */}
      {batch.deleteConfirmOpen && (
        <ConfirmModal
          title="Delete Transactions"
          message={`Are you sure you want to delete ${batch.selectedTransactionIds.size} transaction(s)? This action cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          isLoading={batch.deleteBatchMutation.isPending}
          onConfirm={batch.handleConfirmDelete}
          onCancel={() => batch.setDeleteConfirmOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Loading / empty copy for the list pane. Sized for the card list first — at 375px the filter
 * controls that produced an empty result are behind a toggle, so the escape hatch travels with
 * the message rather than living only in the toolbar.
 */
function LedgerStateMessage({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 px-4 py-12 text-center">
      <p className="max-w-prose text-sm text-slate-500 dark:text-slate-400">{children}</p>
      {action}
    </div>
  );
}
