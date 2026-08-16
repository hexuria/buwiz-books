import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
dotenv.config({ path: ".env.test", override: true });

/**
 * The dev server port, overridable so the suite is not hostage to whatever already holds 3001.
 *
 * This matters more than it looks. `reuseExistingServer` is true off CI, so if *anything* is
 * listening on this port Playwright adopts it — including a server running a different checkout
 * of this repo. The suite then reports confidently on code you are not testing, which is worse
 * than failing to start. When 3001 is taken by something you did not start, run against another
 * port rather than reusing it:
 *
 *     E2E_PORT=3210 bun run test:e2e
 *
 * `dev:test` reads the same variable, so the server and the client stay in agreement.
 */
const PORT = process.env.E2E_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  expect: {
    timeout: 30 * 1000,
  },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    command: "bun run dev:test",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // Playwright defaults to 60s, and a COLD Vite SSR transform of this route
    // tree lands at roughly 45-60s — so the suite passes while the transform
    // cache is warm and dies with "Vite environment nitro is unavailable" (a
    // 503 from the not-yet-ready runner) on the first run after any broad
    // change invalidates it. That reads like a code fault rather than a
    // timeout, so give the cold path real headroom.
    timeout: 180_000,
  },
});
