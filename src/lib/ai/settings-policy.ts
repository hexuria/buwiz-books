import type { AiAutonomyLevel } from "../../db/schema/ai";
import type { AiTaskName } from "./types";
import type { AiProvider } from "./errors";

export interface OrgAiSettings {
  taskChains: Record<string, unknown> | null;
  confidenceThresholds: Record<string, number>;
  autonomy: Record<string, AiAutonomyLevel>;
  taskAllowlist: string[] | null;
  providerAllowlist: AiProvider[] | null;
  monthlySpendCapUsd: number | null;
  killSwitch: boolean;
}

export function isTaskAllowed(settings: OrgAiSettings, task: AiTaskName): boolean {
  return !settings.taskAllowlist || settings.taskAllowlist.includes(task);
}

export function isProviderAllowed(settings: OrgAiSettings, provider: AiProvider): boolean {
  return settings.providerAllowlist
    ? settings.providerAllowlist.includes(provider)
    : provider === "gemini";
}

export function confidenceThresholdFor(settings: OrgAiSettings, task: AiTaskName): number | null {
  const value = settings.confidenceThresholds[task];
  return typeof value === "number" ? value : null;
}
