import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("authoritative Vitest projects", () => {
  it("selects one named project per package script without directory filters or .env.test", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts["test:unit"]).toBe("vitest run --project=unit");
    expect(scripts["test:component"]).toBe("vitest run --project=component");
    expect(scripts["test:integration"]).toBe("vitest run --project=integration");
    expect(scripts["test:all"]).toBe(
      "bun run test:unit && bun run test:component && bun run test:integration",
    );
    expect(scripts["test:all"]).not.toContain("test:e2e");
  });

  it("makes CI invoke the named project scripts", () => {
    const workflow = read(".github/workflows/deploy.yml");

    expect(workflow).toContain("run: bun run test:unit");
    expect(workflow).toContain("run: bun run test:component");
    expect(workflow).toContain("run: bun run test:integration");
    expect(workflow).not.toMatch(/vitest run tests\/(unit|component|integration)/);
  });

  it("runs unit and component projects in a job with no database service or provider env", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const hermeticJob = workflow.slice(
      workflow.indexOf("  static-and-hermetic-tests:"),
      workflow.indexOf("  integration-tests:"),
    );

    expect(hermeticJob).toContain("run: bun run test:unit");
    expect(hermeticJob).toContain("run: bun run test:component");
    expect(hermeticJob).not.toContain("postgres:");
    expect(hermeticJob).not.toMatch(/DATABASE_URL|TEST_DATABASE_URL|RESEND_API_KEY|GEMINI_API_KEY/);
  });

  it("requires the explicitly isolated integration database variable", () => {
    const globalSetup = read("tests/global-setup.ts");
    const integrationSetup = read("tests/setup-integration.ts");

    expect(globalSetup).toContain("process.env.TEST_DATABASE_URL");
    expect(globalSetup).not.toContain("process.env.DATABASE_URL");
    expect(integrationSetup).toContain("const testDatabaseUrl = process.env.TEST_DATABASE_URL");
    expect(integrationSetup).toContain("process.env.DATABASE_URL = testDatabaseUrl");
    expect(integrationSetup).toContain("process.env.DATABASE_URL_ADMIN = testDatabaseUrl");
  });

  it("gives only integration the database global setup", () => {
    const config = read("vitest.config.ts");

    expect(config).toContain('name: "unit"');
    expect(config).toContain('name: "component"');
    expect(config).toContain('name: "integration"');
    expect(config.match(/globalSetup:\s*\["\.\/tests\/global-setup\.ts"\]/g)).toHaveLength(1);
    expect(config.match(/setupFiles:\s*\["\.\/tests\/setup-integration\.ts"\]/g)).toHaveLength(1);
    expect(read("tests/setup-integration.ts")).toContain(
      'RESEND_API_KEY ??= "re_test_integration_only"',
    );
  });

  it("keeps DOM setup out of Node projects and disables integration file parallelism", () => {
    const config = read("vitest.config.ts");

    expect(config.match(/environment:\s*"jsdom"/g)).toHaveLength(1);
    expect(config.match(/setupFiles:\s*\["\.\/tests\/setup\.ts"\]/g)).toHaveLength(1);
    expect(config.match(/fileParallelism:\s*false/g)).toHaveLength(1);
  });

  it("keeps the debounced React hook in the component project only", () => {
    expect(() => read("tests/unit/hooks/useDebouncedValue.test.tsx")).toThrow();
    expect(read("tests/component/useDebouncedValue.test.tsx")).toContain("renderHook");
  });
});
