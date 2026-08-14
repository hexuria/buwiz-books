import { describe, expect, it, vi } from "vitest";
import {
  MigrationVerificationError,
  checksumMigration,
  createMigrationEngine,
  type MigrationEngineAdapter,
  type MigrationHistoryRow,
  type MigrationLifecycleHooks,
  type MigrationVerification,
  type PreparedMigration,
  type VerificationContext,
} from "@/lib/migrations/engine";

function migration(id: PreparedMigration["id"], phase: PreparedMigration["phase"] = "post_schema") {
  const sql = `SELECT '${id}';`;
  return {
    id,
    file: `${id}_test.sql`,
    historyAliases: [id],
    phase,
    sql,
    executionSql: sql,
    checksum: checksumMigration(sql),
    execution: "plain",
  } satisfies PreparedMigration;
}

function history(item: PreparedMigration, name: string = item.file): MigrationHistoryRow {
  return {
    migrationName: name,
    checksum: item.checksum,
    appliedAt: new Date(0),
  };
}

function verification(state: MigrationVerification["state"]): MigrationVerification {
  return {
    state,
    evidence: [
      {
        key: "shape",
        status: state === "partial" ? "fail" : "pass",
        expected: state,
      },
    ],
  };
}

function fakeAdapter(
  rows: MigrationHistoryRow[] = [],
  initialStates: Readonly<Record<string, MigrationVerification["state"]>> = {},
): MigrationEngineAdapter & {
  executed: string[];
  prepared: string[];
  recorded: string[];
  transactions: number;
  states: Map<string, MigrationVerification["state"]>;
  contexts: Array<{
    location: "adapter" | "transaction";
    id: string;
    mode: string;
    through: string;
    includes: string[];
  }>;
} {
  const states = new Map(Object.entries(initialStates));
  const adapter = {
    executed: [] as string[],
    prepared: [] as string[],
    recorded: [] as string[],
    transactions: 0,
    states,
    contexts: [] as Array<{
      location: "adapter" | "transaction";
      id: string;
      mode: string;
      through: string;
      includes: string[];
    }>,
    async withGlobalLock<T>(operation: () => Promise<T>) {
      return operation();
    },
    async readHistory() {
      return rows;
    },
    async verifyHistoricalState(item: PreparedMigration, context: VerificationContext) {
      adapter.contexts.push({
        location: "adapter",
        id: item.id,
        mode: context.mode,
        through: context.target.through,
        includes: ["0018", "0019", "0026", "0027"].filter((id) =>
          context.target.includes(id as PreparedMigration["id"]),
        ),
      });
      return verification(states.get(item.id) ?? "absent");
    },
    async transaction<T>(operation: (tx: any) => Promise<T>) {
      adapter.transactions += 1;
      return operation({
        async verifyHistoricalState(item: PreparedMigration, context: VerificationContext) {
          adapter.contexts.push({
            location: "transaction",
            id: item.id,
            mode: context.mode,
            through: context.target.through,
            includes: ["0018", "0019", "0026", "0027"].filter((id) =>
              context.target.includes(id as PreparedMigration["id"]),
            ),
          });
          return verification(states.get(item.id) ?? "absent");
        },
        async execute(item: PreparedMigration) {
          adapter.executed.push(item.id);
          states.set(item.id, "complete");
        },
        async prepareExecution(item: PreparedMigration) {
          adapter.prepared.push(item.id);
        },
        async record(item: PreparedMigration) {
          adapter.recorded.push(item.id);
          const row = history(item);
          rows.push(row);
          return row;
        },
      });
    },
  };
  return adapter;
}

function lifecycleHooks(events: string[] = []): MigrationLifecycleHooks {
  return {
    async prepareBaseSchema() {
      events.push("baseline");
    },
    async synchronizeSchema() {
      events.push("schema-sync");
    },
    async finalizeSchema() {
      events.push("finalize");
    },
  };
}

