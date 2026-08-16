// ============================================================================
// Per-org AI settings resolution, with a short TTL cache.
//
// Read on every aiComplete call (kill switch, allowlists, chains,
// thresholds), so it must be cheap. A 30s cache bounds staleness: flipping
// the kill switch takes effect within 30 seconds across replicas, which is
// the trade the architecture accepts for keeping the hot path read-light.
// ============================================================================

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { organizationAiSettings } from "../../db/schema/ai";
import type { AiProvider } from "./errors";
import type { OrgAiSettings } from "./settings-policy";
import { createLogger } from "../logger";

const logger = createLogger("ai.settings");

const CACHE_TTL_MS = 30_000;

export class AiSettingsUnavailableError extends Error {
  constructor(orgId: string, cause: unknown) {
    super("AI settings are temporarily unavailable.", { cause });
    this.name = "AiSettingsUnavailableError";
    void orgId;
  }
}

export type { OrgAiSettings } from "./settings-policy";
export { confidenceThresholdFor, isProviderAllowed, isTaskAllowed } from "./settings-policy";

const DEFAULTS: OrgAiSettings = {
  taskChains: null,
  confidenceThresholds: {},
  autonomy: {},
  taskAllowlist: null,
  providerAllowlist: null,
  monthlySpendCapUsd: null,
  killSwitch: false,
};

const cache = new Map<string, { at: number; value: OrgAiSettings }>();

/** Drop a cached entry — call after a settings write so the UI feels instant. */
export function invalidateOrgAiSettings(orgId: string): void {
  cache.delete(orgId);
}

export async function getOrgAiSettings(orgId: string): Promise<OrgAiSettings> {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const [row] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, orgId))
      .limit(1);

    const value: OrgAiSettings = row
      ? {
          taskChains: row.taskChains ?? null,
          confidenceThresholds: row.confidenceThresholds ?? {},
          autonomy: row.autonomy ?? {},
          taskAllowlist: row.taskAllowlist ?? null,
          providerAllowlist: (row.providerAllowlist as AiProvider[] | null) ?? null,
          monthlySpendCapUsd:
            row.monthlySpendCapUsd != null ? Number(row.monthlySpendCapUsd) : null,
          killSwitch: row.killSwitch,
        }
      : DEFAULTS;

    cache.set(orgId, { at: Date.now(), value });
    return value;
  } catch (err) {
    // Settings are a guardrail layer. A read failure must stop before spend,
    // credential resolution, or any provider call; permissive defaults are
    // valid only when the organization genuinely has no settings row.
    logger.error("Failed to load org AI settings — blocking AI execution", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AiSettingsUnavailableError(orgId, err);
  }
}
