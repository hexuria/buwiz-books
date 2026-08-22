import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "url";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          setupFiles: ["./tests/setup-node.ts"],
          include: ["tests/unit/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          setupFiles: ["./tests/setup.ts"],
          include: ["tests/component/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          setupFiles: ["./tests/setup-integration.ts"],
          globalSetup: ["./tests/global-setup.ts"],
          include: ["tests/integration/**/*.test.{ts,tsx}"],
          fileParallelism: false,
          // These talk to a real Postgres and run a job handler end to end, so
          // several seconds of genuine work is normal. Vitest's 5s default is
          // sized for pure functions, and holding database tests to it produced
          // failures that pointed at the test rather than at anything wrong —
          // the same test passing alone and failing under a loaded suite.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    // tests/evals is excluded belt-and-suspenders: it has its own config
    // (vitest.evals.config.ts) and in live mode makes billable model calls.
    exclude: ["node_modules", "dist", ".output", "tests/e2e", "tests/evals"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "tests/", "**/*.d.ts", "**/*.config.*", "**/mockData", "dist/"],
    },
  },
});
