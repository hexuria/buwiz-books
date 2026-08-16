// ============================================================================
// Gemini AI Client — Smart Per-Key Rotation with Cooldown & Backoff
//
// Key source: server-only organization_secrets.
//
// Behaviour:
//  • Round-robin across AVAILABLE keys (skips keys in cooldown)
//  • Each key gets MAX_RETRIES_PER_KEY (3) consecutive failures before lockout
//  • On lockout: exponential cooldown — 1 min → 3 min → 9 min → … max 6 hrs
//  • On success: fully resets that key's failure counter + cooldown level
//  • If ALL keys are in cooldown: throws with earliest-available-at info
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { GenerativeModel, GenerationConfig } from "@google/generative-ai";
import { db } from "../db";
import { organization } from "../db/schema/auth";
import { eq } from "drizzle-orm";
import { createLogger } from "./logger";
import { AI_MODEL_DEFAULTS } from "./ai-models";
import type { AITaskCategory } from "./ai-models";
import { getOrganizationSecrets } from "./org-secrets";
import { parseOrgMetadata } from "./org-metadata";

const logger = createLogger("ai.gemini");

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const MAX_RETRIES_PER_KEY = 3;
const BASE_COOLDOWN_MS = 60_000; // 1 minute
const COOLDOWN_MULTIPLIER = 3; // 1m → 3m → 9m → 27m → 81m → 243m → 360m
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
// Ceiling for a single model call — the SDK aborts the fetch past this so a
// stuck request fails (and rotates) instead of hanging the caller forever.
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

// ── Types ────────────────────────────────────────────────────────────────────

export interface GeminiCallOptions {
  orgId: string;
  model?: string;
  task?: AITaskCategory;
  generationConfig?: GenerationConfig;
  /**
   * Observability hook — called with the resolved model name before each
   * attempt. Lets the telemetry wrapper (src/lib/ai/invoke.ts) record the
   * pinned model that actually served the call without duplicating the
   * resolution precedence below.
   */
  onAttempt?: (info: { model: string; keyIndex: number }) => void;
}

/** Per-key health state (in-memory, resets on server restart) */
interface KeyState {
  failCount: number; // consecutive failures in current window
  lockoutLevel: number; // how many times fully locked out (drives backoff)
  cooldownUntil: number; // timestamp — 0 means available
  invalid: boolean; // key was rejected as invalid/revoked — long cooldown
}

/** User-friendly exhaustion error */
export class GeminiRateLimitError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "All AI API keys are currently rate-limited. Please try again later.\nIf you just need to Upload a File, go to /documents, and upload file.",
    );
    this.name = "GeminiRateLimitError";
  }
}

// ── Key Health Tracker ───────────────────────────────────────────────────────

/**
 * In-memory tracker: Map<orgId, Map<keyIndex, KeyState>>
 * Resets on server restart (which is fine — rate limits are transient).
 *
 * WARNING: process-local — health state is not shared across instances.
 * Under horizontal scaling, each replica tracks keys independently so
 * a key exhausted on one replica may still be picked on another.
 * If consistent key rotation is required at scale, move state to Redis.
 */
const healthMap = new Map<string, Map<number, KeyState>>();

function getKeyState(orgId: string, keyIndex: number): KeyState {
  let orgMap = healthMap.get(orgId);
  if (!orgMap) {
    orgMap = new Map();
    healthMap.set(orgId, orgMap);
  }
  let state = orgMap.get(keyIndex);
  if (!state) {
    state = { failCount: 0, lockoutLevel: 0, cooldownUntil: 0, invalid: false };
    orgMap.set(keyIndex, state);
  }
  return state;
}

/** Check if a key is currently available (not in cooldown). */
function isKeyAvailable(orgId: string, keyIndex: number): boolean {
  const state = getKeyState(orgId, keyIndex);
  if (state.cooldownUntil === 0) return true;
  if (Date.now() >= state.cooldownUntil) {
    // Cooldown expired — key is available again (keep lockoutLevel for next backoff)
    state.cooldownUntil = 0;
    state.failCount = 0;
    return true;
  }
  return false;
}

/** Record a FAILURE for a key. Returns true if key entered cooldown. */
function recordFailure(orgId: string, keyIndex: number): boolean {
  const state = getKeyState(orgId, keyIndex);
  state.failCount++;

  if (state.failCount >= MAX_RETRIES_PER_KEY) {
    // Key is exhausted — enter cooldown
    state.lockoutLevel++;
    const cooldownMs = Math.min(
      BASE_COOLDOWN_MS * COOLDOWN_MULTIPLIER ** (state.lockoutLevel - 1),
      MAX_COOLDOWN_MS,
    );
    state.cooldownUntil = Date.now() + cooldownMs;
    state.failCount = 0; // reset for next window

    const cooldownLabel = formatDuration(cooldownMs);
    logger.warn("Key entered cooldown", {
      keyIndex,
      orgId: orgId.slice(0, 8),
      cooldownLabel,
      level: state.lockoutLevel,
    });
    return true;
  }
  return false;
}

