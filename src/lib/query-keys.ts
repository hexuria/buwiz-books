/**
 * Centralized TanStack Query key factory.
 *
 * Every query key and every invalidateQueries call should reference these builders instead of
 * inline string arrays. Benefits:
 *   - one source of truth (a typo can't silently split the cache)
 *   - hierarchical keys: invalidating `keys.invoices.all()` also invalidates every
 *     `keys.invoices.detail(id)` because TanStack matches by key prefix
 *   - refactors (renaming a namespace) happen in one place
 *
 * Usage:
 *   useQuery({ queryKey: keys.invoices.list(filters), queryFn: ... })
 *   queryClient.invalidateQueries({ queryKey: keys.invoices.all() })
 */

type Params = Record<string, unknown> | undefined;

export const keys = {
  parties: {
    all: () => ["parties"] as const,
    list: (type?: string, params?: Params) => ["parties", type ?? null, params ?? null] as const,
    detail: (id: string) => ["parties", "detail", id] as const,
    transactionSummary: (id: string) => ["parties", "transaction-summary", id] as const,
    mappings: () => ["parties", "mappings"] as const,
  },
  invoices: {
    all: () => ["invoices"] as const,
    list: (params?: Params) => ["invoices", params ?? null] as const,
    detail: (id: string) => ["invoices", "detail", id] as const,
  },
  inbox: {
    all: () => ["inbox"] as const,
    list: (params?: Params) => ["inbox", params ?? null] as const,
    detail: (id: string) => ["inbox", "detail", id] as const,
    duplicateCase: (id: string) => ["inbox", "duplicate-case", id] as const,
    // Was a top-level ["inbox-settings"], so it sat outside the `all()` prefix and never
    // invalidated with the rest of the Inbox. One cheap read; folding it in is the right default.
    settings: () => ["inbox", "settings"] as const,
  },
  reviewAgents: {
    all: () => ["review-agents"] as const,
    list: () => ["review-agents", "list"] as const,
    findings: (ruleKey: string, params?: Params) =>
      ["review-agents", "findings", ruleKey, params ?? null] as const,
    runs: (ruleKey?: string) => ["review-agents", "runs", ruleKey ?? null] as const,
  },
  bills: {
    all: () => ["bills"] as const,
    list: (params?: Params) => ["bills", params ?? null] as const,
    detail: (id: string) => ["bills", "detail", id] as const,
  },
  transactions: {
    all: () => ["transactions"] as const,
    list: (params?: Params) => ["transactions", params ?? null] as const,
    grouped: (params?: Params) => ["transactions", "grouped", params ?? null] as const,
    detail: (id: string) => ["transactions", "detail", id] as const,
    attachments: (id: string) => ["transactions", "attachments", id] as const,
  },
  accounts: {
    all: () => ["accounts"] as const,
    tree: () => ["accounts", "tree"] as const,
    flat: () => ["accounts", "flat"] as const,
    byType: (type?: string) => ["accounts", "by-type", type ?? null] as const,
    balances: (params?: Params) => ["accounts", "balances", params ?? null] as const,
  },
  categoryMappings: {
    all: () => ["categoryMappings"] as const,
    byType: (mappingType: string) => ["categoryMappings", mappingType] as const,
    /** Server-resolved mapping -> account ids for a set of source keys. */
    resolved: (mappingType: string, sourceKeys: string[]) =>
      ["categoryMappings", "resolved", mappingType, [...sourceKeys].sort().join(",")] as const,
  },
  coaPresets: {
    all: () => ["coa-presets"] as const,
    preview: (presetId: string) => ["coa-presets", "preview", presetId] as const,
  },
  financialAccounts: {
    all: () => ["financial-accounts"] as const,
    detail: (id: string) => ["financial-accounts", id] as const,
  },
  reconciliations: {
    all: () => ["reconciliations"] as const,
    detail: (id: string) => ["reconciliations", id] as const,
  },
  departments: {
    all: () => ["departments"] as const,
    detail: (id: string) => ["departments", id] as const,
  },
  locations: {
    all: () => ["locations"] as const,
    detail: (id: string) => ["locations", id] as const,
  },
  documents: {
    all: () => ["documents"] as const,
    detail: (id: string) => ["documents", "detail", id] as const,
    thumbnail: (id: string) => ["documents", "thumbnail", id] as const,
  },
  reports: {
    all: () => ["reports"] as const,
    one: (kind: string, params?: Params) => ["reports", kind, params ?? null] as const,
  },
  businessGroups: {
    all: () => ["business-groups"] as const,
    landing: () => ["business-groups", "landing"] as const,
    entities: (groupId: string | null) => ["business-groups", groupId, "entities"] as const,
    linkable: (groupId: string | null) => ["business-groups", groupId, "linkable"] as const,
    members: (groupId: string | null) => ["business-groups", groupId, "members"] as const,
    memberCandidates: (groupId: string | null) =>
      ["business-groups", groupId, "member-candidates"] as const,
    performance: (groupId: string | null, params?: Params) =>
      ["business-groups", groupId, "performance", params ?? null] as const,
    portfolioPerformance: (groupIds: string[], params?: Params) =>
      [
        "business-groups",
        "portfolio-performance",
        [...groupIds].sort().join(","),
        params ?? null,
      ] as const,
  },
  payroll: {
    all: () => ["payroll"] as const,
    run: (runId: string) => ["payroll", runId] as const,
    variances: (runId: string) => ["payroll", runId, "variances"] as const,
  },
  filing: {
    all: () => ["filing"] as const,
    workspace: (runId: string) => ["filing", "workspace", runId] as const,
  },
  tax: {
    all: () => ["tax"] as const,
    moduleState: () => ["tax", "module-state"] as const,
    certificates: () => ["tax", "certificates"] as const,
    settings: () => ["tax", "settings"] as const,
    deadlines: (year: number) => ["tax", "deadlines", year] as const,
  },
  org: {
    settings: () => ["org-settings"] as const,
    members: () => ["org-members"] as const,
    organizations: () => ["organizations"] as const,
    connections: () => ["connections"] as const,
    activeOrganization: (id: string | null) => ["activeOrganization", id] as const,
  },
  activityLogs: (entityId?: string) => ["activity-logs", entityId ?? null] as const,
  comments: (entityType?: string, entityId?: string) =>
    ["comments", entityType ?? null, entityId ?? null] as const,
} as const;
