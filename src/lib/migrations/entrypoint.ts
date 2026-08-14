import { createMigrationDatabaseTarget, type DatabaseTarget } from "../database-target";
import {
  createMigrationEngine,
  type MigrationEngineAdapter,
  type MigrationLifecycleHooks,
  type MigrationReport,
  type PreparedMigration,
} from "./engine";
import { loadPreparedMigrations } from "./loader";
import { createPostgresMigrationAdapter } from "./postgres-adapter";

export type MigrationEntrypointCommand = "status" | "verify" | "apply";
export type MigrationApplyPhase = "all" | PreparedMigration["phase"];

export interface MigrationEntrypointOptions {
  readonly command: MigrationEntrypointCommand;
  readonly databaseUrl?: string;
  readonly target?: DatabaseTarget;
  readonly phase?: MigrationApplyPhase;
  readonly through?: string;
  readonly hooks?: MigrationLifecycleHooks;
}

export interface ClosableMigrationAdapter extends MigrationEngineAdapter {
  close(): Promise<void>;
}

export interface MigrationEntrypointDependencies {
  readonly loadMigrations?: () => Promise<readonly PreparedMigration[]>;
  readonly createTarget?: (databaseUrl: string) => DatabaseTarget;
  readonly createAdapter?: (target: DatabaseTarget) => ClosableMigrationAdapter;
}

const noOpHook = async (): Promise<void> => undefined;

function invalid(message: string): never {
  throw new Error(`Invalid migration entrypoint request: ${message}.`);
}

function selectMigrations(
  migrations: readonly PreparedMigration[],
  phase: MigrationApplyPhase,
  through: string | undefined,
): readonly PreparedMigration[] {
  if (through !== undefined && !/^\d{4}$/.test(through)) {
    invalid(`--through must be a four-digit migration id, received ${through}`);
  }

  const selected = migrations.filter(
    (migration) =>
      (phase === "all" || migration.phase === phase) &&
      (through === undefined || migration.id <= through),
  );
  if (selected.length === 0) {
    invalid(
      `the requested ${phase} phase${through === undefined ? "" : ` through ${through}`} has no managed migrations`,
    );
  }
  return selected;
}

function lifecycleFor(
  phase: MigrationApplyPhase,
  hooks: MigrationLifecycleHooks | undefined,
): MigrationLifecycleHooks {
  if (!hooks) {
    invalid(
      "apply requires explicit prepareBaseSchema, synchronizeSchema, and finalizeSchema hooks",
    );
  }

  if (phase === "all") return hooks;

  if (phase === "pre_schema") {
    return {
      prepareBaseSchema: hooks.prepareBaseSchema,
      // A phase-only pre-schema invocation must not claim that schema sync ran.
      synchronizeSchema: noOpHook,
      finalizeSchema: noOpHook,
    };
  }

  return {
    prepareBaseSchema: noOpHook,
    synchronizeSchema: hooks.synchronizeSchema,
    finalizeSchema: hooks.finalizeSchema,
  };
}

function resolveTarget(
  options: MigrationEntrypointOptions,
  createTarget: (databaseUrl: string) => DatabaseTarget,
): DatabaseTarget {
  if (options.target) {
    if (options.databaseUrl !== undefined) {
      invalid("databaseUrl cannot be supplied together with an already-created target");
    }
    return options.target;
  }
  if (!options.databaseUrl) invalid("a migration database URL or target is required");
  return createTarget(options.databaseUrl);
}

/**
 * Run the single migration lifecycle used by local, CI, and deployment callers.
 *
 * Target parsing deliberately happens before the adapter factory. This keeps raw
 * URLs out of the adapter contract and makes wrong-purpose or malformed targets
 * fail before a database client can be created.
 */
export async function runMigrationEntrypoint(
  options: MigrationEntrypointOptions,
  dependencies: MigrationEntrypointDependencies = {},
): Promise<MigrationReport> {
  if (options.command !== "apply" && options.hooks !== undefined) {
    invalid("lifecycle hooks are only valid for apply");
  }

  const phase = options.phase ?? "all";
  if (options.command !== "apply" && phase !== "all") {
    invalid("phase selection is only valid for apply");
  }
  if (options.command === "apply" && options.hooks === undefined) {
    invalid(
      "apply requires explicit prepareBaseSchema, synchronizeSchema, and finalizeSchema hooks",
    );
  }

  const loadMigrations = dependencies.loadMigrations ?? (() => loadPreparedMigrations());
  const createTarget = dependencies.createTarget ?? createMigrationDatabaseTarget;
  const createAdapter =
    dependencies.createAdapter ??
    ((target: DatabaseTarget) => createPostgresMigrationAdapter({ target }));

  const target = resolveTarget(options, createTarget);
  const loaded = await loadMigrations();
  const migrations = selectMigrations(loaded, phase, options.through);
  const adapter = createAdapter(target);

  try {
    const engine = createMigrationEngine(migrations, adapter);
    if (options.command === "status") return await engine.status();
    if (options.command === "verify") return await engine.verify();
    return await engine.apply(lifecycleFor(phase, options.hooks));
  } finally {
    await adapter.close();
  }
}
