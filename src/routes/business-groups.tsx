import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Buildings,
  ArrowClockwise,
  ArrowSquareOut,
  ArrowCounterClockwise,
  CaretRight,
  ChartLineUp,
  CheckCircle,
  CreditCard,
  CrownSimple,
  LockKey,
  GearSix,
  Plus,
  ShieldCheck,
  Trash,
  TrendDown,
  TrendUp,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  EntityReadinessBadge,
  EntityReadinessPanel,
} from "../components/business-groups/EntityReadinessPanel";
import { BusinessGroupAdminModal } from "../components/business-groups/BusinessGroupAdminModal";
import { IconButton } from "../components/ui/Actions";
import { Modal } from "../components/ui/Modal";
import { MultiCheckboxCombobox } from "../components/ui/MultiCheckboxCombobox";
import { PullToRefresh } from "../components/ui/PullToRefresh";
import { brand } from "../config/brand";
import { CURRENCIES } from "../lib/constants";
import { organization } from "../lib/auth-client";
import {
  establishOrganizationProfitLossDrilldown,
  portfolioProfitLossSearch,
} from "../lib/business-groups/drilldown";
import { moneyToCents } from "../lib/money";
import { keys } from "../lib/query-keys";
import {
  createOrganizationGroup,
  getBusinessGroupEntities,
  getBusinessGroupsPerformance,
  getBusinessGroupsLanding,
  getLinkableOrganizations,
  linkOrganizationToGroup,
  refreshBusinessGroupPerformance,
  restoreOrganizationGroup,
  unlinkOrganizationFromGroup,
} from "./api/-business-groups";
import {
  getEnterpriseBilling,
  openEnterpriseBillingPortal,
  startEnterpriseCheckout,
} from "./api/-enterprise-billing";

interface BusinessGroupsSearch {
  accountId?: string;
  groupIds?: string;
  /** Kept temporarily so existing bookmarked single-group URLs migrate cleanly. */
  groupId?: string;
  dateFrom?: string;
  dateTo?: string;
  compare?: "none" | "prior_period";
  page?: number;
  billing?: "success" | "cancelled";
}

function parseGroupIds(value?: string): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

function initialPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const last = new Date(year, now.getMonth() + 1, 0).getDate();
  return {
    dateFrom: `${year}-${month}-01`,
    dateTo: `${year}-${month}-${String(last).padStart(2, "0")}`,
  };
}

export const Route = createFileRoute("/business-groups")({
  component: BusinessGroupsPage,
  validateSearch(search: Record<string, unknown>): BusinessGroupsSearch {
    const period = initialPeriod();
    return {
      accountId: typeof search.accountId === "string" ? search.accountId : undefined,
      groupIds: typeof search.groupIds === "string" ? search.groupIds : undefined,
      groupId: typeof search.groupId === "string" ? search.groupId : undefined,
      dateFrom: typeof search.dateFrom === "string" ? search.dateFrom : period.dateFrom,
      dateTo: typeof search.dateTo === "string" ? search.dateTo : period.dateTo,
      compare: search.compare === "none" ? "none" : "prior_period",
      billing:
        search.billing === "success" || search.billing === "cancelled" ? search.billing : undefined,
      page:
        typeof search.page === "number" && Number.isInteger(search.page) && search.page > 0
          ? search.page
          : 1,
    };
  },
});

