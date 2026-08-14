import { spawn } from "node:child_process";
import { createMigrationDatabaseTarget, type DatabaseTarget } from "../src/lib/database-target";
import {
  runMigrationEntrypoint,
  type MigrationApplyPhase,
  type MigrationEntrypointCommand,
} from "../src/lib/migrations/entrypoint";
import type { MigrationReport } from "../src/lib/migrations/engine";

interface CliOptions {
  readonly command: MigrationEntrypointCommand;
  readonly phase: MigrationApplyPhase;
  readonly through?: string;
  readonly json: boolean;
}

export type ProcessRunner = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<void>;

const usage = `
Usage: bun run scripts/migrate.ts <status|verify|apply> [options]

Options:
  --phase=all|pre_schema|post_schema  Limit apply to one lifecycle phase.
  --through=NNNN                     Stop at a managed migration id.
  --json                             Print the report as JSON.
  --help                             Show this help.

Migration commands require MIGRATION_DATABASE_URL or DATABASE_URL_ADMIN.
Apply additionally requires MIGRATION_SCHEMA_SYNC_CONFIRM to equal the
normalized migration database name before any schema tool can run.
`;

function parsePhase(value: string): MigrationApplyPhase {
  if (value === "all" || value === "pre_schema" || value === "post_schema") return value;
  throw new Error(`Invalid --phase ${value}; expected all, pre_schema, or post_schema.`);
}

export function parseMigrationCliArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    console.log(usage.trim());
    throw new Error("HELP_SHOWN");
  }
  if (command !== "status" && command !== "verify" && command !== "apply") {
    throw new Error("A command is required: status, verify, or apply.");
  }

  let phase: MigrationApplyPhase = "all";
  let through: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage.trim());
      throw new Error("HELP_SHOWN");
    }
    if (argument === "--phase" || argument === "--through") {
      const value = rest[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--phase") phase = parsePhase(value);
      else through = value;
      continue;
    }
    if (argument.startsWith("--phase=")) {
      phase = parsePhase(argument.slice("--phase=".length));
      continue;
    }
    if (argument.startsWith("--through=")) {
      through = argument.slice("--through=".length);
      continue;
    }
    throw new Error(`Unknown migration option ${argument}.`);
  }

  if (command !== "apply" && phase !== "all") {
    throw new Error("--phase is only valid with apply.");
  }
  return { command, phase, through, json };
}

const defaultProcessRunner: ProcessRunner = (args, environment) =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", args, { env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Schema command exited with code ${code ?? "unknown"}.`));
    });
  });

function migrationUrl(environment: NodeJS.ProcessEnv): string {
  const value = environment.MIGRATION_DATABASE_URL ?? environment.DATABASE_URL_ADMIN;
  if (!value) {
    throw new Error(
      "MIGRATION_DATABASE_URL or DATABASE_URL_ADMIN is required; DATABASE_URL is a serving credential and is not accepted for migrations.",
    );
  }
  return value;
}

function requireSchemaConfirmation(target: DatabaseTarget, environment: NodeJS.ProcessEnv): void {
  if (environment.MIGRATION_SCHEMA_SYNC_CONFIRM !== target.databaseName) {
    throw new Error(
      `Schema synchronization is fail-closed: MIGRATION_SCHEMA_SYNC_CONFIRM must exactly equal ${target.databaseName}.`,
    );
  }
}

function lifecycleHooks(
  target: DatabaseTarget,
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
  processRunner: ProcessRunner,
) {
  const commandEnvironment = { ...environment, DATABASE_URL: databaseUrl };
  const guarded = (args: readonly string[]) => {
    requireSchemaConfirmation(target, environment);
    return processRunner(args, commandEnvironment);
  };

  return {
    // Drizzle's generated 0000-0002 history is the base-schema phase.
    prepareBaseSchema: () => guarded(["x", "drizzle-kit", "migrate"]),
    // Handwritten 0026-0027 run before this synchronization step; the same
    // engine then verifies and records the post-schema migrations.
    synchronizeSchema: () => guarded(["x", "drizzle-kit", "push", "--force"]),
    // RLS policy application is owned by the canonical deployment layer. A
    // local caller may provide a reviewed command explicitly later; no shell
    // text is accepted here.
    finalizeSchema: async () => undefined,
  };
}

function printReport(report: MigrationReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const outcome of report.outcomes) {
    console.log(`${outcome.id} ${outcome.phase} ${outcome.state}`);
  }
  console.log(`${report.command}: ${report.ok ? "ok" : "blocked"}`);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  processRunner: ProcessRunner = defaultProcessRunner,
): Promise<MigrationReport | undefined> {
  let options: CliOptions;
  try {
    options = parseMigrationCliArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP_SHOWN") return undefined;
    throw error;
  }

  const databaseUrl = migrationUrl(environment);
  const target = createMigrationDatabaseTarget(databaseUrl, {
    applicationName: "buwiz-books-migration-entrypoint",
  });
  const report = await runMigrationEntrypoint({
    command: options.command,
    target,
    ...(options.command === "apply"
      ? {
          phase: options.phase,
          through: options.through,
          hooks: lifecycleHooks(target, databaseUrl, environment, processRunner),
        }
      : {}),
  });
  printReport(report, options.json);
  return report;
}

if (process.argv[1]?.endsWith("/scripts/migrate.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