/** Record a SUCCESS for a key — fully resets its health. */
function recordSuccess(orgId: string, keyIndex: number): void {
  const state = getKeyState(orgId, keyIndex);
  state.failCount = 0;
  state.lockoutLevel = 0;
  state.cooldownUntil = 0;
  state.invalid = false;
}

/**
 * Mark a key as invalid/revoked and remove it from rotation for a long window.
 * Unlike a rate-limit cooldown this is a provider rejection, not throughput —
 * so it should not count toward exhaustion backoff, but the key must be skipped.
 */
function disableInvalidKey(orgId: string, keyIndex: number): void {
  const state = getKeyState(orgId, keyIndex);
  state.invalid = true;
  state.failCount = 0;
  state.cooldownUntil = Date.now() + MAX_COOLDOWN_MS;
  logger.error("API key rejected as invalid — removing from rotation", {
    keyIndex,
    orgId: orgId.slice(0, 8),
    retryAfter: formatDuration(MAX_COOLDOWN_MS),
  });
}

/** Get the indices of all available (non-cooldown) keys. */
function getAvailableKeyIndices(orgId: string, totalKeys: number): number[] {
  const available: number[] = [];
  for (let i = 0; i < totalKeys; i++) {
    if (isKeyAvailable(orgId, i)) {
      available.push(i);
    }
  }
  return available;
}

/** Get the earliest time any key becomes available again. */
function getEarliestAvailableAt(orgId: string, totalKeys: number): number {
  let earliest = Infinity;
  for (let i = 0; i < totalKeys; i++) {
    const state = getKeyState(orgId, i);
    if (state.cooldownUntil > 0 && state.cooldownUntil < earliest) {
      earliest = state.cooldownUntil;
    }
  }
  return earliest;
}

// ── Key Pool ─────────────────────────────────────────────────────────────────

/** In-memory round-robin index per org (across available keys only) */
const rrIndexMap = new Map<string, number>();

/**
 * Load API keys from server-only storage and model preferences from public metadata.
 * No env var fallback — keys must be configured in Organization Settings.
 */
