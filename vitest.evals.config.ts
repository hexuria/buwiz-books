/**
 * Eval harness config — SEPARATE from vitest.config.ts on purpose.
 *
 * Evals must never run in the normal test suite or on the deploy path:
 * in `live` mode they make billable model calls. Two independent guards:
 *   1. this config is only used by `bun run test:evals`
 *   2. vitest.config.ts explicitly excludes tests/evals
 *
 * Modes (AI_EVALS_MODE):
 *   recorded (default) — no network. Replays stored provider responses and
 *                        snapshots rendered prompts, so prompt-template
 *                        regressions are caught deterministically.
 *   live               — nightly only, against a dedicated eval org whose
 *                        keys live in CI secrets (never .env.test).
 */
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const mode = process.env.AI_EVALS_MODE ?? "recorded";
if (mode !== "recorded" && mode !== "live") {
  throw new Error(`Unsupported AI_EVALS_MODE: ${mode}`);
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: mode === "live" ? ["tests/evals/*.live.eval.ts"] : ["tests/evals/prompts.eval.ts"],
    setupFiles: mode === "live" ? ["./tests/evals/setup-live.ts"] : [],
    environment: "node",
    globals: true,
    // Evals are I/O-bound and order-independent, but live mode hits rate
    // limits if fanned out; keep it sequential.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
