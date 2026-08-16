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
import { organizationAiSettings, type AiAutonomyLevel } from "../../db/schema/ai";
import type { AiTaskName } from "./types";
import type { AiProvider } from "./errors";
import { createLogger } from "../logger";

const logger = createLogger("ai.settings");

const CACHE_TTL_MS = 30_000;

export interface OrgAiSettings {
  taskChains: Record<string, unknown> | null;
  confidenceThresholds: Record<string, number>;
  autonomy: Record<string, AiAutonomyLevel>;
  taskAllowlist: string[] | null;
  providerAllowlist: AiProvider[] | null;
  monthlySpendCapUsd: number | null;
  killSwitch: boolean;
}

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
    // Settings are a guardrail layer; if they cannot be read we fail CLOSED
    // on nothing (defaults are the most permissive-but-safe posture: suggest
    // -only autonomy, no kill switch) and log loudly.
    logger.error("Failed to load org AI settings — using defaults", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULTS;
  }
}

export function isTaskAllowed(settings: OrgAiSettings, task: AiTaskName): boolean {
  if (!settings.taskAllowlist) return true;
  return settings.taskAllowlist.includes(task);
}

export function isProviderAllowed(settings: OrgAiSettings, provider: AiProvider): boolean {
  // Absent allowlist ⇒ Gemini only. Adding a new provider is an explicit,
  // audited act, never a side effect of a default.
  if (!settings.providerAllowlist) return provider === "gemini";
  return settings.providerAllowlist.includes(provider);
}

/** Escalate below this self-reported confidence (0–1). */
export function confidenceThresholdFor(settings: OrgAiSettings, task: AiTaskName): number | null {
  const value = settings.confidenceThresholds[task];
  return typeof value === "number" ? value : null;
}
