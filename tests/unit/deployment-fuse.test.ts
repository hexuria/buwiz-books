import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

const disabledProductionScripts = [
  "scripts/provision-gcp.sh",
  "scripts/new-client.sh",
  "scripts/restore-backup.sh",
] as const;

const disabledProductionTargets = [
  "push",
  "deploy",
  "deploy-docker",
  "scheduler",
  "env",
  "logs",
  "url",
  "open",
  "db-prod",
  "rls-prod",
  "promote-prod",
  "provision",
  "migrate",
  "domain",
] as const;

function targetRecipe(makefile: string, target: string): string {
  const match = makefile.match(new RegExp(`^${target}:\\n((?:\\t.*\\n)+)`, "m"));
  expect(match, `missing historical ${target} fuse`).not.toBeNull();
  return match?.[1] ?? "";
}

function runHistoricalScript(script: (typeof disabledProductionScripts)[number]) {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "buwiz-deploy-fuse-"));
  const fixtureScripts = resolve(fixtureRoot, "scripts");
  const stubBin = resolve(fixtureRoot, "bin");
  const externalMarker = resolve(fixtureRoot, "external-command-ran");
  const envMarker = resolve(fixtureRoot, "environment-was-read");
  mkdirSync(fixtureScripts);
  mkdirSync(stubBin);
  writeFileSync(resolve(fixtureScripts, script.split("/").at(-1) ?? "script.sh"), read(script));
  writeFileSync(resolve(fixtureRoot, ".env"), `printf env-read > ${envMarker}\n`);

  for (const command of [
    "bun",
    "bunx",
    "cat",
    "cloud-sql-proxy",
    "cp",
    "docker",
    "gcloud",
    "grep",
    "openssl",
    "psql",
    "sed",
    "sleep",
    "tr",
    "xargs",
  ]) {
    const stub = resolve(stubBin, command);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s' '${command}' >> '${externalMarker}'\nexit 99\n`);
    chmodSync(stub, 0o755);
  }

  const result = spawnSync("/bin/bash", [resolve(fixtureScripts, script.split("/").at(-1) ?? "")], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: { PATH: `${stubBin}:/usr/bin:/bin` },
    input: "\n",
  });
  const observation = {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    externalCommandRan: existsSync(externalMarker),
    environmentWasRead: existsSync(envMarker),
  };
  rmSync(fixtureRoot, { recursive: true, force: true });
  return observation;
}

describe("application-repository deployment fuse", () => {
  it("runs CI for pull requests and main pushes without a manual deployment trigger", () => {
    const workflow = read(".github/workflows/deploy.yml");

    expect(workflow).toMatch(/^name: Continuous Integration$/m);
    expect(workflow).toMatch(/^  pull_request:$/m);
    expect(workflow).toMatch(/^  push:\n    branches: \[main\]$/m);
    expect(workflow).not.toMatch(/^  workflow_dispatch:/m);
  });

  it("keeps the workflow read-only with no cloud credentials or deployment actions", () => {
    const workflow = read(".github/workflows/deploy.yml");

    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    for (const productionCapability of [
      "${{ secrets.",
      "id-token: write",
      "google-github-actions/",
      "gcloud ",
      "docker push",
      "deploy-cloudrun",
      "cloud-sql-proxy",
      "scheduler jobs",
      "domain-mappings",
    ]) {
      expect(workflow).not.toContain(productionCapability);
    }
    expect(workflow).not.toMatch(/^  deploy:/m);
    expect(workflow).not.toMatch(/^\s*environment:\s*(production|prod)\s*$/m);
  });

  it("retains local development, build, check, and test targets", () => {
    const makefile = read("Makefile");

    expect(makefile).toMatch(/^run:\n\tbun run dev$/m);
    expect(makefile).toMatch(/^build:\n\tbun run build$/m);
    expect(makefile).toMatch(/^check:\n\tbun run check$/m);
    expect(makefile).toMatch(/^test:\n\tbun run test$/m);
  });

  it.each(disabledProductionTargets)("fails closed for the historical make %s target", (target) => {
    const recipe = targetRecipe(read("Makefile"), target);

    expect(recipe).toContain("disabled in this application repository");
    expect(recipe).toMatch(/(?:^|\s)@?exit 1(?:\s|$)/);
  });

  it("contains no executable cloud or production mutation command", () => {
    const makefile = read("Makefile");

    for (const mutationCommand of [
      /\bgcloud\b/,
      /\bdocker\s+push\b/,
      /scripts\/provision-gcp\.sh/,
      /\bcloud-sql-proxy\b/,
      /\bdrizzle-kit\s+push\b/,
      /\bscheduler\s+jobs\b/,
      /\bsecrets\s+versions\s+access\b/,
      /\bdomain-mappings\s+create\b/,
    ]) {
      expect(makefile).not.toMatch(mutationCommand);
    }
  });

  it.each(disabledProductionScripts)("fails %s before env reads or external commands", (script) => {
    const result = runHistoricalScript(script);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("disabled in this application repository");
    expect(result.environmentWasRead).toBe(false);
    expect(result.externalCommandRan).toBe(false);
  });
});
