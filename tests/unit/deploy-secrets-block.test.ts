import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("continuous-integration credential boundary", () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/deploy.yml"),
    "utf8",
  );

  it("uses only deterministic test credentials", () => {
    expect(workflow).toContain("BETTER_AUTH_SECRET: ci-test-secret");
    expect(workflow).toContain("RESEND_API_KEY: re_ci_placeholder_key");
    expect(workflow).not.toContain("ADMIN_EMAIL");
    expect(workflow).not.toContain("DATABASE_URL_ADMIN");
  });
});
