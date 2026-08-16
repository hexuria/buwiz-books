export type BusinessGroupDrilldownComparison = "none" | "prior_period";

export interface BusinessGroupDrilldownScope {
  accountId: string;
  groupIds: readonly string[];
  dateFrom: string;
  dateTo: string;
  compare: BusinessGroupDrilldownComparison;
}

function normalizedGroupIds(groupIds: readonly string[]): string[] {
  return [...new Set(groupIds.map((groupId) => groupId.trim()).filter(Boolean))];
}

export function portfolioProfitLossSearch(scope: BusinessGroupDrilldownScope) {
  return {
    tab: "profit-loss" as const,
    scope: "portfolio" as const,
    accountId: scope.accountId,
    groupIds: normalizedGroupIds(scope.groupIds).join(","),
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    compare: scope.compare,
    fromBusinessGroups: true,
  };
}

export function businessGroupsReturnSearch(scope: BusinessGroupDrilldownScope) {
  return {
    accountId: scope.accountId,
    groupIds: normalizedGroupIds(scope.groupIds).join(","),
    groupId: undefined,
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    compare: scope.compare,
    page: 1,
  };
}

/**
 * The organization ID is deliberately absent. Organization-scoped reports
 * derive their tenant from the authenticated session after Better Auth accepts
 * the active-organization switch.
 */
export function organizationProfitLossPath(scope: BusinessGroupDrilldownScope): string {
  const search = new URLSearchParams({
    tab: "profit-loss",
    scope: "organization",
    accountId: scope.accountId,
    groupIds: normalizedGroupIds(scope.groupIds).join(","),
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    compare: scope.compare,
    fromBusinessGroups: "true",
  });
  return `/financials?${search.toString()}`;
}

interface OrganizationSwitchResult {
  error?: unknown;
}

export async function establishOrganizationProfitLossDrilldown(input: {
  organizationId: string;
  scope: BusinessGroupDrilldownScope;
  setActiveOrganization: (organizationId: string) => Promise<OrganizationSwitchResult>;
  clearCachedQueries: () => void;
  assignLocation: (path: string) => void;
}): Promise<void> {
  const organizationId = input.organizationId.trim();
  if (!organizationId) throw new Error("A business is required for this report");

  const result = await input.setActiveOrganization(organizationId);
  if (result.error) {
    throw new Error("Your active business could not be changed. Check your access and try again.");
  }

  input.clearCachedQueries();
  input.assignLocation(organizationProfitLossPath(input.scope));
}
