import { checksumMigration, prepareExecutionSql, type PreparedMigration } from "./loader";
import {
  isMigrationChecksum,
  validateMigrationManifest,
  type MigrationId,
  type MigrationPhase,
} from "./manifest";

export { checksumMigration } from "./loader";
export type { PreparedMigration } from "./loader";

export interface VerificationEvidence {
  key: string;
  status: "pass" | "fail" | "not_applicable";
  expected: string;
  observed?: string;
}

export interface MigrationVerification {
  state: "absent" | "complete" | "partial";
  shape?: string;
  evidence: readonly VerificationEvidence[];
}

export interface VerificationTarget {
  through: MigrationId;
  includes(id: MigrationId): boolean;
}

export interface VerificationContext {
  /**
   * discovery: classify history before lifecycle hooks run.
   * pre_execution: a lifecycle hook may have materialized the expected base schema, but the
   * managed SQL has not run; `absent` means that exact base is safe to execute, while `complete`
   * requires independent migration evidence and is safe to adopt.
   * post_apply/final: require the migration's completed invariants for the supplied target.
   */
  mode: "discovery" | "pre_execution" | "post_apply" | "final";
  target: VerificationTarget;
}

export interface MigrationHistoryRow {
  migrationName: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationTransaction {
  verifyHistoricalState(
    migration: PreparedMigration,
    context: VerificationContext,
  ): Promise<MigrationVerification>;
  prepareExecution(migration: PreparedMigration): Promise<void>;
  execute(migration: PreparedMigration): Promise<void>;
  record(migration: PreparedMigration): Promise<MigrationHistoryRow>;
}

export interface MigrationEngineAdapter {
  withGlobalLock<T>(operation: () => Promise<T>): Promise<T>;
  readHistory(): Promise<readonly MigrationHistoryRow[]>;
  verifyHistoricalState(
    migration: PreparedMigration,
    context: VerificationContext,
  ): Promise<MigrationVerification>;
  transaction<T>(operation: (tx: MigrationTransaction) => Promise<T>): Promise<T>;
}

export interface MigrationLifecycleHooks {
  prepareBaseSchema(): Promise<void>;
  synchronizeSchema(): Promise<void>;
  finalizeSchema(): Promise<void>;
}

export type MigrationState =
  | "applied"
  | "pending"
  | "adoptable"
  | "blocked"
  | "drift"
  | "installed"
  | "adopted";

export interface MigrationOutcome {
  id: MigrationId;
  file: string;
  phase: MigrationPhase;
  checksum: string;
  state: MigrationState;
  evidence: readonly VerificationEvidence[];
}

export interface MigrationReport {
  command: "status" | "verify" | "apply";
  ok: boolean;
  outcomes: readonly MigrationOutcome[];
}

export class MigrationVerificationError extends Error {
  constructor(
    message: string,
    readonly report: MigrationReport,
  ) {
    super(message);
    this.name = "MigrationVerificationError";
  }
}

function fallbackEvidence(state: MigrationVerification["state"]): VerificationEvidence[] {
  return [
    {
      key: "historical_state",
      status: state === "partial" ? "fail" : "pass",
      expected: state,
    },
  ];
}

/**
 * Render the checks that actually failed into the rollback error.
 *
 * A verifier that returns `partial` already knows precisely which expectation
 * missed and what it saw instead, and that evidence used to be discarded: the
 * error named the migration and nothing else. On CI, where the database is gone
 * by the time anyone reads the log, that leaves no way to tell a wrong
 * expectation from a wrong migration without another full run per guess.
 */
function describeVerification(evidence: readonly VerificationEvidence[]): string {
  const failures = evidence.filter((check) => check.status === "fail");
  if (failures.length === 0) {
    return "No individual check reported a failure, which itself indicates a verifier defect.";
  }
  const detail = failures
    .map(
      (check) =>
        `${check.key} (expected ${check.expected}` +
        `${check.observed === undefined ? "" : `, observed ${check.observed}`})`,
    )
    .join("; ");
  return `Failed ${failures.length} of ${evidence.length} checks: ${detail}.`;
}

export function createMigrationEngine(
  migrations: readonly PreparedMigration[],
  adapter: MigrationEngineAdapter,
) {
  if (migrations.length === 0) throw new Error("The migration manifest is empty.");

  const validation = validateMigrationManifest(migrations);
  if (!validation.ok) {
    throw new Error(`Prepared migration manifest is invalid: ${validation.reason}.`);
  }

  for (const migration of migrations) {
    if (checksumMigration(migration.sql) !== migration.checksum) {
      throw new Error(`Prepared migration ${migration.id} has checksum drift.`);
    }
    const expectedExecutionSql = prepareExecutionSql(migration, migration.sql);
    if (migration.executionSql !== expectedExecutionSql) {
      throw new Error(
        `Prepared migration ${migration.id} has executable SQL that differs from its immutable source.`,
      );
    }
  }

  const managedMigrations = Object.freeze(
    migrations.map((migration) =>
      Object.freeze({
        ...migration,
        historyAliases: Object.freeze([...migration.historyAliases]),
      } satisfies PreparedMigration),
    ),
  );
  const lifecycleMigrations = Object.freeze([
    ...managedMigrations.filter((migration) => migration.phase === "pre_schema"),
    ...managedMigrations.filter((migration) => migration.phase === "post_schema"),
  ]);

  const byId = new Map<MigrationId, PreparedMigration>(
    managedMigrations.map((migration) => [migration.id, migration]),
  );
  const byHistoryName = new Map<string, PreparedMigration>();
  for (const migration of managedMigrations) {
    for (const name of [migration.file, ...migration.historyAliases]) {
      byHistoryName.set(name, migration);
    }
  }

  function targetFor(included: ReadonlySet<MigrationId>): VerificationTarget {
    const ordered = lifecycleMigrations.filter((migration) => included.has(migration.id));
    if (ordered.length === 0) {
      throw new Error("A verification target must include at least one managed migration.");
    }
    return {
      through: ordered.at(-1)!.id,
      includes(id) {
        return included.has(id);
      },
    };
  }

  const allIds = new Set(managedMigrations.map((migration) => migration.id));
  const finalTarget = targetFor(allIds);
  const discoveryContext: VerificationContext = {
    mode: "discovery",
    target: finalTarget,
  };
  const finalContext: VerificationContext = {
    mode: "final",
    target: finalTarget,
  };
  const preExecutionContext: VerificationContext = {
    mode: "pre_execution",
    target: finalTarget,
  };
  const noRecordedHistoryContext = discoveryContext;

  function outcome(
    migration: PreparedMigration,
    state: MigrationState,
    verification: MigrationVerification,
  ): MigrationOutcome {
    return {
      id: migration.id,
      file: migration.file,
      phase: migration.phase,
      checksum: migration.checksum,
      state,
      evidence:
        verification.evidence.length > 0
          ? verification.evidence
          : fallbackEvidence(verification.state),
    };
  }

  async function checkedHistory(): Promise<{
    resolved: Map<MigrationId, MigrationHistoryRow>;
    drift: Map<MigrationId, MigrationOutcome>;
    historicalPrefix: ReadonlySet<MigrationId>;
    recordedContext: VerificationContext;
  }> {
    const resolved = new Map<MigrationId, MigrationHistoryRow>();
    const drift = new Map<MigrationId, MigrationOutcome>();

    for (const row of await adapter.readHistory()) {
      const migration = byHistoryName.get(row.migrationName);
      if (!migration) {
        const claimedId = row.migrationName.match(/^(\d{4})(?:_|$)/)?.[1];
        if (claimedId && byId.has(claimedId as MigrationId)) {
          throw new Error(
            `History row ${row.migrationName} ambiguously claims managed migration ${claimedId}.`,
          );
        }
        continue;
      }
      if (resolved.has(migration.id) || drift.has(migration.id)) {
        throw new Error(`Migration ${migration.id} has duplicate history aliases.`);
      }

      const storedChecksum = row.checksum.trim();
      if (!isMigrationChecksum(storedChecksum)) {
        throw new Error(`Migration ${migration.id} has a malformed stored checksum.`);
      }
      if (storedChecksum !== migration.checksum) {
        drift.set(
          migration.id,
          outcome(migration, "drift", {
            state: "partial",
            evidence: [
              {
                key: "immutable_checksum",
                status: "fail",
                expected: migration.checksum,
                observed: storedChecksum,
              },
            ],
          }),
        );
        continue;
      }
      resolved.set(migration.id, row);
    }

    const recordedIds = new Set<MigrationId>([...resolved.keys(), ...drift.keys()]);
    let lastRecordedIndex = -1;
    for (let index = lifecycleMigrations.length - 1; index >= 0; index -= 1) {
      if (recordedIds.has(lifecycleMigrations[index].id)) {
        lastRecordedIndex = index;
        break;
      }
    }
    const historicalPrefix = new Set(
      lifecycleMigrations.slice(0, lastRecordedIndex + 1).map((migration) => migration.id),
    );

    return {
      resolved,
      drift,
      historicalPrefix,
      recordedContext: {
        mode: "final",
        target:
          historicalPrefix.size > 0 ? targetFor(historicalPrefix) : noRecordedHistoryContext.target,
      },
    };
  }

  async function classify(
    migration: PreparedMigration,
    history: Map<MigrationId, MigrationHistoryRow>,
    fillsHistoryGap: boolean,
    recordedContext: VerificationContext,
    context: VerificationContext,
  ): Promise<MigrationOutcome> {
    const verification = await adapter.verifyHistoricalState(
      migration,
      history.has(migration.id) || fillsHistoryGap ? recordedContext : context,
    );
    if (history.has(migration.id)) {
      return outcome(
        migration,
        verification.state === "complete" ? "applied" : "blocked",
        verification,
      );
    }
    if (fillsHistoryGap) {
      return outcome(
        migration,
        verification.state === "complete" ? "adoptable" : "blocked",
        verification,
      );
    }
    if (verification.state === "complete") {
      return outcome(migration, "adoptable", verification);
    }
    if (verification.state === "absent") {
      return outcome(migration, "pending", verification);
    }
    return outcome(migration, "blocked", verification);
  }

  async function inspect(context: VerificationContext): Promise<MigrationOutcome[]> {
    const { resolved, drift, historicalPrefix, recordedContext } = await checkedHistory();
    const results: MigrationOutcome[] = [];
    for (const migration of managedMigrations) {
      results.push(
        drift.get(migration.id) ??
          (await classify(
            migration,
            resolved,
            historicalPrefix.has(migration.id) && !resolved.has(migration.id),
            recordedContext,
            context,
          )),
      );
    }
    return results;
  }

  async function statusLocked(): Promise<MigrationReport> {
    const outcomes = await inspect(discoveryContext);
    return {
      command: "status",
      ok: outcomes.every((entry) => entry.state !== "blocked" && entry.state !== "drift"),
      outcomes,
    };
  }

  async function verificationReport(command: MigrationReport["command"]): Promise<MigrationReport> {
    const outcomes = await inspect(finalContext);
    const report: MigrationReport = {
      command,
      ok: outcomes.every((entry) => entry.state === "applied"),
      outcomes,
    };
    if (!report.ok) {
      throw new MigrationVerificationError(
        "Managed migrations are not fully recorded and verified.",
        report,
      );
    }
    return report;
  }

  function verifyLocked(): Promise<MigrationReport> {
    return verificationReport("verify");
  }

  async function assertIncludedComplete(
    included: ReadonlySet<MigrationId>,
    message: string,
  ): Promise<void> {
    const { drift, historicalPrefix, recordedContext } = await checkedHistory();
    const includedContext: VerificationContext | null =
      included.size > 0
        ? {
            mode: "final",
            target: targetFor(included),
          }
        : null;
    const outcomes: MigrationOutcome[] = [];
    for (const migration of managedMigrations) {
      if (!included.has(migration.id)) continue;
      if (drift.has(migration.id)) {
        outcomes.push(drift.get(migration.id)!);
        continue;
      }
      const verification = await adapter.verifyHistoricalState(
        migration,
        historicalPrefix.has(migration.id) ? recordedContext : includedContext!,
      );
      outcomes.push(
        outcome(migration, verification.state === "complete" ? "applied" : "blocked", verification),
      );
    }
    const blocked = outcomes.find((entry) => entry.state !== "applied");
    if (blocked) {
      throw new MigrationVerificationError(message, {
        command: "apply",
        ok: false,
        outcomes,
      });
    }
  }

  async function replanFrozenPhase(
    frozen: readonly MigrationOutcome[],
    phase: MigrationPhase,
    message: string,
  ): Promise<MigrationOutcome[]> {
    const { resolved, drift, historicalPrefix, recordedContext } = await checkedHistory();
    const outcomes: MigrationOutcome[] = [];

    for (const frozenOutcome of frozen.filter((entry) => entry.phase === phase)) {
      const migration = byId.get(frozenOutcome.id)!;
      const drifted = drift.get(migration.id);
      if (drifted) {
        outcomes.push(drifted);
        continue;
      }

      const verificationContext =
        frozenOutcome.state === "pending"
          ? preExecutionContext
          : historicalPrefix.has(migration.id)
            ? recordedContext
            : finalContext;
      const verification = await adapter.verifyHistoricalState(migration, verificationContext);
      const historyShouldExist = frozenOutcome.state === "applied";
      const historyMatches = resolved.has(migration.id) === historyShouldExist;
      let replannedState: MigrationState = "blocked";
      if (historyMatches) {
        if (frozenOutcome.state === "applied" && verification.state === "complete") {
          replannedState = "applied";
        } else if (frozenOutcome.state === "adoptable" && verification.state === "complete") {
          replannedState = "adoptable";
        } else if (frozenOutcome.state === "pending") {
          if (verification.state === "absent") replannedState = "pending";
          if (verification.state === "complete") replannedState = "adoptable";
        }
      }
      outcomes.push(outcome(migration, replannedState, verification));
    }

    const changed = outcomes.filter(
      (entry) => entry.state === "blocked" || entry.state === "drift",
    );
    if (changed.length > 0) {
      // Naming the migration and the checks that moved it is the whole difference
      // between a diagnosable rollback and another full CI run spent guessing.
      const detail = changed
        .map(
          (entry) =>
            `${entry.id} is ${entry.state} (was ${
              frozen.find((item) => item.id === entry.id)?.state ?? "unknown"
            }). ${describeVerification(entry.evidence)}`,
        )
        .join(" ");
      throw new MigrationVerificationError(`${message} ${detail}`, {
        command: "apply",
        ok: false,
        outcomes,
      });
    }
    return outcomes;
  }

  async function applyPlanned(
    planned: readonly MigrationOutcome[],
    included: Set<MigrationId>,
  ): Promise<MigrationOutcome[]> {
    const results: MigrationOutcome[] = [];
    for (const plannedOutcome of planned) {
      const migration = byId.get(plannedOutcome.id)!;
      included.add(migration.id);
      if (plannedOutcome.state === "applied") {
        results.push(plannedOutcome);
        continue;
      }

      const context: VerificationContext = {
        mode: "post_apply",
        target: targetFor(included),
      };
      const verification = await adapter.transaction(async (tx) => {
        if (plannedOutcome.state === "pending") {
          const preflight = await tx.verifyHistoricalState(migration, preExecutionContext);
          if (preflight.state !== "absent") {
            throw new Error(
              `${migration.id} changed before execution; the transaction was rolled back without running managed SQL. ` +
                `Observed state ${preflight.state}${preflight.shape === undefined ? "" : ` (shape ${preflight.shape})`}. ` +
                describeVerification(preflight.evidence),
            );
          }
          if (
            checksumMigration(migration.sql) !== migration.checksum ||
            prepareExecutionSql(migration, migration.sql) !== migration.executionSql
          ) {
            throw new Error(`Prepared migration ${migration.id} changed after validation.`);
          }
          await tx.prepareExecution(migration);
          await tx.execute(migration);
        }
        const current = await tx.verifyHistoricalState(migration, context);
        if (current.state !== "complete") {
          const action = plannedOutcome.state === "adoptable" ? "adoption" : "execution";
          throw new Error(
            `${migration.id} changed or failed verification during ${action}; the transaction was rolled back. ` +
              `Observed state ${current.state}${current.shape === undefined ? "" : ` (shape ${current.shape})`}. ` +
              describeVerification(current.evidence),
          );
        }
        await tx.record(migration);
        return current;
      });
      results.push(
        outcome(
          migration,
          plannedOutcome.state === "adoptable" ? "adopted" : "installed",
          verification,
        ),
      );
    }
    return results;
  }

  async function applyLocked(hooks: MigrationLifecycleHooks): Promise<MigrationReport> {
    const initial = await inspect(discoveryContext);
    const blocking = initial.find((entry) => entry.state === "blocked" || entry.state === "drift");
    if (blocking) {
      throw new MigrationVerificationError(
        `Migration ${blocking.id} is blocked; no managed migration was changed.`,
        { command: "apply", ok: false, outcomes: initial },
      );
    }

    await hooks.prepareBaseSchema();
    const prePlan = await replanFrozenPhase(
      initial,
      "pre_schema",
      "Base schema preparation changed a frozen migration decision; pre-schema migrations were not started.",
    );
    const included = new Set(
      initial
        .filter((entry) => entry.state === "applied" || entry.state === "adoptable")
        .map((entry) => entry.id),
    );
    const preResults = await applyPlanned(prePlan, included);
    await hooks.synchronizeSchema();
    await assertIncludedComplete(
      included,
      "Schema synchronization invalidated a completed migration; post-schema migrations were not started.",
    );
    const postPlan = await replanFrozenPhase(
      initial,
      "post_schema",
      "Schema synchronization changed a frozen migration decision; post-schema migrations were not started.",
    );
    const postResults = await applyPlanned(postPlan, included);
    await hooks.finalizeSchema();
    await verificationReport("apply");

    return {
      command: "apply",
      ok: true,
      outcomes: [...preResults, ...postResults],
    };
  }

  return {
    status(): Promise<MigrationReport> {
      return adapter.withGlobalLock(statusLocked);
    },
    verify(): Promise<MigrationReport> {
      return adapter.withGlobalLock(verifyLocked);
    },
    apply(hooks: MigrationLifecycleHooks): Promise<MigrationReport> {
      return adapter.withGlobalLock(() => applyLocked(hooks));
    },
  };
}