function BusinessGroupsPage() {
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [organizationDrilldownId, setOrganizationDrilldownId] = useState<string | null>(null);
  const [organizationDrilldownError, setOrganizationDrilldownError] = useState<unknown>(null);
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const landing = useQuery({
    queryKey: keys.businessGroups.landing(),
    queryFn: () => getBusinessGroupsLanding(),
  });

  const accounts = landing.data?.accounts ?? [];
  const account =
    accounts.find((candidate) => candidate.id === search.accountId) ?? accounts[0] ?? null;
  const allGroups = account?.groups ?? [];
  const groups = allGroups.filter((candidate) => candidate.status === "active");
  const archivedGroups = allGroups.filter((candidate) => candidate.status === "archived");
  const requestedGroupIds = useMemo(
    () => parseGroupIds(search.groupIds ?? search.groupId),
    [search.groupId, search.groupIds],
  );
  const requestedGroupIdSet = useMemo(() => new Set(requestedGroupIds), [requestedGroupIds]);
  const requestedGroups = allGroups.filter((candidate) => requestedGroupIdSet.has(candidate.id));
  const archivedGroup =
    requestedGroups.length === 1 && requestedGroups[0].status === "archived"
      ? requestedGroups[0]
      : null;
  const requestedActiveGroups = requestedGroups.filter(
    (candidate) => candidate.status === "active",
  );
  const selectedGroups = archivedGroup
    ? []
    : requestedActiveGroups.length > 0
      ? requestedActiveGroups
      : groups;
  const selectedGroupIds = selectedGroups.map((group) => group.id);
  const selectedGroupIdsParam = archivedGroup?.id ?? selectedGroupIds.join(",");
  const singleGroup = selectedGroups.length === 1 ? selectedGroups[0] : null;
  const entitlement = account?.entitlement ?? null;
  const canRead =
    entitlement?.effectiveStatus === "active" || entitlement?.effectiveStatus === "grace";
  const canMutate = entitlement?.effectiveStatus === "active";
  const canManageEnterpriseGroups = account?.role === "owner" || account?.role === "group_admin";
  const canManageBilling = account?.role === "owner" || account?.role === "billing_admin";

  useEffect(() => {
    if (!account) return;
    if (
      search.accountId === account.id &&
      search.groupIds === (selectedGroupIdsParam || undefined) &&
      !search.groupId
    ) {
      return;
    }
    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        accountId: account.id,
        groupIds: selectedGroupIdsParam || undefined,
        groupId: undefined,
      }),
    });
  }, [account, navigate, search.accountId, search.groupId, search.groupIds, selectedGroupIdsParam]);

  const entities = useQuery({
    queryKey: keys.businessGroups.entities(singleGroup?.id ?? null),
    queryFn: () => getBusinessGroupEntities({ data: { groupId: singleGroup!.id } }),
    enabled: !!singleGroup && !!canRead,
  });
  const linkable = useQuery({
    queryKey: keys.businessGroups.linkable(singleGroup?.id ?? null),
    queryFn: () => getLinkableOrganizations({ data: { groupId: singleGroup!.id } }),
    enabled: !!singleGroup && !!canRead,
  });
  const performance = useQuery({
    queryKey: keys.businessGroups.portfolioPerformance(selectedGroupIds, {
      dateFrom: search.dateFrom,
      dateTo: search.dateTo,
      compare: search.compare,
      page: search.page,
    }),
    queryFn: () =>
      getBusinessGroupsPerformance({
        data: {
          groupIds: selectedGroupIds,
          dateFrom: search.dateFrom!,
          dateTo: search.dateTo!,
          compare: search.compare!,
          page: search.page ?? 1,
          pageSize: 25,
        },
      }),
    enabled: selectedGroupIds.length > 0 && !!canRead,
    refetchInterval: (query) => {
      const status = query.state.data?.projectionStatus;
      return status === "building" || status === "stale" ? 2_000 : false;
    },
  });
  useEffect(() => {
    if (!performance.data || performance.data.uniqueEntityCount === 0) return;
    const lastPage = Math.max(
      1,
      Math.ceil(performance.data.uniqueEntityCount / performance.data.pageSize),
    );
    if ((search.page ?? 1) <= lastPage) return;
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, page: lastPage }),
    });
  }, [navigate, performance.data, search.page]);
  const manualRefresh = useMutation({
    mutationFn: () => refreshBusinessGroupPerformance({ data: { groupIds: selectedGroupIds } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.businessGroups.all() });
    },
  });

  const refreshGroup = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.businessGroups.all() }),
      queryClient.invalidateQueries({ queryKey: keys.reports.all() }),
    ]);
  };
  const changePerformancePage = (page: number) => {
    void navigate({ search: (previous) => ({ ...previous, page }) });
  };
  const drilldownScope = (groupIds: readonly string[]) => ({
    accountId: account?.id ?? "",
    groupIds,
    dateFrom: search.dateFrom!,
    dateTo: search.dateTo!,
    compare: search.compare!,
  });
  const openPortfolioProfitLoss = (groupIds: readonly string[]) => {
    if (!account) return;
    void navigate({
      to: "/financials",
      search: portfolioProfitLossSearch(drilldownScope(groupIds)),
    });
  };
  const openOrganizationProfitLoss = async (organizationId: string) => {
    if (!account) return;
    setOrganizationDrilldownId(organizationId);
    setOrganizationDrilldownError(null);
    try {
      await establishOrganizationProfitLossDrilldown({
        organizationId,
        scope: drilldownScope(selectedGroupIds),
        setActiveOrganization: async (nextOrganizationId) => {
          const result = await organization.setActive({ organizationId: nextOrganizationId });
          return { error: result.error };
        },
        clearCachedQueries: () => queryClient.clear(),
        assignLocation: (path) => window.location.assign(path),
      });
    } catch (error) {
      setOrganizationDrilldownError(error);
      setOrganizationDrilldownId(null);
    }
  };

  if (landing.isLoading) return <PerformanceCenterSkeleton />;
  if (landing.isError) {
    return <PageError message={errorMessage(landing.error)} onRetry={() => landing.refetch()} />;
  }
  if (!landing.data?.hasEnterpriseAccount) return <EnterpriseUpgrade />;
  if (!account) return <EnterpriseUpgrade />;

  return (
    <PullToRefresh
      disabled={!canRead || selectedGroupIds.length === 0 || manualRefresh.isPending}
      onRefresh={() => manualRefresh.mutateAsync()}
    >
      <main className="min-h-full bg-[#f6f8f7] text-slate-900 dark:bg-[#0b0f14] dark:text-slate-100">
        <header className="border-b border-slate-200 bg-white text-slate-950 dark:border-white/10 dark:bg-[#101820] dark:text-white">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-6 md:px-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
                <CrownSimple size={16} weight="fill" />
                Enterprise Performance Center
              </div>
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Business Groups</h1>
              <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-slate-600 dark:text-white/60">
                Compare profitability, cash, and operating performance across every business in your
                holding company.
              </p>
            </div>
            <div className="flex flex-col items-end gap-3">
              {canManageBilling && (
                <button
                  type="button"
                  onClick={() => setBillingOpen(true)}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-white/70 dark:hover:border-emerald-300 dark:hover:text-emerald-200"
                >
                  <CreditCard size={17} weight="duotone" />
                  Billing
                </button>
              )}
              <div className="hidden md:block">
                <IconButton
                  label={
                    manualRefresh.isPending
                      ? "Refreshing business group data"
                      : "Refresh business group data"
                  }
                  variant="secondary"
                  icon={
                    <ArrowClockwise
                      size={18}
                      weight="bold"
                      className={manualRefresh.isPending ? "animate-spin" : undefined}
                    />
                  }
                  onClick={() => manualRefresh.mutate()}
                  disabled={manualRefresh.isPending || selectedGroupIds.length === 0}
                  className="rounded-xl border-slate-200 bg-white/80 text-slate-600 hover:border-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-white/65 dark:hover:border-emerald-300 dark:hover:bg-emerald-400/10 dark:hover:text-emerald-200"
                />
              </div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 dark:border-white/10 dark:bg-white/10 sm:flex">
                <HeaderDatum
                  label="Linked businesses"
                  value={`${account.usage}/${entitlement?.includedEntityLimit ?? 0}`}
                />
                <HeaderDatum
                  label="Selected groups"
                  value={
                    archivedGroup ? "Archived" : `${selectedGroups.length}/${groups.length} active`
                  }
                />
                <HeaderDatum label="Access" value={statusLabel(entitlement?.effectiveStatus)} />
              </div>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8">
          {search.billing && (
            <BillingReturnNotice
              status={search.billing}
              onDismiss={() =>
                navigate({
                  replace: true,
                  search: (previous) => ({ ...previous, billing: undefined }),
                })
              }
            />
          )}
          {entitlement?.effectiveStatus === "grace" && (
            <GraceBanner effectiveUntil={entitlement.effectiveUntil} />
          )}
          {!canRead ? (
            <LockedEnterpriseAccount
              accountName={account.name}
              status={entitlement?.effectiveStatus}
            />
          ) : (
            <>
              <section className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-5 dark:border-white/10 lg:flex-row lg:items-end lg:justify-between">
                <div className="grid gap-3 sm:grid-cols-2">
                  {accounts.length > 1 && (
                    <Field label="Enterprise account">
                      <select
                        value={account.id}
                        onChange={(event) =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              accountId: event.target.value,
                              groupIds: undefined,
                              groupId: undefined,
                              page: 1,
                            }),
                          })
                        }
                        className={selectClass}
                      >
                        {accounts.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {groups.length > 0 && (
                    <div className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold text-slate-600 dark:text-white/55">
                        Business groups
                      </span>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                        <MultiCheckboxCombobox
                          ariaLabel="Select Business Groups"
                          value={selectedGroupIds}
                          options={groups.map((candidate) => ({
                            value: candidate.id,
                            label: candidate.name,
                            description: `${candidate.entityCount} linked ${candidate.entityCount === 1 ? "business" : "businesses"}`,
                          }))}
                          onChange={(groupIds) =>
                            navigate({
                              search: (previous) => ({
                                ...previous,
                                groupIds: groupIds.join(","),
                                groupId: undefined,
                                page: 1,
                              }),
                            })
                          }
                        />
                        {account.canCreateGroup && (
                          <button
                            type="button"
                            onClick={() => setCreateGroupOpen(true)}
                            disabled={!canMutate}
                            title={
                              canMutate
                                ? "Create another Business Group"
                                : "Group creation is unavailable during read-only access"
                            }
                            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15 dark:bg-[#0e141c] dark:text-white/70 dark:hover:border-emerald-400 dark:hover:text-emerald-300"
                          >
                            <Plus size={16} weight="bold" />
                            New group
                          </button>
                        )}
                        {canManageEnterpriseGroups &&
                          singleGroup &&
                          (singleGroup.role === "owner" || singleGroup.role === "admin") && (
                            <button
                              type="button"
                              onClick={() => setManageGroupOpen(true)}
                              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 active:scale-[0.98] dark:border-white/15 dark:bg-[#0e141c] dark:text-white/70 dark:hover:border-emerald-400 dark:hover:text-emerald-300"
                            >
                              <GearSix size={16} weight="bold" />
                              Manage
                            </button>
                          )}
                      </div>
                    </div>
                  )}
                  {archivedGroups.length > 0 && (
                    <Field label="Archived groups">
                      <select
                        value={archivedGroup?.id ?? ""}
                        onChange={(event) => {
                          if (!event.target.value) return;
                          void navigate({
                            search: (previous) => ({
                              ...previous,
                              groupIds: event.target.value,
                              groupId: undefined,
                              page: 1,
                            }),
                          });
                        }}
                        className={selectClass}
                      >
                        <option value="">Review an archived group</option>
                        {archivedGroups.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
                {selectedGroups.length > 0 && (
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <Field label="From">
                      <input
                        type="date"
                        value={search.dateFrom}
                        max={search.dateTo}
                        onChange={(event) =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              dateFrom: event.target.value,
                              page: 1,
                            }),
                          })
                        }
                        className={selectClass}
                      />
                    </Field>
                    <Field label="To">
                      <input
                        type="date"
                        value={search.dateTo}
                        min={search.dateFrom}
                        onChange={(event) =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              dateTo: event.target.value,
                              page: 1,
                            }),
                          })
                        }
                        className={selectClass}
                      />
                    </Field>
                    <Field label="Compare">
                      <select
                        aria-label="Compare performance"
                        value={search.compare}
                        onChange={(event) =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              compare: event.target.value as "none" | "prior_period",
                              page: 1,
                            }),
                          })
                        }
                        className={selectClass}
                      >
                        <option value="prior_period">Prior period</option>
                        <option value="none">No comparison</option>
                      </select>
                    </Field>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => openPortfolioProfitLoss(selectedGroupIds)}
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 active:scale-[0.98] dark:bg-emerald-600 dark:hover:bg-emerald-500"
                      >
                        <ChartLineUp size={17} weight="bold" />
                        Portfolio P&amp;L
                      </button>
                    </div>
                  </div>
                )}
              </section>
              {manualRefresh.isError && (
                <div className="mb-6">
                  <InlinePanelError message={errorMessage(manualRefresh.error)} />
                </div>
              )}
              {organizationDrilldownError && (
                <div className="mb-6">
                  <InlinePanelError message={errorMessage(organizationDrilldownError)} />
                </div>
              )}

              {archivedGroup ? (
                <ArchivedGroupPanel
                  group={archivedGroup}
                  canManage={
                    canManageEnterpriseGroups &&
                    (archivedGroup.role === "owner" || archivedGroup.role === "admin")
                  }
                  canRestore={
                    canMutate &&
                    canManageEnterpriseGroups &&
                    (archivedGroup.role === "owner" || archivedGroup.role === "admin")
                  }
                  onManage={() => setManageGroupOpen(true)}
                  onReturnToActive={() =>
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        groupIds: groups.map((group) => group.id).join(",") || undefined,
                        groupId: undefined,
                        page: 1,
                      }),
                    })
                  }
                  onRestored={refreshGroup}
                />
              ) : groups.length === 0 ? (
                <CreateFirstGroup
                  accountId={account.id}
                  disabled={!canMutate || !account.canCreateGroup}
                  onCreated={async (groupId) => {
                    await refreshGroup();
                    await navigate({
                      search: (previous) => ({
                        ...previous,
                        groupIds: groupId,
                        groupId: undefined,
                        accountId: account.id,
                      }),
                    });
                  }}
                />
              ) : singleGroup ? (
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,0.8fr)]">
                  <div className="min-w-0 space-y-6">
                    <PerformanceSummary
                      data={performance.data}
                      isLoading={performance.isLoading}
                      error={performance.error}
                    />
                    <EntityReadinessPanel
                      readiness={performance.data?.entityReadiness ?? []}
                      summary={performance.data?.entityReadinessSummary ?? null}
                      sourceMode={performance.data?.sourceMode ?? "live_ledger"}
                      onPageChange={
                        performance.data?.entities.length === 0 ? changePerformancePage : undefined
                      }
                    />
                    <EntityRanking
                      data={performance.data}
                      isLoading={performance.isLoading}
                      error={performance.error}
                      openingOrganizationId={organizationDrilldownId}
                      onOpenOrganization={openOrganizationProfitLoss}
                    />
                  </div>
                  <LinkedBusinessesPanel
                    group={singleGroup}
                    access={entities.data}
                    availableOrganizations={linkable.data ?? []}
                    isLoading={entities.isLoading || linkable.isLoading}
                    canMutate={
                      canMutate &&
                      canManageEnterpriseGroups &&
                      (singleGroup.role === "owner" || singleGroup.role === "admin")
                    }
                    canReduceAccess={
                      canManageEnterpriseGroups &&
                      (singleGroup.role === "owner" || singleGroup.role === "admin")
                    }
                    onChanged={refreshGroup}
                  />
                </div>
              ) : (
                <div className="space-y-6">
                  <PerformanceSummary
                    data={performance.data}
                    isLoading={performance.isLoading}
                    error={performance.error}
                  />
                  <EntityReadinessPanel
                    readiness={performance.data?.entityReadiness ?? []}
                    summary={performance.data?.entityReadinessSummary ?? null}
                    sourceMode={performance.data?.sourceMode ?? "live_ledger"}
                    onPageChange={
                      performance.data?.entities.length === 0 ? changePerformancePage : undefined
                    }
                  />
                  <GroupBreakdown
                    data={performance.data}
                    isLoading={performance.isLoading}
                    error={performance.error}
                    onOpenGroup={(groupId) => openPortfolioProfitLoss([groupId])}
                  />
                  <EntityRanking
                    data={performance.data}
                    isLoading={performance.isLoading}
                    error={performance.error}
                    openingOrganizationId={organizationDrilldownId}
                    onOpenOrganization={openOrganizationProfitLoss}
                  />
                </div>
              )}
              {groups.length > 0 && account.canCreateGroup && (
                <CreateGroupModal
                  open={createGroupOpen}
                  accountId={account.id}
                  disabled={!canMutate}
                  onClose={() => setCreateGroupOpen(false)}
                  onCreated={async (groupId) => {
                    setCreateGroupOpen(false);
                    await refreshGroup();
                    await navigate({
                      search: (previous) => ({
                        ...previous,
                        accountId: account.id,
                        groupIds: groupId,
                        groupId: undefined,
                      }),
                    });
                  }}
                />
              )}
              {(singleGroup || archivedGroup) &&
                canManageEnterpriseGroups &&
                ((singleGroup ?? archivedGroup)!.role === "owner" ||
                  (singleGroup ?? archivedGroup)!.role === "admin") && (
                  <BusinessGroupAdminModal
                    group={(singleGroup ?? archivedGroup)!}
                    open={manageGroupOpen}
                    canMutate={canMutate && (singleGroup ?? archivedGroup)!.status === "active"}
                    canReduceAccess
                    onClose={() => setManageGroupOpen(false)}
                    onChanged={refreshGroup}
                    onArchived={async () => {
                      setManageGroupOpen(false);
                      await refreshGroup();
                    }}
                  />
                )}
            </>
          )}
        </div>
        {canManageBilling && (
          <EnterpriseBillingModal
            open={billingOpen}
            onClose={() => setBillingOpen(false)}
            enterpriseAccountId={account.id}
            minimumQuantity={Math.max(1, account.usage, entitlement?.includedEntityLimit ?? 1)}
          />
        )}
      </main>
    </PullToRefresh>
  );
}

function HeaderDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-36 bg-slate-50 px-4 py-3 dark:bg-white/[0.04]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-white/40">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{value}</div>
    </div>
  );
}

export function BillingReturnNotice({
  status,
  onDismiss,
}: {
  status: "success" | "cancelled";
  onDismiss: () => void;
}) {
  const succeeded = status === "success";
  return (
    <div
      className={`mb-6 flex items-start justify-between gap-4 rounded-xl border px-4 py-3 ${
        succeeded
          ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
          : "border-slate-200 bg-white text-slate-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-white/75"
      }`}
      role="status"
    >
      <div className="flex items-start gap-3">
        {succeeded ? (
          <ArrowClockwise size={20} weight="bold" className="mt-0.5 shrink-0 text-amber-700" />
        ) : (
          <CreditCard size={20} weight="duotone" className="mt-0.5 shrink-0" />
        )}
        <div>
          <p className="text-sm font-semibold">
            {succeeded ? "Checkout returned for verification" : "Checkout cancelled"}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed opacity-75">
            {succeeded
              ? "No subscription change is trusted yet. We are waiting for verified Stripe events before updating the allowance."
              : "No billing change was made. You can resume checkout from Billing."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      >
        Dismiss
      </button>
    </div>
  );
}

function EnterpriseBillingModal({
  open,
  onClose,
  enterpriseAccountId,
  minimumQuantity,
}: {
  open: boolean;
  onClose: () => void;
  enterpriseAccountId: string;
  minimumQuantity: number;
}) {
  const [quantity, setQuantity] = useState(minimumQuantity);
  const overview = useQuery({
    queryKey: ["enterprise-billing", enterpriseAccountId],
    queryFn: () => getEnterpriseBilling({ data: { enterpriseAccountId } }),
    enabled: open,
  });
  useEffect(() => setQuantity(minimumQuantity), [enterpriseAccountId, minimumQuantity]);

  const checkout = useMutation({
    mutationFn: () =>
      startEnterpriseCheckout({
        data: { enterpriseAccountId, quantity },
      }),
    onSuccess: (result) => window.location.assign(result.url),
  });
  const portal = useMutation({
    mutationFn: () => openEnterpriseBillingPortal({ data: { enterpriseAccountId } }),
    onSuccess: (result) => window.location.assign(result.url),
  });
  const pending = checkout.isPending || portal.isPending;
  const mutationError = checkout.error ?? portal.error;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enterprise billing"
      description="Subscription quantity controls the linked-business allowance."
      mobile="sheet"
      size="sm"
      closeOnBackdrop={!pending}
    >
      {overview.isLoading ? (
        <div className="h-28 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" />
      ) : overview.isError || !overview.data ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
          Billing details are unavailable. Check your Enterprise billing role and try again.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="text-sm font-semibold text-slate-900 dark:text-white">
              {overview.data.accountName}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-slate-500 dark:text-white/45">Managed by</dt>
                <dd className="mt-1 font-semibold capitalize text-slate-800 dark:text-white/80">
                  {overview.data.management === "none"
                    ? "Not subscribed"
                    : overview.data.management}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-white/45">Allowance</dt>
                <dd className="mt-1 font-semibold text-slate-800 dark:text-white/80">
                  {overview.data.quantity ?? "—"}
                </dd>
              </div>
              {overview.data.providerStatus && (
                <div>
                  <dt className="text-slate-500 dark:text-white/45">Stripe status</dt>
                  <dd className="mt-1 font-semibold capitalize text-slate-800 dark:text-white/80">
                    {overview.data.providerStatus.replaceAll("_", " ")}
                  </dd>
                </div>
              )}
              {overview.data.currentPeriodEnd && (
                <div>
                  <dt className="text-slate-500 dark:text-white/45">Current period ends</dt>
                  <dd className="mt-1 font-semibold text-slate-800 dark:text-white/80">
                    {formatDate(overview.data.currentPeriodEnd)}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {overview.data.canStartCheckout && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-700 dark:text-white/65">
                Linked-business allowance
              </span>
              <input
                type="number"
                min={minimumQuantity}
                max={1000}
                step={1}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
                className={inputClass}
              />
              <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-500 dark:text-white/40">
                The allowance cannot start below the {minimumQuantity} currently linked business
                {minimumQuantity === 1 ? "" : "es"}.
              </span>
            </label>
          )}

          {mutationError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
              {errorMessage(mutationError)}
            </div>
          )}

          {overview.data.management === "manual" && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
              This contract is managed manually. Contact support to migrate it before using Stripe
              self-service billing.
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
            >
              Close
            </button>
            {overview.data.canOpenPortal && (
              <button
                type="button"
                onClick={() => portal.mutate()}
                disabled={pending}
                className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:opacity-50"
              >
                {portal.isPending ? "Opening…" : "Manage in Stripe"}
              </button>
            )}
            {overview.data.canStartCheckout && (
              <button
                type="button"
                onClick={() => checkout.mutate()}
                disabled={
                  pending ||
                  !Number.isInteger(quantity) ||
                  quantity < minimumQuantity ||
                  quantity > 1000
                }
                className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:opacity-50"
              >
                {checkout.isPending ? "Opening…" : "Continue to Stripe"}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function EnterpriseUpgrade() {
  return (
    <main className="min-h-full bg-[#f4f7f5] px-4 py-10 dark:bg-[#0b0f14] md:px-8 md:py-16">
      <div className="mx-auto grid max-w-6xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-[0_24px_70px_-40px_rgba(16,36,26,0.4)] dark:border-white/10 dark:bg-[#111820] lg:grid-cols-[1.2fr_0.8fr]">
        <section className="p-7 md:p-12 lg:p-16">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300">
            <CrownSimple size={15} weight="fill" />
            Enterprise capability
          </div>
          <h1 className="max-w-xl text-3xl font-semibold tracking-tight text-slate-950 dark:text-white md:text-5xl md:leading-[1.04]">
            See which businesses are creating value—and which need attention.
          </h1>
          <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-slate-600 dark:text-white/55">
            Business Groups gives holding companies a shared performance view while every subsidiary
            keeps its own books, members, and accounting controls.
          </p>
          <a
            href={`mailto:${brand.supportEmail}?subject=${encodeURIComponent("Enterprise Business Groups")}`}
            className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white no-underline transition duration-200 hover:bg-emerald-800 active:scale-[0.98] dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            Contact us about Enterprise
            <CaretRight size={17} weight="bold" />
          </a>
        </section>
        <aside className="border-t border-slate-200 bg-[#10241a] p-7 text-white dark:border-white/10 md:p-10 lg:border-t-0 lg:border-l">
          <div className="flex h-full flex-col justify-between gap-12">
            <div>
              <Buildings size={38} weight="duotone" className="text-emerald-300" />
              <h2 className="mt-7 text-lg font-semibold">Built for multi-entity operators</h2>
              <div className="mt-6 divide-y divide-white/10 border-y border-white/10">
                <UpgradeFeature
                  icon={<ChartLineUp size={20} />}
                  text="Profitability rankings and period trends"
                />
                <UpgradeFeature
                  icon={<Buildings size={20} />}
                  text="Flat portfolios with combined group reporting"
                />
                <UpgradeFeature
                  icon={<ShieldCheck size={20} />}
                  text="Direct subsidiary access remains required"
                />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-white/45">
              Enterprise access is activated through a contract with a linked-business allowance
              sized for your organization.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function UpgradeFeature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 py-4 text-sm text-white/75">
      <span className="text-emerald-300">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

function GraceBanner({ effectiveUntil }: { effectiveUntil: Date | string | null }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
      <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-amber-600" />
      <div>
        <p className="text-sm font-semibold">Enterprise access is in read-only grace</p>
        <p className="mt-0.5 text-xs leading-relaxed opacity-75">
          Reports remain current, but group changes are disabled through{" "}
          {formatDate(effectiveUntil)}.
        </p>
      </div>
    </div>
  );
}

function LockedEnterpriseAccount({
  accountName,
  status,
}: {
  accountName: string;
  status?: string;
}) {
  return (
    <section className="mx-auto max-w-3xl py-14 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-200 text-slate-600 dark:bg-white/10 dark:text-white/60">
        <LockKey size={27} weight="duotone" />
      </div>
      <h2 className="mt-5 text-xl font-semibold">
        Business Groups is {statusLabel(status).toLowerCase()}
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600 dark:text-white/50">
        {accountName}&apos;s groups and reporting data are retained. Contact your account
        representative to activate or renew Enterprise access.
      </p>
      <a
        href={`mailto:${brand.supportEmail}?subject=${encodeURIComponent(`Enterprise access for ${accountName}`)}`}
        className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white no-underline transition hover:bg-emerald-800 active:scale-[0.98]"
      >
        Contact support
      </a>
    </section>
  );
}

function ArchivedGroupPanel({
  group,
  canManage,
  canRestore,
  onManage,
  onReturnToActive,
  onRestored,
}: {
  group: { id: string; name: string; updatedAt: Date | string };
  canManage: boolean;
  canRestore: boolean;
  onManage: () => void;
  onReturnToActive: () => void | Promise<void>;
  onRestored: () => Promise<void>;
}) {
  const restoreMutation = useMutation({
    mutationFn: () => restoreOrganizationGroup({ data: { groupId: group.id } }),
    onSuccess: onRestored,
  });

  return (
    <section className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-amber-200 bg-white dark:border-amber-400/20 dark:bg-[#111820]">
      <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-start">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
          <Archive size={25} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
            Archived Business Group
          </p>
          <h2 className="mt-1 text-xl font-semibold">{group.name}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-white/50">
            This historical group is read-only. Its former business assignments remain disabled,
            while its members and audit history are retained. Restoring it creates an empty active
            group so businesses can be linked without assignment conflicts.
          </p>
          <p className="mt-2 text-xs text-slate-400">
            Last changed {new Date(group.updatedAt).toLocaleString()}
          </p>
          {restoreMutation.isError && <InlineError message={errorMessage(restoreMutation.error)} />}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={onReturnToActive} className={secondaryButtonClass}>
              Return to active groups
            </button>
            {canManage && (
              <button type="button" onClick={onManage} className={secondaryButtonClass}>
                <GearSix size={16} weight="bold" /> Review members
              </button>
            )}
            {canRestore && (
              <button
                type="button"
                onClick={() => restoreMutation.mutate()}
                disabled={restoreMutation.isPending}
                className={primaryButtonClass}
              >
                <ArrowCounterClockwise size={16} weight="bold" />
                {restoreMutation.isPending ? "Restoring…" : "Restore empty group"}
              </button>
            )}
          </div>
          {!canRestore && canManage && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              Active Enterprise access is required to restore this group.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function CreateFirstGroup({
  accountId,
  disabled,
  onCreated,
}: {
  accountId: string;
  disabled: boolean;
  onCreated: (groupId: string) => Promise<void>;
}) {
  return (
    <section className="mx-auto grid max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111820] md:grid-cols-[0.8fr_1.2fr]">
      <div className="bg-emerald-950 p-8 text-white">
        <Buildings size={36} weight="duotone" className="text-emerald-300" />
        <h2 className="mt-6 text-xl font-semibold">Create the holding-company view</h2>
        <p className="mt-3 text-sm leading-relaxed text-white/55">
          Start with one reporting group, then link the businesses that should be compared as one
          portfolio.
        </p>
      </div>
      <CreateGroupForm
        accountId={accountId}
        disabled={disabled}
        onCreated={onCreated}
        className="p-8"
      />
    </section>
  );
}

function CreateGroupModal({
  open,
  accountId,
  disabled,
  onClose,
  onCreated,
}: {
  open: boolean;
  accountId: string;
  disabled: boolean;
  onClose: () => void;
  onCreated: (groupId: string) => Promise<void>;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Business Group"
      description="Add another reporting portfolio without moving or duplicating organization books."
      mobile="fullscreen"
      size="md"
      closeOnBackdrop={false}
    >
      <CreateGroupForm
        accountId={accountId}
        disabled={disabled}
        onCreated={onCreated}
        className="p-5 sm:p-6"
      />
    </Modal>
  );
}

function CreateGroupForm({
  accountId,
  disabled,
  onCreated,
  className,
}: {
  accountId: string;
  disabled: boolean;
  onCreated: (groupId: string) => Promise<void>;
  className: string;
}) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const mutation = useMutation({
    mutationFn: () =>
      createOrganizationGroup({
        data: {
          enterpriseAccountId: accountId,
          name,
          reportingTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          defaultReportingCurrency: currency,
        },
      }),
    onSuccess: (created) => onCreated(created.id),
  });

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <Field label="Business group name" helper="Usually the holding company or portfolio name.">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Holding company"
          minLength={2}
          maxLength={255}
          required
          disabled={disabled || mutation.isPending}
          className={inputClass}
        />
      </Field>
      <div className="mt-4">
        <Field
          label="Reporting currency"
          helper="Combined totals are shown only when linked businesses use this same currency."
        >
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            disabled={disabled || mutation.isPending}
            className={selectClass}
          >
            {CURRENCIES.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500 dark:bg-white/[0.04] dark:text-white/45">
        A business can belong to only one active group in this Enterprise account. Creating this
        group does not change any organization ledger or membership.
      </p>
      {disabled && (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          Active Enterprise owner or group-admin access is required to create a group.
        </p>
      )}
      {mutation.isError && <InlineError message={errorMessage(mutation.error)} />}
      <button
        type="submit"
        disabled={disabled || mutation.isPending || name.trim().length < 2}
        className={primaryButtonClass}
      >
        <Plus size={17} weight="bold" />
        {mutation.isPending ? "Creating…" : "Create Business Group"}
      </button>
    </form>
  );
}

function PerformanceSummary({ data, isLoading, error }: ReportSectionProps) {
  if (isLoading) return <MetricSkeleton />;
  if (error) return <InlinePanelError message={errorMessage(error)} />;
  if (!data) return <NoEntitiesPrompt />;
  if (data.incompleteEntityCount > 0 && data.sourceMode === "projected") {
    return <ProjectionReadiness data={data} />;
  }
  if (data.entities.length === 0) return <NoEntitiesPrompt />;

  const aggregate = data.aggregate;
  if (!aggregate) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/10 dark:bg-[#111820]">
        <div className="flex items-start gap-3">
          <WarningCircle size={22} className="mt-0.5 shrink-0 text-amber-600" weight="duotone" />
          <div>
            <h2 className="text-base font-semibold">Combined totals are unavailable</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-white/50">
              The selected businesses contain multiple functional currencies. Individual group and
              business results remain available below without adding unlike currencies together.
            </p>
          </div>
        </div>
        <Warnings warnings={data.warnings} />
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111820]">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/10">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {data.selectedGroupCount > 1
              ? "Combined performance"
              : `${data.groups[0]?.groupName ?? "Group"} performance`}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-white/40">
            {data.dateFrom} to {data.dateTo} · {data.selectedGroupCount} selected
            {data.selectedGroupCount === 1 ? " group" : " groups"} · {data.uniqueEntityCount} unique
            {data.uniqueEntityCount === 1 ? " business" : " businesses"}
          </p>
        </div>
        <SourceBadge data={data} />
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 dark:divide-white/10 md:grid-cols-5 md:divide-y-0">
        <Metric label="Revenue" value={money(aggregate.revenue, aggregate.currency)} />
        <Metric
          label="Gross profit"
          value={money(aggregate.grossProfit, aggregate.currency)}
          sub={pct(aggregate.grossMargin)}
        />
        <Metric
          label="Operating income"
          value={money(aggregate.operatingIncome, aggregate.currency)}
          sub={pct(aggregate.operatingMargin)}
        />
        <Metric
          label="Net income"
          value={money(aggregate.netIncome, aggregate.currency)}
          sub={pct(aggregate.netMargin)}
          tone={isNonNegativeMoney(aggregate.netIncome) ? "positive" : "negative"}
        />
        <Metric label="Cash" value={money(aggregate.cash, aggregate.currency)} />
      </div>
      <Warnings warnings={data.warnings} />
    </section>
  );
}

function SourceBadge({ data }: { data: PerformanceData }) {
  const projected = data.sourceMode === "projected";
  const label =
    data.sourceMode === "live_ledger"
      ? "Live ledger"
      : data.sourceMode === "shadow"
        ? "Live + projection check"
        : data.projectionStatus === "stale"
          ? "Projection delayed"
          : "Projected · current";
  return (
    <span
      title={
        projected && data.projectionAsOf
          ? `Oldest selected business updated ${new Date(data.projectionAsOf).toLocaleString()}`
          : undefined
      }
      className={`inline-flex shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none ${
        data.projectionStatus === "stale"
          ? "bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
          : "bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300"
      }`}
    >
      <CheckCircle size={14} weight="fill" /> {label}
    </span>
  );
}

function ProjectionReadiness({ data }: { data: PerformanceData }) {
  const failed = data.projectionStatus === "failed";
  const stale = data.projectionStatus === "stale";
  return (
    <section
      className={`overflow-hidden rounded-2xl border bg-white dark:bg-[#111820] ${
        failed
          ? "border-rose-200 dark:border-rose-400/20"
          : stale
            ? "border-amber-200 dark:border-amber-400/20"
            : "border-slate-200 dark:border-white/10"
      }`}
    >
      <div className="flex items-start gap-3 p-6">
        {failed ? (
          <WarningCircle size={24} weight="duotone" className="shrink-0 text-rose-600" />
        ) : (
          <ArrowClockwise
            size={24}
            weight="bold"
            className="shrink-0 text-emerald-700 motion-safe:animate-spin dark:text-emerald-400"
          />
        )}
        <div>
          <h2 className="text-base font-semibold">
            {failed ? "Financial data refresh failed" : "Preparing financial data"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-white/50">
            {failed
              ? "One or more businesses could not complete their projection. Use the page-header refresh action, or pull down on mobile, to retry; totals remain withheld so incomplete facts are never presented as zero."
              : `${data.incompleteEntityCount} ${data.incompleteEntityCount === 1 ? "business is" : "businesses are"} still syncing. This page checks again automatically, and totals appear only when the selected portfolio is complete.`}
          </p>
          {data.projectionSyncAgeSeconds !== null && data.projectionSyncAgeSeconds > 300 && (
            <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
              The oldest request or worker activity is{" "}
              {Math.ceil(data.projectionSyncAgeSeconds / 60)}
              minutes old.
            </p>
          )}
          {data.projectionLagSeconds !== null && data.projectionLagSeconds > 0 && (
            <p className="mt-1 text-xs text-slate-500 dark:text-white/45">
              The largest ledger-to-projection gap is {Math.ceil(data.projectionLagSeconds / 60)}
              minutes.
            </p>
          )}
        </div>
      </div>
      <Warnings warnings={data.warnings} />
    </section>
  );
}

function GroupBreakdown({
  data,
  isLoading,
  error,
  onOpenGroup,
}: ReportSectionProps & { onOpenGroup: (groupId: string) => void }) {
  if (isLoading) return <RankingSkeleton />;
  if (error || !data || data.groups.length < 2) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111820]">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10">
        <h2 className="text-sm font-semibold">Group comparison</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-white/40">
          Each group remains separate while the summary above combines its unique businesses.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-200 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:border-white/10 dark:text-white/35">
              <th className="px-5 py-3">Business group</th>
              <th className="px-4 py-3 text-right">Businesses</th>
              <th className="px-4 py-3 text-right">Revenue</th>
              <th className="px-4 py-3 text-right">Net income</th>
              <th className="px-4 py-3 text-right">Net margin</th>
              <th className="px-5 py-3 text-right">Cash</th>
              <th className="px-5 py-3 text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {data.groups.map((group) => {
              const aggregate = group.aggregate;
              return (
                <tr
                  key={group.groupId}
                  className="transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.03]"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-start gap-2.5">
                      <Buildings
                        size={17}
                        weight="duotone"
                        className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
                      />
                      <div>
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">
                          {group.groupName}
                        </p>
                        {group.warnings.length > 0 && (
                          <p
                            className="mt-0.5 max-w-sm text-[11px] text-amber-700 dark:text-amber-300"
                            title={group.warnings.join(" ")}
                          >
                            Partial or mixed-currency result
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right font-mono text-sm text-slate-700 dark:text-white/70">
                    {group.accessibleEntityCount}/{group.totalEntityCount}
                  </td>
                  <NumberCell
                    value={
                      aggregate ? money(aggregate.revenue, aggregate.currency) : "Not combined"
                    }
                  />
                  <NumberCell
                    value={aggregate ? money(aggregate.netIncome, aggregate.currency) : "—"}
                    tone={
                      !aggregate
                        ? undefined
                        : isNonNegativeMoney(aggregate.netIncome)
                          ? "positive"
                          : "negative"
                    }
                  />
                  <NumberCell value={aggregate ? pct(aggregate.netMargin) : "—"} />
                  <NumberCell value={aggregate ? money(aggregate.cash, aggregate.currency) : "—"} />
                  <td className="px-5 py-4 text-right">
                    <button
                      type="button"
                      onClick={() => onOpenGroup(group.groupId)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 transition hover:border-emerald-600 hover:text-emerald-800 dark:border-white/10 dark:text-white/60 dark:hover:border-emerald-400 dark:hover:text-emerald-300"
                    >
                      Open <ArrowSquareOut size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  return (
    <div className="min-w-0 p-4 md:p-5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-white/35">
        {label}
      </div>
      <div
        className={`mt-2 truncate font-mono text-lg font-semibold tracking-tight ${
          tone === "positive"
            ? "text-emerald-700 dark:text-emerald-400"
            : tone === "negative"
              ? "text-rose-700 dark:text-rose-400"
              : "text-slate-950 dark:text-white"
        }`}
        title={value}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500 dark:text-white/40">{sub}</div>}
    </div>
  );
}

function EntityRanking({
  data,
  isLoading,
  error,
  openingOrganizationId,
  onOpenOrganization,
}: ReportSectionProps & {
  openingOrganizationId: string | null;
  onOpenOrganization: (organizationId: string) => Promise<void>;
}) {
  const navigate = Route.useNavigate();
  const readinessByOrganization = useMemo(
    () => new Map(data?.entityReadiness.map((entry) => [entry.organizationId, entry]) ?? []),
    [data?.entityReadiness],
  );
  if (isLoading) return <RankingSkeleton />;
  if (error || !data || data.entities.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111820]">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10">
        <h2 className="text-sm font-semibold">
          {data.selectedGroupCount > 1 ? "Business performance" : "Profitability ranking"}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-white/40">
          {data.selectedGroupCount > 1
            ? "Unique businesses across the selected groups, ranked by net income"
            : "Ranked by net income for the selected period"}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-200 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:border-white/10 dark:text-white/35">
              <th className="px-5 py-3">Business</th>
              {data.selectedGroupCount > 1 && <th className="px-4 py-3">Business group</th>}
              <th className="px-4 py-3 text-right">Revenue</th>
              <th className="px-4 py-3 text-right">Gross margin</th>
              <th className="px-4 py-3 text-right">Net income</th>
              <th className="px-5 py-3 text-right">Net margin</th>
              <th className="px-5 py-3 text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {data.entities.map((entity, index) => (
              <tr
                key={entity.organizationId}
                className="transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.03]"
              >
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="w-5 font-mono text-xs text-slate-400">
                      {String((data.page - 1) * data.pageSize + index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={`h-2 w-2 rounded-full ${entity.profitable ? "bg-emerald-500" : "bg-rose-500"}`}
                    />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">
                          {entity.name}
                        </div>
                        <EntityReadinessBadge
                          readiness={readinessByOrganization.get(entity.organizationId)}
                        />
                      </div>
                      {data.compare === "prior_period" && (
                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400">
                          {entity.revenueChangePct === null ? null : entity.revenueChangePct >=
                            0 ? (
                            <TrendUp size={13} />
                          ) : (
                            <TrendDown size={13} />
                          )}
                          {entity.revenueChangePct === null
                            ? "No prior activity"
                            : `${pct(entity.revenueChangePct)} revenue`}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                {data.selectedGroupCount > 1 && (
                  <td className="max-w-56 px-4 py-4 text-xs text-slate-500 dark:text-white/45">
                    <span className="line-clamp-2">{entity.groupNames.join(", ")}</span>
                  </td>
                )}
                <NumberCell value={money(entity.revenue, entity.currency)} />
                <NumberCell value={pct(entity.grossMargin)} />
                <NumberCell
                  value={money(entity.netIncome, entity.currency)}
                  tone={isNonNegativeMoney(entity.netIncome) ? "positive" : "negative"}
                />
                <NumberCell value={pct(entity.netMargin)} />
                <td className="px-5 py-4 text-right">
                  <button
                    type="button"
                    disabled={openingOrganizationId !== null}
                    onClick={() => void onOpenOrganization(entity.organizationId)}
                    title={`Open ${entity.name} Profit & Loss after changing the active business`}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 transition hover:border-emerald-600 hover:text-emerald-800 disabled:cursor-wait disabled:opacity-45 dark:border-white/10 dark:text-white/60 dark:hover:border-emerald-400 dark:hover:text-emerald-300"
                  >
                    {openingOrganizationId === entity.organizationId ? "Opening…" : "Open"}
                    <ArrowSquareOut size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.uniqueEntityCount > data.pageSize && (
        <div className="flex items-center justify-between gap-4 border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <p className="text-xs text-slate-500 dark:text-white/40">
            Page {data.page} of {Math.ceil(data.uniqueEntityCount / data.pageSize)} ·{" "}
            {data.uniqueEntityCount} businesses
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={data.page <= 1}
              onClick={() =>
                navigate({
                  search: (previous) => ({ ...previous, page: Math.max(1, data.page - 1) }),
                })
              }
              className={paginationButtonClass}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={data.page * data.pageSize >= data.uniqueEntityCount}
              onClick={() =>
                navigate({ search: (previous) => ({ ...previous, page: data.page + 1 }) })
              }
              className={paginationButtonClass}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function NumberCell({ value, tone }: { value: string; tone?: "positive" | "negative" }) {
  return (
    <td
      className={`px-4 py-4 text-right font-mono text-sm font-medium tabular-nums ${
        tone === "positive"
          ? "text-emerald-700 dark:text-emerald-400"
          : tone === "negative"
            ? "text-rose-700 dark:text-rose-400"
            : "text-slate-700 dark:text-white/75"
      }`}
    >
      {value}
    </td>
  );
}

function LinkedBusinessesPanel({
  group,
  access,
  availableOrganizations,
  isLoading,
  canMutate,
  canReduceAccess,
  onChanged,
}: {
  group: { id: string; name: string; role: string };
  access?: Awaited<ReturnType<typeof getBusinessGroupEntities>>;
  availableOrganizations: Awaited<ReturnType<typeof getLinkableOrganizations>>;
  isLoading: boolean;
  canMutate: boolean;
  canReduceAccess: boolean;
  onChanged: () => Promise<void>;
}) {
  const [organizationId, setOrganizationId] = useState("");
  const unlinked = availableOrganizations.filter((candidate) => !candidate.linked);
  const rows = access?.entities ?? [];
  const linkMutation = useMutation({
    mutationFn: () =>
      linkOrganizationToGroup({
        data: {
          groupId: group.id,
          organizationId,
        },
      }),
    onSuccess: async () => {
      setOrganizationId("");
      await onChanged();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (entityId: string) =>
      unlinkOrganizationFromGroup({ data: { groupId: group.id, entityId } }),
    onSuccess: onChanged,
  });
  const mutationError = linkMutation.error ?? removeMutation.error;

  return (
    <aside className="self-start overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111820] xl:sticky xl:top-6">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Linked businesses</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-white/40">{group.name}</p>
          </div>
          <Buildings
            size={22}
            weight="duotone"
            className="text-emerald-700 dark:text-emerald-400"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-11 animate-pulse rounded-lg bg-slate-100 dark:bg-white/[0.06]"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <Buildings size={30} weight="duotone" className="mx-auto text-slate-400" />
          <p className="mt-3 text-sm font-semibold">No businesses linked</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-white/40">
            Link an organization you own or administer to begin comparing performance.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
          {rows.map((entity) => (
            <div key={entity.id} className="group px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/45">
                  <Buildings size={15} weight="duotone" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">{entity.name}</p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">
                    {entity.currency}
                  </p>
                </div>
                {canReduceAccess && (
                  <button
                    type="button"
                    title={`Remove ${entity.name}`}
                    aria-label={`Remove ${entity.name}`}
                    disabled={removeMutation.isPending}
                    onClick={() => removeMutation.mutate(entity.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 active:scale-[0.96] group-hover:opacity-100 focus:opacity-100 dark:hover:bg-rose-400/10"
                  >
                    <Trash size={15} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {access && access.omittedEntityCount > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
          {access.omittedEntityCount} linked business
          {access.omittedEntityCount === 1 ? " is" : "es are"} hidden because you no longer have
          direct access.
        </div>
      )}

      {!canMutate && canReduceAccess && rows.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
          Read-only Enterprise access blocks new links, but you can still remove existing links.
        </div>
      )}

      <form
        className="border-t border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.025]"
        onSubmit={(event) => {
          event.preventDefault();
          linkMutation.mutate();
        }}
      >
        <Field label="Link a business">
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            disabled={!canMutate || linkMutation.isPending}
            className={selectClass}
          >
            <option value="">Choose an organization</option>
            {unlinked.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={!candidate.canLink}>
                {candidate.name}
                {candidate.canLink
                  ? ""
                  : candidate.linkedElsewhere
                    ? " — assigned to another group"
                    : " — admin required"}
              </option>
            ))}
          </select>
        </Field>
        {mutationError && <InlineError message={errorMessage(mutationError)} />}
        <button
          type="submit"
          disabled={!canMutate || !organizationId || linkMutation.isPending}
          className="mt-4 flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-emerald-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-700 dark:hover:bg-emerald-600"
        >
          <Plus size={15} weight="bold" />
          {linkMutation.isPending ? "Linking…" : "Link business"}
        </button>
      </form>
    </aside>
  );
}

type PerformanceData = Awaited<ReturnType<typeof getBusinessGroupsPerformance>>;
interface ReportSectionProps {
  data?: PerformanceData;
  isLoading: boolean;
  error: unknown;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="border-t border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
      {warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </div>
  );
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold text-slate-600 dark:text-white/55">
        {label}
      </span>
      {children}
      {helper && <span className="mt-1.5 block text-[11px] text-slate-400">{helper}</span>}
    </label>
  );
}

function NoEntitiesPrompt() {
  return (
    <section className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center dark:border-white/15 dark:bg-white/[0.02]">
      <div>
        <ChartLineUp size={34} weight="duotone" className="mx-auto text-slate-400" />
        <h2 className="mt-4 text-base font-semibold">
          Performance begins after the first business is linked
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-white/40">
          Use Linked businesses to connect an organization while keeping its ledger and access
          controls independent.
        </p>
      </div>
    </section>
  );
}

function InlineError({ message }: { message: string }) {
  return <p className="mt-3 text-xs font-medium text-rose-700 dark:text-rose-400">{message}</p>;
}

function InlinePanelError({ message }: { message: string }) {
  return (
    <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-900 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-100">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <WarningCircle size={18} weight="fill" />
        Unable to load performance
      </div>
      <p className="mt-1 text-xs opacity-75">{message}</p>
    </section>
  );
}

function PageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-[#f6f8f7] p-6 dark:bg-[#0b0f14]">
      <div className="max-w-md text-center">
        <WarningCircle size={38} weight="duotone" className="mx-auto text-rose-600" />
        <h1 className="mt-4 text-lg font-semibold dark:text-white">
          Business Groups could not load
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-white/45">{message}</p>
        <button type="button" onClick={onRetry} className={primaryButtonClass}>
          Try again
        </button>
      </div>
    </main>
  );
}

function PerformanceCenterSkeleton() {
  return (
    <main className="min-h-full animate-pulse bg-[#f6f8f7] dark:bg-[#0b0f14]">
      <div className="h-44 bg-[#10241a]" />
      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-8 md:px-8">
        <div className="h-14 rounded-xl bg-slate-200 dark:bg-white/[0.06]" />
        <MetricSkeleton />
        <RankingSkeleton />
      </div>
    </main>
  );
}

function MetricSkeleton() {
  return <div className="h-44 animate-pulse rounded-2xl bg-slate-200 dark:bg-white/[0.06]" />;
}

function RankingSkeleton() {
  return <div className="h-80 animate-pulse rounded-2xl bg-slate-200 dark:bg-white/[0.06]" />;
}

function statusLabel(status?: string) {
  if (!status) return "Not provisioned";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(value: Date | string | null) {
  if (!value) return "the contract renewal date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function money(value: string, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function isNonNegativeMoney(value: string): boolean {
  return moneyToCents(value) >= 0;
}

function pct(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

const inputClass =
  "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-[#0e141c] dark:text-white";
const selectClass = `${inputClass} min-w-40`;
const primaryButtonClass =
  "mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-5 text-sm font-semibold text-white transition hover:bg-emerald-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-600 dark:hover:bg-emerald-500";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 active:scale-[0.98] dark:border-white/10 dark:bg-white/[0.04] dark:text-white/70";
const paginationButtonClass =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:border-emerald-700 hover:text-emerald-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-[#0e141c] dark:text-white/70";
