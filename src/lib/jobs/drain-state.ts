/**
 * Shared mutable state for job draining and worker-trigger health.
 *
 * This module is a LEAF on purpose: it must not import `registry.ts`, any
 * handler, or `trigger.ts`. Handlers already import `trigger.ts`, so routing
 * the drain handle through the registry would close an ESM cycle whose
 * `const` initialization order is undefined — the nudge would read as
 * `undefined` depending on which module the bundler entered first.
 */

export type DrainMode = "inline" | "off";

/** Called by `triggerWorker` in inline mode; registered by the drain itself. */
export type InlineNudge = (jobTypes?: string[]) => void;

let inlineNudge: InlineNudge | null = null;

export function setInlineNudge(fn: InlineNudge | null): void {
  inlineNudge = fn;
}

export function getInlineNudge(): InlineNudge | null {
  return inlineNudge;
}

/**
 * How queued jobs reach a worker in this process.
 *
 * `inline` runs a drain loop in-process — the only thing that makes
 * `bun run dev` work end to end, since there is no local scheduler.
 * `off` expects an external scheduler to POST the worker route.
 *
 * Test is forced `off` unless explicitly overridden: the integration suites
 * seed pre-claimed job rows and invoke handlers directly, and a background
 * drain would race them for those rows.
 */
export function resolveDrainMode(): DrainMode {
  const explicit = process.env.JOB_DRAIN_MODE?.trim().toLowerCase();
  if (explicit === "inline" || explicit === "off") return explicit;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return "off";
  return process.env.NODE_ENV === "production" ? "off" : "inline";
}

export interface TriggerHealth {
  /** False once we know the HTTP trigger cannot work (no secret configured). */
  configured: boolean;
  mode: DrainMode | "unknown";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

const triggerHealth: TriggerHealth = {
  configured: true,
  mode: "unknown",
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
};

export function getTriggerHealth(): TriggerHealth {
  return { ...triggerHealth };
}

export function recordTriggerMode(mode: DrainMode): void {
  triggerHealth.mode = mode;
}

export function recordTriggerUnconfigured(reason: string): void {
  triggerHealth.configured = false;
  triggerHealth.lastError = reason;
}

export function recordTriggerAttempt(): void {
  triggerHealth.lastAttemptAt = new Date().toISOString();
}

export function recordTriggerSuccess(): void {
  triggerHealth.configured = true;
  triggerHealth.lastSuccessAt = new Date().toISOString();
  triggerHealth.lastError = null;
  triggerHealth.consecutiveFailures = 0;
}

export function recordTriggerFailure(error: string): void {
  triggerHealth.lastError = error;
  triggerHealth.consecutiveFailures += 1;
}

/** Test seam — resets module state between cases. */
export function resetTriggerHealthForTests(): void {
  triggerHealth.configured = true;
  triggerHealth.mode = "unknown";
  triggerHealth.lastAttemptAt = null;
  triggerHealth.lastSuccessAt = null;
  triggerHealth.lastError = null;
  triggerHealth.consecutiveFailures = 0;
}
