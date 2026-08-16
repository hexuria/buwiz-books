import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards a bug class that only shows up in production, after the tests pass.
 *
 * `env_vars:` and `secrets:` on google-github-actions/deploy-cloudrun are YAML block scalars
 * holding a newline-delimited NAME=VALUE list. Everything inside them is content: a "#" line
 * reads as a comment to a human, and is forwarded to `gcloud run deploy` as a literal secret
 * entry. The deploy then dies on "No secret version specified for # The break-glass ...", which
 * is a real deploy failure produced by nothing but a comment — no lint, typecheck, or test tier
 * looks at this file, and the workflow only runs on push to main, so the merge is where you find
 * out.
 *
 * Comments belong above the key, outside the block, which is where the surrounding ones sit.
 */
describe("deploy.yml Cloud Run value blocks", () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/deploy.yml"),
    "utf8",
  );

  /** Lines of the block scalar introduced by `<key>: |`, up to the first dedent. */
  function blockLines(key: string): string[] {
    const lines = workflow.split("\n");
    const start = lines.findIndex((l) => new RegExp(`^(\\s*)${key}:\\s*\\|\\s*$`).test(l));
    expect(start, `${key}: | not found in deploy.yml`).toBeGreaterThan(-1);
    const indent = (lines[start].match(/^\s*/) ?? [""])[0].length;
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") continue;
      if ((line.match(/^\s*/) ?? [""])[0].length <= indent) break;
      out.push(line.trim());
    }
    return out;
  }

  it.each(["env_vars", "secrets"])("%s holds only NAME=VALUE entries", (key) => {
    const entries = blockLines(key);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry, `"${entry}" is not a NAME=VALUE entry`).toMatch(/^[A-Z_][A-Z0-9_]*=\S+$/);
    }
  });

  it("still deploys ADMIN_EMAIL, the platform-operator identity", () => {
    // Unset, isPlatformOperator fails closed and nobody can enter a tenant they
    // do not belong to — safe, but it silently disables break-glass support access.
    expect(blockLines("secrets")).toContain("ADMIN_EMAIL=admin-email:latest");
  });
});