describe("migration engine", () => {
  it("rejects prepared migrations that are not in strict manifest order", () => {
    expect(() =>
      createMigrationEngine([migration("0019"), migration("0018")], fakeAdapter()),
    ).toThrow(/out of order/i);
  });

  it("rejects invalid prepared migrations before touching the adapter", () => {
    const adapter = fakeAdapter();
    const readHistory = vi.spyOn(adapter, "readHistory");
    const item = migration("0018");

    expect(() => createMigrationEngine([], adapter)).toThrow(/manifest is empty/i);
    expect(() => createMigrationEngine([item, { ...item, id: "0019" }], adapter)).toThrow(
      /duplicate ids or files|mismatched file/i,
    );
    expect(() => createMigrationEngine([{ ...item, checksum: "0".repeat(64) }], adapter)).toThrow(
      /checksum drift/i,
    );
    expect(() => createMigrationEngine([{ ...item, executionSql: "" }], adapter)).toThrow(
      /differs from its immutable source/i,
    );
    expect(() => createMigrationEngine([{ ...item, file: "0018_../unsafe.sql" }], adapter)).toThrow(
      /mismatched file/i,
    );
    expect(() =>
      createMigrationEngine([{ ...item, phase: "during_schema" as never }], adapter),
    ).toThrow(/invalid phase/i);
    expect(() =>
      createMigrationEngine([{ ...item, execution: "nested" as never }], adapter),
    ).toThrow(/invalid execution mode/i);
    expect(() =>
      createMigrationEngine([{ ...item, executionSql: "DROP TABLE accounts;" }], adapter),
    ).toThrow(/differs from its immutable source/i);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it("executes a frozen defensive copy when caller mutates input after construction", async () => {
    const input = migration("0018") as PreparedMigration & {
      executionSql: string;
      checksum: string;
      historyAliases: string[];
    };
    let executed: PreparedMigration | undefined;
    const adapter = fakeAdapter();
    const baseTransaction = adapter.transaction;
    adapter.transaction = (operation) =>
      baseTransaction((tx) =>
        operation({
          ...tx,
          async execute(item) {
            executed = item;
            await tx.execute(item);
          },
        }),
      );
    const engine = createMigrationEngine([input], adapter);

    input.executionSql = "DROP TABLE accounts;";
    input.checksum = "0".repeat(64);
    input.historyAliases[0] = "tampered";
    await engine.apply(lifecycleHooks());

    expect(executed).toMatchObject({
      id: "0018",
      executionSql: "SELECT '0018';",
      checksum: checksumMigration("SELECT '0018';"),
      historyAliases: ["0018"],
    });
    expect(Object.isFrozen(executed)).toBe(true);
    expect(Object.isFrozen(executed?.historyAliases)).toBe(true);
  });

  it("reports every migration independently without writing", async () => {
    const migrations = [migration("0018"), migration("0019")];
    const stored = history(migrations[0]);
    const adapter = fakeAdapter([stored], { "0018": "complete" });

    await expect(createMigrationEngine(migrations, adapter).status()).resolves.toMatchObject({
      command: "status",
      ok: true,
      outcomes: [
        { id: "0018", state: "applied" },
        { id: "0019", state: "pending" },
      ],
    });
    expect(adapter.transactions).toBe(0);
    expect(stored).toEqual(history(migrations[0]));
  });

  it("passes mode and target context across the verifier seam", async () => {
    const migrations = [migration("0018", "post_schema"), migration("0026", "pre_schema")];
    const adapter = fakeAdapter([history(migrations[1])], {
      "0026": "complete",
    });
    const contexts: Array<{ id: string; mode: string; includes: string[] }> = [];
    adapter.verifyHistoricalState = async (item, context) => {
      contexts.push({
        id: item.id,
        mode: context.mode,
        includes: migrations
          .filter((migration) => context.target.includes(migration.id))
          .map((migration) => migration.id),
      });
      return verification(adapter.states.get(item.id) ?? "absent");
    };

    await createMigrationEngine(migrations, adapter).status();
    expect(contexts).toEqual([
      { id: "0018", mode: "discovery", includes: ["0018", "0026"] },
      { id: "0026", mode: "final", includes: ["0026"] },
    ]);
  });

  it("verifies recorded migrations against their contiguous history prefix", async () => {
    const migrations = [
      migration("0018", "post_schema"),
      migration("0019", "post_schema"),
      migration("0026", "pre_schema"),
      migration("0027", "pre_schema"),
    ];
    const adapter = fakeAdapter(
      [history(migrations[2]), history(migrations[3]), history(migrations[0])],
      { "0018": "complete", "0026": "complete", "0027": "complete" },
    );

    await createMigrationEngine(migrations, adapter).status();

    expect(
      adapter.contexts
        .filter((context) => ["0026", "0027", "0018"].includes(context.id))
        .map(({ id, mode, through, includes }) => ({
          id,
          mode,
          through,
          includes,
        })),
    ).toEqual([
      {
        id: "0018",
        mode: "final",
        through: "0018",
        includes: ["0018", "0026", "0027"],
      },
      {
        id: "0026",
        mode: "final",
        through: "0018",
        includes: ["0018", "0026", "0027"],
      },
      {
        id: "0027",
        mode: "final",
        through: "0018",
        includes: ["0018", "0026", "0027"],
      },
    ]);
  });

  it("passes incremental post-apply targets in phase order", async () => {
    const migrations = [
      migration("0018", "post_schema"),
      migration("0019", "post_schema"),
      migration("0026", "pre_schema"),
      migration("0027", "pre_schema"),
    ];
    const adapter = fakeAdapter();

    const report = await createMigrationEngine(migrations, adapter).apply(lifecycleHooks());

    expect(
      adapter.contexts
        .filter((context) => context.location === "transaction")
        .map(({ id, mode, through, includes }) => ({
          id,
          mode,
          through,
          includes,
        })),
    ).toEqual([
      {
        id: "0026",
        mode: "pre_execution",
        through: "0019",
        includes: ["0018", "0019", "0026", "0027"],
      },
      { id: "0026", mode: "post_apply", through: "0026", includes: ["0026"] },
      {
        id: "0027",
        mode: "pre_execution",
        through: "0019",
        includes: ["0018", "0019", "0026", "0027"],
      },
      {
        id: "0027",
        mode: "post_apply",
        through: "0027",
        includes: ["0026", "0027"],
      },
      {
        id: "0018",
        mode: "pre_execution",
        through: "0019",
        includes: ["0018", "0019", "0026", "0027"],
      },
      {
        id: "0018",
        mode: "post_apply",
        through: "0018",
        includes: ["0018", "0026", "0027"],
      },
      {
        id: "0019",
        mode: "pre_execution",
        through: "0019",
        includes: ["0018", "0019", "0026", "0027"],
      },
      {
        id: "0019",
        mode: "post_apply",
        through: "0019",
        includes: ["0018", "0019", "0026", "0027"],
      },
    ]);
    expect(report.outcomes.map((outcome) => outcome.id)).toEqual(["0026", "0027", "0018", "0019"]);
  });

  it("re-verifies recorded pre-schema work against the current history prefix", async () => {
    const migrations = [migration("0018", "post_schema"), migration("0026", "pre_schema")];
    const adapter = fakeAdapter();

    await createMigrationEngine(migrations, adapter).apply(lifecycleHooks());

    expect(
      adapter.contexts
        .filter(
          (context) =>
            context.location === "adapter" && context.id === "0026" && context.mode === "final",
        )
        .map(({ through, includes }) => ({ through, includes })),
    ).toEqual([
      { through: "0026", includes: ["0026"] },
      { through: "0018", includes: ["0018", "0026"] },
    ]);
  });

  it("accepts a canonical-id alias but rejects duplicate aliases", async () => {
    const migrations = [migration("0018")];
    await expect(
      createMigrationEngine(
        migrations,
        fakeAdapter([history(migrations[0], "0018")], { "0018": "complete" }),
      ).status(),
    ).resolves.toMatchObject({ outcomes: [{ state: "applied" }] });

    await expect(
      createMigrationEngine(
        migrations,
        fakeAdapter([history(migrations[0]), history(migrations[0], "0018")]),
      ).status(),
    ).rejects.toThrow(/duplicate history aliases/i);
  });

  it("blocks a recorded history gap whose missing migration is absent", async () => {
    const migrations = [
      migration("0018", "post_schema"),
      migration("0026", "pre_schema"),
      migration("0027", "pre_schema"),
    ];
    const adapter = fakeAdapter([history(migrations[1]), history(migrations[0])], {
      "0018": "complete",
      "0026": "complete",
    });

    const report = await createMigrationEngine(migrations, adapter).status();
    expect(report.ok).toBe(false);
    expect(report.outcomes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "0027", state: "blocked" })]),
    );
  });

  it("adopts verified legacy history gaps in lifecycle order without executing SQL", async () => {
    const ids = [
      "0018",
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
    ] as const;
    const migrations = ids.map((id) =>
      migration(id, id === "0026" || id === "0027" ? "pre_schema" : "post_schema"),
    );
    const intentionallyUnjournaled = new Set(["0018", "0025", "0026", "0027"]);
    const rows = migrations
      .filter((item) => !intentionallyUnjournaled.has(item.id))
      .map((item) => history(item));
    const states = Object.fromEntries(ids.map((id) => [id, "complete"] as const));
    const adapter = fakeAdapter(rows, states);
    const engine = createMigrationEngine(migrations, adapter);

    const report = await engine.status();
    expect(report.ok).toBe(true);
    expect(report.outcomes).toEqual(
      expect.arrayContaining(
        ["0018", "0025", "0026", "0027"].map((id) =>
          expect.objectContaining({ id, state: "adoptable" }),
        ),
      ),
    );

    await engine.apply(lifecycleHooks());

    expect(adapter.executed).toEqual([]);
    expect(adapter.recorded).toEqual(["0026", "0027", "0018", "0025"]);
  });

  it("reports checksum drift but rejects malformed and ambiguous history", async () => {
    const migrations = [migration("0018")];
    await expect(
      createMigrationEngine(
        migrations,
        fakeAdapter([{ ...history(migrations[0]), checksum: "0".repeat(64) }]),
      ).status(),
    ).resolves.toMatchObject({
      ok: false,
      outcomes: [
        {
          state: "drift",
          evidence: [
            {
              key: "immutable_checksum",
              expected: migrations[0].checksum,
              observed: "0".repeat(64),
            },
          ],
        },
      ],
    });
    await expect(
      createMigrationEngine(
        migrations,
        fakeAdapter([{ ...history(migrations[0]), checksum: "bad" }]),
      ).status(),
    ).rejects.toThrow(/malformed stored checksum/i);
    await expect(
      createMigrationEngine(
        migrations,
        fakeAdapter([history(migrations[0], "0018_wrong.sql")]),
      ).status(),
    ).rejects.toThrow(/ambiguously claims managed migration/i);
  });

  it("ignores and preserves unrelated history rows", async () => {
    const item = migration("0018");
    const unrelated: MigrationHistoryRow = {
      migrationName: "0017_legacy_evidence.sql",
      checksum: "f".repeat(64),
      appliedAt: new Date(1),
    };
    const rows = [unrelated];
    const adapter = fakeAdapter(rows);

    await createMigrationEngine([item], adapter).apply(lifecycleHooks());

    expect(rows[0]).toBe(unrelated);
    expect(rows).toEqual([unrelated, history(item)]);
  });

  it.each([
    [true, "complete", "applied"],
    [true, "absent", "blocked"],
    [true, "partial", "blocked"],
    [false, "complete", "adoptable"],
    [false, "absent", "pending"],
    [false, "partial", "blocked"],
  ] as const)("classifies history=%s and verifier=%s as %s", async (recorded, state, expected) => {
    const item = migration("0018");
    const adapter = fakeAdapter(recorded ? [history(item)] : [], {
      "0018": state,
    });
    await expect(createMigrationEngine([item], adapter).status()).resolves.toMatchObject({
      outcomes: [{ state: expected }],
    });
  });

  it("makes verify stricter than status", async () => {
    const engine = createMigrationEngine([migration("0018")], fakeAdapter());
    await expect(engine.status()).resolves.toMatchObject({
      ok: true,
      outcomes: [{ state: "pending" }],
    });
    await expect(engine.verify()).rejects.toBeInstanceOf(MigrationVerificationError);
  });

  it("preflights the whole manifest and changes nothing when any migration is blocked", async () => {
    const adapter = fakeAdapter([], { "0019": "partial" });
    const events: string[] = [];
    const error = await createMigrationEngine([migration("0018"), migration("0019")], adapter)
      .apply(lifecycleHooks(events))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationError);
    expect((error as MigrationVerificationError).report).toMatchObject({
      command: "apply",
      ok: false,
      outcomes: [{ id: "0018" }, { id: "0019", state: "blocked" }],
    });
    expect(adapter.executed).toEqual([]);
    expect(adapter.recorded).toEqual([]);
    expect(events).toEqual([]);
  });

  it("installs and adopts in lifecycle order through transaction-bound operations", async () => {
    const adapter = fakeAdapter([], { "0019": "complete" });
    const report = await createMigrationEngine(
      [migration("0018"), migration("0019")],
      adapter,
    ).apply(lifecycleHooks());

    expect(report.outcomes.map((entry) => [entry.id, entry.state])).toEqual([
      ["0018", "installed"],
      ["0019", "adopted"],
    ]);
    expect(adapter.executed).toEqual(["0018"]);
    expect(adapter.recorded).toEqual(["0018", "0019"]);
    expect(adapter.transactions).toBe(2);
  });

  it("preflights pending execution before prepare, execute, verify, and record in one transaction", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter();
    const events: string[] = [];
    let installed = false;
    adapter.verifyHistoricalState = async () => verification(installed ? "complete" : "absent");
    adapter.readHistory = async () => (installed ? [history(item)] : []);
    adapter.transaction = async (operation) =>
      operation({
        async prepareExecution() {
          events.push("prepare");
        },
        async execute() {
          events.push("execute");
          installed = true;
        },
        async verifyHistoricalState(_item, context) {
          events.push(`verify:${context.mode}`);
          return verification(context.mode === "pre_execution" ? "absent" : "complete");
        },
        async record() {
          events.push("record");
          return history(item);
        },
      });

    await createMigrationEngine([item], adapter).apply(lifecycleHooks());

    expect(events).toEqual([
      "verify:pre_execution",
      "prepare",
      "execute",
      "verify:post_apply",
      "record",
    ]);
  });

  it("stops before preparation when transaction-local preflight changes the frozen plan", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter();
    const events: string[] = [];
    adapter.transaction = async (operation) =>
      operation({
        async verifyHistoricalState(_item, context) {
          events.push(`verify:${context.mode}`);
          return verification("partial");
        },
        async prepareExecution() {
          events.push("prepare");
        },
        async execute() {
          events.push("execute");
        },
        async record() {
          events.push("record");
          return history(item);
        },
      });

    await expect(createMigrationEngine([item], adapter).apply(lifecycleHooks())).rejects.toThrow(
      /changed before execution/i,
    );

    expect(events).toEqual(["verify:pre_execution"]);
  });

  it("adopts complete historical state without preparing or executing SQL", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter([], { "0018": "complete" });
    const events: string[] = [];
    adapter.transaction = async (operation) =>
      operation({
        async prepareExecution() {
          events.push("prepare");
        },
        async execute() {
          events.push("execute");
        },
        async verifyHistoricalState(_item, context) {
          events.push(`verify:${context.mode}`);
          return verification(context.mode === "pre_execution" ? "absent" : "complete");
        },
        async record() {
          events.push("record");
          adapter.states.set(item.id, "complete");
          return history(item);
        },
      });
    adapter.readHistory = async () => (events.includes("record") ? [history(item)] : []);

    await createMigrationEngine([item], adapter).apply(lifecycleHooks());

    expect(events).toEqual(["verify:post_apply", "record"]);
  });

  it("stops a pending transaction immediately when preparation fails", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter();
    const events: string[] = [];
    adapter.transaction = async (operation) =>
      operation({
        async prepareExecution() {
          events.push("prepare");
          throw new Error("ambiguous compatibility state");
        },
        async execute() {
          events.push("execute");
        },
        async verifyHistoricalState(_item, context) {
          events.push(`verify:${context.mode}`);
          return verification(context.mode === "pre_execution" ? "absent" : "complete");
        },
        async record() {
          events.push("record");
          return history(item);
        },
      });

    await expect(createMigrationEngine([item], adapter).apply(lifecycleHooks())).rejects.toThrow(
      /ambiguous compatibility state/i,
    );
    expect(events).toEqual(["verify:pre_execution", "prepare"]);
  });

  it("adopts historical state only after re-verifying inside the transaction", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter([], { "0018": "complete" });
    adapter.transaction = async (operation) =>
      operation({
        verifyHistoricalState: vi.fn(async () => verification("partial")),
        prepareExecution: vi.fn(),
        execute: vi.fn(),
        record: vi.fn(),
      });

    await expect(createMigrationEngine([item], adapter).apply(lifecycleHooks())).rejects.toThrow(
      /changed or failed verification during adoption/i,
    );
  });

  it("holds one global lock for each complete command", async () => {
    for (const command of ["status", "verify", "apply"] as const) {
      const events: string[] = [];
      const item = migration("0018");
      const adapter = fakeAdapter(command === "verify" ? [history(item)] : [], {
        "0018": "complete",
      });
      adapter.withGlobalLock = async (operation) => {
        events.push("lock:start");
        const value = await operation();
        events.push("lock:end");
        return value;
      };

      const engine = createMigrationEngine([item], adapter);
      await (command === "apply" ? engine.apply(lifecycleHooks()) : engine[command]());
      expect(events).toEqual(["lock:start", "lock:end"]);
    }
  });

  it("holds the lock across baseline, pre-schema, schema sync, post-schema, and finalization", async () => {
    const events: string[] = [];
    const adapter = fakeAdapter();
    adapter.withGlobalLock = async (operation) => {
      events.push("lock:start");
      const value = await operation();
      events.push("lock:end");
      return value;
    };
    const baseTransaction = adapter.transaction;
    adapter.transaction = (operation) =>
      baseTransaction(async (tx) => {
        const baseExecute = tx.execute;
        tx.execute = async (item) => {
          events.push(`execute:${item.id}`);
          await baseExecute(item);
        };
        return operation(tx);
      });

    await createMigrationEngine(
      [migration("0018", "post_schema"), migration("0026", "pre_schema")],
      adapter,
    ).apply(lifecycleHooks(events));

    expect(events).toEqual([
      "lock:start",
      "baseline",
      "execute:0026",
      "schema-sync",
      "execute:0018",
      "finalize",
      "lock:end",
    ]);
  });

  it("re-verifies completed pre-schema work before any post-schema write", async () => {
    const events: string[] = [];
    const adapter = fakeAdapter();
    const hooks = lifecycleHooks(events);
    hooks.synchronizeSchema = async () => {
      events.push("schema-sync");
      adapter.states.set("0026", "partial");
    };

    const error = await createMigrationEngine(
      [migration("0018", "post_schema"), migration("0026", "pre_schema")],
      adapter,
    )
      .apply(hooks)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationVerificationError);
    expect((error as MigrationVerificationError).report.command).toBe("apply");
    expect(adapter.executed).toEqual(["0026"]);
    expect(adapter.recorded).toEqual(["0026"]);
    expect(events).toEqual(["baseline", "schema-sync"]);
  });

  it("replans a schema-synchronized pending migration before executing its SQL", async () => {
    const item = migration("0018", "post_schema");
    const adapter = fakeAdapter();
    const seenModes: string[] = [];
    let schemaSynchronized = false;
    adapter.verifyHistoricalState = async (migrationItem, context) => {
      seenModes.push(context.mode);
      if (adapter.states.get(migrationItem.id) === "complete") return verification("complete");
      if (!schemaSynchronized) return verification("absent");
      return verification(context.mode === "pre_execution" ? "absent" : "partial");
    };
    const hooks = lifecycleHooks();
    hooks.synchronizeSchema = async () => {
      schemaSynchronized = true;
    };

    await createMigrationEngine([item], adapter).apply(hooks);

    expect(seenModes).toContain("pre_execution");
    expect(adapter.executed).toEqual(["0018"]);
    expect(adapter.recorded).toEqual(["0018"]);
  });

  it("adopts independently complete post-schema state after schema synchronization", async () => {
    const adapter = fakeAdapter();
    const hooks = lifecycleHooks();
    hooks.synchronizeSchema = async () => {
      adapter.states.set("0018", "complete");
    };

    await createMigrationEngine([migration("0018", "post_schema")], adapter).apply(hooks);

    expect(adapter.executed).toEqual([]);
    expect(adapter.prepared).toEqual([]);
    expect(adapter.recorded).toEqual(["0018"]);
  });

  it.each(["partial"] as const)(
    "keeps a frozen pending post-schema decision when schema sync changes it to %s",
    async (state) => {
      const events: string[] = [];
      const adapter = fakeAdapter();
      const hooks = lifecycleHooks(events);
      hooks.synchronizeSchema = async () => {
        events.push("schema-sync");
        adapter.states.set("0018", state);
      };

      const error = await createMigrationEngine(
        [migration("0018", "post_schema"), migration("0026", "pre_schema")],
        adapter,
      )
        .apply(hooks)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationVerificationError);
      const report = (error as MigrationVerificationError).report;
      expect(report.command).toBe("apply");
      expect(report.outcomes.map(({ id, state }) => ({ id, state }))).toEqual([
        { id: "0018", state: "blocked" },
      ]);
      expect(adapter.executed).toEqual(["0026"]);
      expect(adapter.recorded).toEqual(["0026"]);
      expect(events).toEqual(["baseline", "schema-sync"]);
    },
  );

  it("blocks a pending pre-schema migration when base preparation exposes partial state", async () => {
    const events: string[] = [];
    const adapter = fakeAdapter();
    const hooks = lifecycleHooks(events);
    hooks.prepareBaseSchema = async () => {
      events.push("baseline");
      adapter.states.set("0026", "partial");
    };

    await expect(
      createMigrationEngine([migration("0026", "pre_schema")], adapter).apply(hooks),
    ).rejects.toThrow(/pre-schema migrations were not started/i);
    expect(adapter.executed).toEqual([]);
    expect(adapter.recorded).toEqual([]);
    expect(events).toEqual(["baseline"]);
  });

  it("resumes after a committed migration without replaying it", async () => {
    const migrations = [migration("0026", "pre_schema"), migration("0027", "pre_schema")];
    const rows: MigrationHistoryRow[] = [];
    const adapter = fakeAdapter(rows);
    const baseTransaction = adapter.transaction;
    let failSecond = true;
    adapter.transaction = (operation) =>
      baseTransaction(async (tx) => {
        const execute = tx.execute;
        tx.execute = async (item) => {
          if (item.id === "0027" && failSecond) throw new Error("injected failure");
          await execute(item);
        };
        return operation(tx);
      });

    await expect(
      createMigrationEngine(migrations, adapter).apply(lifecycleHooks()),
    ).rejects.toThrow(/injected failure/i);
    expect(adapter.executed).toEqual(["0026"]);
    expect(adapter.recorded).toEqual(["0026"]);

    failSecond = false;
    await createMigrationEngine(migrations, adapter).apply(lifecycleHooks());
    expect(adapter.executed).toEqual(["0026", "0027"]);
    expect(adapter.recorded).toEqual(["0026", "0027"]);
  });

  it("stops lifecycle work at the first failing phase", async () => {
    const migrations = [migration("0018", "post_schema"), migration("0026", "pre_schema")];

    for (const failure of ["prepare", "schema", "post", "finalize"] as const) {
      const events: string[] = [];
      const adapter = fakeAdapter();
      const baseTransaction = adapter.transaction;
      adapter.transaction = (operation) =>
        baseTransaction(async (tx) => {
          const execute = tx.execute;
          tx.execute = async (item) => {
            events.push(`execute:${item.id}`);
            if (failure === "post" && item.id === "0018") throw new Error("post failed");
            await execute(item);
          };
          return operation(tx);
        });
      const hooks: MigrationLifecycleHooks = {
        async prepareBaseSchema() {
          events.push("prepare");
          if (failure === "prepare") throw new Error("prepare failed");
        },
        async synchronizeSchema() {
          events.push("schema");
          if (failure === "schema") throw new Error("schema failed");
        },
        async finalizeSchema() {
          events.push("finalize");
          if (failure === "finalize") throw new Error("finalize failed");
        },
      };

      await expect(createMigrationEngine(migrations, adapter).apply(hooks)).rejects.toThrow();
      expect(events).toEqual(
        failure === "prepare"
          ? ["prepare"]
          : failure === "schema"
            ? ["prepare", "execute:0026", "schema"]
            : failure === "post"
              ? ["prepare", "execute:0026", "schema", "execute:0018"]
              : ["prepare", "execute:0026", "schema", "execute:0018", "finalize"],
      );
    }
  });

  it("reports final verification failures as apply failures", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter();
    const baseVerify = adapter.verifyHistoricalState;
    let afterFinalization = false;
    adapter.verifyHistoricalState = async (migration, context) =>
      afterFinalization && context.mode === "final"
        ? verification("partial")
        : baseVerify(migration, context);
    const hooks = lifecycleHooks();
    hooks.finalizeSchema = async () => {
      afterFinalization = true;
    };

    const error = await createMigrationEngine([item], adapter)
      .apply(hooks)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationError);
    expect((error as MigrationVerificationError).report.command).toBe("apply");
  });

  it("does not record history when post-execution verification fails", async () => {
    const item = migration("0018");
    const adapter = fakeAdapter();
    const transactionEvents: string[] = [];
    adapter.transaction = async (operation) =>
      operation({
        async prepareExecution() {
          transactionEvents.push("prepare");
        },
        async execute() {
          transactionEvents.push("execute");
        },
        async verifyHistoricalState(_item, context) {
          transactionEvents.push(`verify:${context.mode}`);
          return verification(context.mode === "pre_execution" ? "absent" : "partial");
        },
        async record() {
          transactionEvents.push("record");
          return history(item);
        },
      });

    await expect(createMigrationEngine([item], adapter).apply(lifecycleHooks())).rejects.toThrow(
      /transaction was rolled back/i,
    );
    expect(transactionEvents).toEqual([
      "verify:pre_execution",
      "prepare",
      "execute",
      "verify:post_apply",
    ]);
  });
});

describe("checksumMigration", () => {
  it("uses the known SHA-256 digest of the immutable SQL bytes", () => {
    expect(checksumMigration("SELECT 1;\n")).toBe(
      "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
    );
    expect(checksumMigration("SELECT 1;\r\n")).not.toBe(
      "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
    );
  });
});
