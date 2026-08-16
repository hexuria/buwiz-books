export type BusinessGroupReportSource = "live" | "shadow" | "projection";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProjectionAccountAllowlist {
  accountIds: ReadonlySet<string>;
  invalidTokenCount: number;
}

export function normalizeBusinessGroupReportSource(
  configured: string | undefined,
): BusinessGroupReportSource {
  const source = configured?.trim().toLowerCase();
  if (source === "shadow" || source === "projection") return source;
  return "live";
}

/**
 * Parse the account-scoped projection canary without ever treating malformed
 * input as access. `none` is the deploy-workflow sentinel for an empty list.
 */
export function parseProjectionAccountAllowlist(
  configured: string | undefined,
): ProjectionAccountAllowlist {
  const accountIds = new Set<string>();
  let invalidTokenCount = 0;

  for (const rawToken of configured?.split(",") ?? []) {
    const token = rawToken.trim().toLowerCase();
    if (!token || token === "none") continue;
    if (!UUID_PATTERN.test(token)) {
      invalidTokenCount += 1;
      continue;
    }
    accountIds.add(token);
  }

  return { accountIds, invalidTokenCount };
}

/**
 * `shadow` plus an allowlist is the canary mode: authorized accounts on the
 * list read projections while every other account still receives live data
 * with shadow reconciliation. Global live/projection modes ignore the list.
 */
export function resolveBusinessGroupReportSource(input: {
  configuredSource: string | undefined;
  configuredAccountAllowlist: string | undefined;
  enterpriseAccountId: string;
}): {
  source: BusinessGroupReportSource;
  invalidAllowlistTokenCount: number;
} {
  const configuredSource = normalizeBusinessGroupReportSource(input.configuredSource);
  const allowlist = parseProjectionAccountAllowlist(input.configuredAccountAllowlist);
  const enterpriseAccountId = input.enterpriseAccountId.toLowerCase();

  return {
    source:
      configuredSource === "shadow" && allowlist.accountIds.has(enterpriseAccountId)
        ? "projection"
        : configuredSource,
    invalidAllowlistTokenCount: allowlist.invalidTokenCount,
  };
}

export function invalidProjectionAllowlistWarning(invalidTokenCount: number) {
  if (invalidTokenCount < 1) return null;
  return {
    severity: "WARNING" as const,
    event: "business_group_projection_allowlist_invalid",
    invalidTokenCount,
  };
}
