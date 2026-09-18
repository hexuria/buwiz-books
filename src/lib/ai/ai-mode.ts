// ============================================================================
// AI_MODE — live (default) vs in-process mock completion runtime.
//
// `mock` is a local/test switch so AI features can be exercised without
// outbound provider HTTP or token spend. It is refused when NODE_ENV is
// production: a mis-set env on Cloud Run must fail closed at boot, not
// silently return canned OCR/ledger JSON.
// ============================================================================

import type { AiCompletionRuntime } from "./facade-core";

export type AiMode = "live" | "mock";

/**
 * Read AI_MODE from the environment.
 *
 * - `mock` → in-process canned JSON (refused when NODE_ENV=production)
 * - `live`, unset, or any other value → production runtime (unchanged)
 */
export function readAiMode(env: NodeJS.ProcessEnv = process.env): AiMode {
  const mode = env.AI_MODE?.trim();
  if (mode === "mock") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "AI_MODE=mock is not allowed when NODE_ENV=production. Unset AI_MODE (or set AI_MODE=live) to use the production AI runtime.",
      );
    }
    return "mock";
  }
  return "live";
}

/**
 * Select the completion runtime from AI_MODE.
 * `mock` is refused when NODE_ENV=production (throws from readAiMode).
 * Unset / `live` / any other value keeps the production runtime.
 *
 * Runtimes are injected so this module stays free of the production DB
 * client — the façade wires the real objects at boot.
 */
export function resolveAiCompletionRuntime(
  runtimes: { mock: AiCompletionRuntime; live: AiCompletionRuntime },
  env: NodeJS.ProcessEnv = process.env,
): AiCompletionRuntime {
  return readAiMode(env) === "mock" ? runtimes.mock : runtimes.live;
}
