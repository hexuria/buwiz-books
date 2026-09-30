/**
 * Integration files run one after another in a single process
 * (--no-file-parallelism), so an environment stub one file leaves behind is
 * the next file's environment. AI_MODE decides which runtime the AI façade
 * resolves at module init, so a leaked "mock" silently changes what later
 * files test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "tests/integration");

describe("integration environment hygiene", () => {
  it("every integration file that stubs env restores it", () => {
    const leaking = readdirSync(DIR)
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => {
        const source = readFileSync(join(DIR, name), "utf8");
        return source.includes("vi.stubEnv(") && !source.includes("vi.unstubAllEnvs()");
      });
    expect(leaking).toEqual([]);
  });
});
