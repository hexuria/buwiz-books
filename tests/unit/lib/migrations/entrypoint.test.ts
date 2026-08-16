import { describe, expect, it, vi } from "vitest";
import {
  checksumMigration,
  type MigrationHistoryRow,
  type MigrationLifecycleHooks,
  type MigrationTransaction,
  type MigrationVerification,
  type PreparedMigration,
} from "@/lib/migrations/engine";
import { runMigrationEntrypoint, type ClosableMigrationAdapter } from "@/lib/migrations/entrypoint";
import type { DatabaseTarget } from "@/lib/database-target";

function migration(
  id: PreparedMigration["id"],
  phase: PreparedMigration["phase"],
): PreparedMigration {
  const sql = `SELECT '${id}';`;
  return {
    id,
    file: `${id}_test.sql`,
    historyAliases: [id],
    phase,
    checksum: checksumMigration(sql),
    execution: "plain",
    sql,
    executionSql: sql,
  };
}

function verification(state: MigrationVerification["state"]): MigrationVerification {
  return {
    state,
    evidence: [{ key: "test", status: state === "partial" ? "fail" : "pass", expected: state }],
  };
}

function adapterFor(
  events: string[],
  state: Map<string, MigrationVerification["state"]>,
  initialHistory: readonly MigrationHistoryRow[] = [],
): ClosableMigrationAdapter {
  const history = [...initialHistory];
  const adapter: ClosableMigrationAdapter = {
    async withGlobalLock<T>(operation: () => Promise<T>): Promise<T> {
      events.push("lock:start");
      const result = await operation();
      events.push("lock:end");
      return result;
    },
    async readHistory(): Promise<readonly MigrationHistoryRow[]> {
      events.push("history");
      return history;
    },
    async verifyHistoricalState(item) {
      events.push(`verify:${item.id}`);
      return verification(state.get(item.id) ?? "absent");
    },
    async transaction<T>(operation: (tx: MigrationTransaction) => Promise<T>) {
      events.push("transaction:start");
      const result = await operation({
        async verifyHistoricalState(item) {
          events.push(`tx:verify:${item.id}`);
          return verification(state.get(item.id) ?? "absent");
        },
        async prepareExecution(item) {
          events.push(`prepare:${item.id}`);
        },
        async execute(item) {
          events.push(`execute:${item.id}`);
          state.set(item.id, "complete");
        },
        async record(item) {
          events.push(`record:${item.id}`);
          const row = {
            migrationName: item.file,
            checksum: item.checksum,
            appliedAt: new Date(0),
          };
          history.push(row);
          return row;
        },
      });
      events.push("transaction:end");
      return result;
    },
    async close() {
      events.push("close");
    },
  };
  return adapter;
}

const target = {
  purpose: "migration",
  databaseName: "buwiz_books_test",
  redactedIdentity: "migration:buwiz_books_test",
} as const;

const hooks = (events: string[]): MigrationLifecycleHooks => ({
  async prepareBaseSchema() {
    events.push("prepare-base");
  },
  async synchronizeSchema() {
    events.push("schema-sync");
  },
  async finalizeSchema() {
    events.push("finalize");
  },
});

describe("runMigrationEntrypoint", () => {
  it("creates the branded target before the adapter and never passes a raw URL", async () => {
    const events: string[] = [];
    const rawUrl = "postgresql://user:password@127.0.0.1:5432/buwiz_books_test";
    const createTarget = vi.fn((raw: string) => {
      events.push(`target:${raw}`);
      return target;
    });
    const createAdapter = vi.fn((received: DatabaseTarget) => {
      events.push(`adapter:${received.redactedIdentity}`);
      return adapterFor(events, new Map());
    });

    await runMigrationEntrypoint(
      { command: "status", databaseUrl: rawUrl },
      {
        createTarget,
        createAdapter,
        loadMigrations: async () => [migration("0018", "post_schema")],
      },
    );

    expect(createTarget).toHaveBeenCalledWith(rawUrl);
    expect(createAdapter).toHaveBeenCalledWith(target);
    expect(events.slice(0, 2)).toEqual([`target:${rawUrl}`, "adapter:migration:buwiz_books_test"]);
  });

  it("routes status and verify without opening lifecycle hooks", async () => {
    const events: string[] = [];
    const item = migration("0018", "post_schema");
    const adapter = adapterFor(events, new Map([["0018", "complete"]]), [
      { migrationName: item.file, checksum: item.checksum, appliedAt: new Date(0) },
    ]);
    const dependencies = {
      createAdapter: () => adapter,
      loadMigrations: async () => [migration("0018", "post_schema")],
    };

    await runMigrationEntrypoint({ command: "status", target }, dependencies);
    await runMigrationEntrypoint({ command: "verify", target }, dependencies);

    expect(events).not.toContain("prepare-base");
    expect(events).not.toContain("schema-sync");
    expect(events).not.toContain("finalize");
  });

  it("runs the requested phase in engine order and closes after success", async () => {
    const events: string[] = [];
    const state = new Map<string, MigrationVerification["state"]>();
    const adapter = adapterFor(events, state);

    await runMigrationEntrypoint(
      {
        command: "apply",
        target,
        phase: "pre_schema",
        hooks: hooks(events),
      },
      {
        createAdapter: () => adapter,
        loadMigrations: async () => [
          migration("0018", "post_schema"),
          migration("0026", "pre_schema"),
        ],
      },
    );

    expect(events).toEqual([
      "lock:start",
      "history",
      "verify:0026",
      "prepare-base",
      "history",
      "verify:0026",
      "transaction:start",
      "tx:verify:0026",
      "prepare:0026",
      "execute:0026",
      "tx:verify:0026",
      "record:0026",
      "transaction:end",
      "history",
      "verify:0026",
      "history",
      "history",
      "verify:0026",
      "lock:end",
      "close",
    ]);
  });

  it("closes the adapter when the engine fails", async () => {
    const close = vi.fn(async () => undefined);
    const adapter: ClosableMigrationAdapter = {
      async withGlobalLock() {
        throw new Error("boom");
      },
      async readHistory() {
        return [];
      },
      async verifyHistoricalState() {
        return verification("absent");
      },
      async transaction() {
        throw new Error("unreachable");
      },
      close,
    };

    await expect(
      runMigrationEntrypoint(
        { command: "status", target },
        {
          createAdapter: () => adapter,
          loadMigrations: async () => [migration("0018", "post_schema")],
        },
      ),
    ).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects phase selection for read-only commands before adapter creation", async () => {
    const createAdapter = vi.fn();
    await expect(
      runMigrationEntrypoint(
        { command: "verify", target, phase: "post_schema" },
        {
          createAdapter,
          loadMigrations: async () => [migration("0018", "post_schema")],
        },
      ),
    ).rejects.toThrow("phase selection is only valid for apply");
    expect(createAdapter).not.toHaveBeenCalled();
  });
});