async function getOrgGeminiConfig(orgId: string): Promise<{
  keys: string[];
  model?: string;
  taskModels: Partial<Record<AITaskCategory, string>>;
}> {
  const keys: string[] = [];
  let model: string | undefined;
  const taskModels: Partial<Record<AITaskCategory, string>> = {};

  if (!orgId) return { keys, model, taskModels };

  try {
    const [org] = await db
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    const secrets = await getOrganizationSecrets(db, orgId);
    keys.push(...secrets.geminiApiKeys.map((key) => key.trim()).filter(Boolean));

    if (org?.metadata) {
      const parsed = parseOrgMetadata(org.metadata);
      // Legacy single-model field
      if (typeof parsed.geminiDefaultModel === "string") {
        model = parsed.geminiDefaultModel;
      }
      // Per-task model overrides
      if (typeof parsed.aiModelOcr === "string" && parsed.aiModelOcr) {
        taskModels.ocr = parsed.aiModelOcr;
      }
      if (typeof parsed.aiModelTextAnalysis === "string" && parsed.aiModelTextAnalysis) {
        taskModels.textAnalysis = parsed.aiModelTextAnalysis;
      }
      if (typeof parsed.aiModelImageGen === "string" && parsed.aiModelImageGen) {
        taskModels.imageGen = parsed.aiModelImageGen;
      }
    }
  } catch (err) {
    // Non-fatal for the caller, but log it: a DB/config load failure here
    // otherwise surfaces to the user as the misleading "no keys configured"
    // error, indistinguishable from an org that genuinely has none.
    logger.error("Failed to load org Gemini config — returning what was resolved", {
      orgId: orgId.slice(0, 8),
      keysResolved: keys.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { keys, model, taskModels };
}

/**
 * Pick the next available key via round-robin (skipping cooldown keys).
 * Returns { key, index } or null if all keys are in cooldown.
 */
function pickNextAvailableKey(
  orgId: string,
  keys: string[],
): { key: string; index: number } | null {
  const available = getAvailableKeyIndices(orgId, keys.length);
  if (available.length === 0) return null;

  const rrIdx = rrIndexMap.get(orgId) ?? 0;
  const pick = available[rrIdx % available.length];
  rrIndexMap.set(orgId, (rrIdx + 1) % available.length);

  return { key: keys[pick], index: pick };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("too many requests") ||
      msg.includes("rate limit") ||
      msg.includes("quota") ||
      msg.includes("resource exhausted") ||
      // 503 "high demand" / overloaded — functionally same as rate limit
      msg.includes("503") ||
      msg.includes("service unavailable") ||
      msg.includes("high demand") ||
      msg.includes("overloaded") ||
      // a timed-out/aborted request may succeed on another key — rotate
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("aborted") ||
      msg.includes("deadline")
    );
  }
  return false;
}

/** True for provider rejections that mean the API KEY itself is bad/revoked. */
function isInvalidKeyError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("api key not valid") ||
      msg.includes("api_key_invalid") ||
      msg.includes("invalid api key") ||
      msg.includes("permission denied") ||
      msg.includes("permission_denied") ||
      // HTTP 401/403 from the auth layer
      msg.includes("401") ||
      msg.includes("403") ||
      msg.includes("unauthorized") ||
      msg.includes("unregistered callers") ||
      msg.includes("api key expired")
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute a Gemini call with smart per-key rotation, cooldowns, and backoff.
 *
 * Flow:
 *   1. Pick next AVAILABLE key (skip cooldown keys)
 *   2. Try the call — on success, reset the key's health and return
 *   3. On rate-limit failure: increment key's fail counter
 *      - If key hits MAX_RETRIES_PER_KEY (3): enter cooldown, try next key
 *      - Otherwise: short delay (1s, 2s, 4s) then retry same key
 *   4. Non-rate-limit errors: throw immediately (no retry)
 *   5. If all keys exhausted: throw GeminiRateLimitError
 *
 * @param opts  - org ID, model name, generation config
 * @param callFn - receives a GenerativeModel, returns the result
 * @returns The result of callFn
 * @throws GeminiRateLimitError after all keys are exhausted
 */
export async function callWithRetry<T>(
  opts: GeminiCallOptions,
  callFn: (model: GenerativeModel) => Promise<T>,
): Promise<T> {
  const { keys, model: defaultOrgModel, taskModels } = await getOrgGeminiConfig(opts.orgId);
  if (keys.length === 0) {
    throw new Error(
      "No Gemini API keys configured. Go to Settings → AI Credentials to add your keys.",
    );
  }

  // Keep trying until we run out of available keys
  while (true) {
    const pick = pickNextAvailableKey(opts.orgId, keys);

    if (!pick) {
      // No key is currently usable. If every key was rejected as invalid, say
      // so plainly — it's a credential problem, not throughput.
      const allInvalid = keys.every((_, i) => getKeyState(opts.orgId, i).invalid);
      if (allInvalid) {
        throw new Error(
          `All ${keys.length} Gemini API key(s) were rejected as invalid. Check your keys in Settings → AI Credentials.`,
        );
      }
      const earliest = getEarliestAvailableAt(opts.orgId, keys.length);
      const waitLabel =
        earliest === Infinity ? "later" : `in ~${formatDuration(earliest - Date.now())}`;
      throw new GeminiRateLimitError(
        `All ${keys.length} API key(s) are rate-limited. Next key available ${waitLabel}.\nAdd more keys in Settings → AI Credentials to increase throughput.`,
      );
    }

    // Try this key with per-key retries
    for (let attempt = 0; attempt < MAX_RETRIES_PER_KEY; attempt++) {
      // Re-check availability (could have been locked by a concurrent call)
      if (!isKeyAvailable(opts.orgId, pick.index)) break;

      const genAI = new GoogleGenerativeAI(pick.key);
      // Priority: explicit model → task-specific org model → legacy org default → built-in default
      const taskDefault = opts.task ? taskModels[opts.task] : undefined;
      const builtInDefault = opts.task ? AI_MODEL_DEFAULTS[opts.task] : DEFAULT_MODEL;
      const modelName = opts.model ?? taskDefault ?? defaultOrgModel ?? builtInDefault;
      try {
        opts.onAttempt?.({ model: modelName, keyIndex: pick.index });
      } catch {
        // Observability must never break the call path.
      }
      const model = genAI.getGenerativeModel(
        {
          model: modelName,
          generationConfig: opts.generationConfig,
        },
        { timeout: REQUEST_TIMEOUT_MS },
      );

      try {
        const result = await callFn(model);
        // Success — fully reset this key's health
        recordSuccess(opts.orgId, pick.index);
        return result;
      } catch (err) {
        if (isInvalidKeyError(err)) {
          // The key itself is bad — take it out of rotation and try the next.
          disableInvalidKey(opts.orgId, pick.index);
          break;
        }
        if (!isTransientError(err)) {
          // Non-rate-limit error — throw immediately, don't penalize the key
          throw err;
        }

        // Rate-limit hit — record failure
        const enteredCooldown = recordFailure(opts.orgId, pick.index);
        if (enteredCooldown) {
          // Key fully exhausted — break to try next key
          break;
        }

        // Key still has retries left — short backoff before retry
        const state = getKeyState(opts.orgId, pick.index);
        const delay = 1000 * 2 ** (state.failCount - 1); // 1s, 2s, 4s
        await sleep(delay);
      }
    }

    // This key failed or entered cooldown — loop will try next available key
  }
}
