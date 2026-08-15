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

/**
 * Parsing reports "the caller asked for help" as an outcome rather than an error.
 * A sentinel exception would have to be recognized by message text, which is how a
 * help request becomes a failure the moment someone rewords the string.
 */
export type MigrationCliRequest = { kind: "help" } | { kind: "run"; options: CliOptions };

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

Exits non-zero whenever the report is not ok, including a blocked or
drifted status, so Make and CI can act on the result.
`;

const VALUED_OPTIONS = ["--phase", "--through"] as const;
type ValuedOption = (typeof VALUED_OPTIONS)[number];

function parsePhase(value: string): MigrationApplyPhase {
  if (value === "all" || value === "pre_schema" || value === "post_schema") return value;
  throw new Error(`Invalid --phase ${value}; expected all, pre_schema, or post_schema.`);
}

export function parseMigrationCliArgs(argv: readonly string[]): MigrationCliRequest {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") return { kind: "help" };
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
    if (argument === "--help" || argument === "-h") return { kind: "help" };

    // One branch serves both `--phase value` and `--phase=value`; splitting them
    // duplicated every option's handling and let the two forms drift apart.
    const separator = argument.indexOf("=");
    const name = (separator === -1 ? argument : argument.slice(0, separator)) as ValuedOption;
    if (!VALUED_OPTIONS.includes(name)) {
      throw new Error(`Unknown migration option ${argument}.`);
    }
    let value: string | undefined;
    if (separator === -1) {
      value = rest[index + 1];
      index += 1;
    } else {
      value = argument.slice(separator + 1);
    }
    if (!value) throw new Error(`${name} requires a value.`);
    if (name === "--phase") phase = parsePhase(value);
    else through = value;
  }

  if (command !== "apply" && phase !== "all") {
    throw new Error("--phase is only valid with apply.");
  }
  return { kind: "run", options: { command, phase, through, json } };
}

/**
 * A report that is not ok must fail the process. `status` deliberately returns a
 * blocked or drifted report instead of throwing, so without this the one command
 * meant to surface drift would exit 0 and read as green.
 */
export function migrationExitCode(report: MigrationReport): 0 | 1 {
  return report.ok ? 0 : 1;
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
  // Async so the guard rejects rather than throwing synchronously out of a
  // Promise-returning hook; a caller attaching .catch() would otherwise crash.
  const guarded = async (args: readonly string[]) => {
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
  const request = parseMigrationCliArgs(argv);
  if (request.kind === "help") {
    console.log(usage.trim());
    return undefined;
  }
  const { options } = request;

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
  process.exitCode = migrationExitCode(report);
  return report;
}

if (process.argv[1]?.endsWith("/scripts/migrate.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
