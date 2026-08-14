import { describe, expect, it, vi } from "vitest";
import { createMigrationDatabaseTarget, createRuntimeDatabaseTarget } from "@/lib/database-target";
import { createPostgresMigrationAdapter } from "@/lib/migrations/postgres-adapter";
import type { PreparedMigration } from "@/lib/migrations/engine";

const migrationTarget = (databaseName = "buwiz_e2e_adapter") =>
  createMigrationDatabaseTarget(`postgresql://migration-owner@127.0.0.1/${databaseName}`);

const migration = (id: "0028" | "0029") => ({ id }) as PreparedMigration;

interface Compatibility0028State {
  entities_table: boolean;
  parent_column_type: string | null;
  parent_column_not_null: boolean | null;
  parent_column_default: string | null;
  parent_column_identity: string | null;
  parent_column_generated: string | null;
  enterprise_column_type: string | null;
  enterprise_column_not_null: boolean | null;
  enterprise_column_default: string | null;
  enterprise_column_identity: string | null;
  enterprise_column_generated: string | null;
  parent_check_definition: string | null;
  group_id_unique_definition: string | null;
  parent_fk_definition: string | null;
  parent_index_definition: string | null;
}

const compatibility0028 = (
  overrides: Partial<Compatibility0028State> = {},
): Compatibility0028State => ({
  entities_table: true,
  parent_column_type: null,
  parent_column_not_null: null,
  parent_column_default: null,
  parent_column_identity: null,
  parent_column_generated: null,
  enterprise_column_type: "uuid",
  enterprise_column_not_null: true,
  enterprise_column_default: null,
  enterprise_column_identity: "",
  enterprise_column_generated: "",
  parent_check_definition: null,
  group_id_unique_definition: null,
  parent_fk_definition: null,
  parent_index_definition: null,
  ...overrides,
});

interface Compatibility0029State {
  entities_table: boolean;
  groups_table: boolean;
  enterprise_column_type: string | null;
  enterprise_column_not_null: boolean | null;
  enterprise_column_default: string | null;
  enterprise_column_identity: string | null;
  enterprise_column_generated: string | null;
  unknownEnterpriseConstraintCount: number;
  unknownEnterpriseIndexCount: number;
  account_group_constraint_type: string | null;
  account_group_columns: string[] | null;
  account_group_referenced_schema: string | null;
  account_group_referenced_table: string | null;
  account_group_referenced_columns: string[] | null;
  account_group_match_type: string | null;
  account_group_on_update: string | null;
  account_group_on_delete: string | null;
  account_group_deferrable: boolean | null;
  account_group_initially_deferred: boolean | null;
  account_group_validated: boolean | null;
  enabled_index_unique: boolean | null;
  enabled_index_primary: boolean | null;
  enabled_index_valid: boolean | null;
  enabled_index_ready: boolean | null;
  enabled_index_method: string | null;
  enabled_index_columns: string[] | null;
  enabled_index_include_columns: string[] | null;
  enabled_index_predicate: string | null;
  group_unique_constraint_type: string | null;
  group_unique_columns: string[] | null;
  group_unique_deferrable: boolean | null;
  group_unique_initially_deferred: boolean | null;
  group_unique_validated: boolean | null;
}

const compatibility0029 = (
  overrides: Partial<Compatibility0029State> = {},
): Compatibility0029State => ({
  entities_table: true,
  groups_table: true,
  enterprise_column_type: "uuid",
  enterprise_column_not_null: true,
  enterprise_column_default: null,
  enterprise_column_identity: "",
  enterprise_column_generated: "",
  unknownEnterpriseConstraintCount: 0,
  unknownEnterpriseIndexCount: 0,
  account_group_constraint_type: "foreign_key",
  account_group_columns: ["enterprise_account_id", "group_id"],
  account_group_referenced_schema: "public",
  account_group_referenced_table: "organization_groups",
  account_group_referenced_columns: ["enterprise_account_id", "id"],
  account_group_match_type: "simple",
  account_group_on_update: "no_action",
  account_group_on_delete: "cascade",
  account_group_deferrable: false,
  account_group_initially_deferred: false,
  account_group_validated: true,
  enabled_index_unique: true,
  enabled_index_primary: false,
  enabled_index_valid: true,
  enabled_index_ready: true,
  enabled_index_method: "btree",
  enabled_index_columns: ["enterprise_account_id", "organization_id"],
  enabled_index_include_columns: [],
  enabled_index_predicate: "status = 'enabled'::text",
  group_unique_constraint_type: "unique",
  group_unique_columns: ["enterprise_account_id", "id"],
  group_unique_deferrable: false,
  group_unique_initially_deferred: false,
  group_unique_validated: true,
  ...overrides,
});

interface HistoryColumnState {
  name: string;
  type: string;
  notNull: boolean;
  defaultExpression: string | null;
  identityKind: string;
  generatedKind: string;
}

interface HistoryCatalogState {
  relationKind: string;
  relationPersistence: string;
  rowSecurityEnabled: boolean;
  forceRowSecurity: boolean;
  rewriteRuleCount: number;
  userTriggerCount: number;
  columns: HistoryColumnState[];
  primaryKeyCount: number;
  primaryKeyColumns: string[];
  primaryKeyDeferrable: boolean;
}

const historyColumns = (checksumType = "character(64)"): HistoryColumnState[] => [
  {
    name: "applied_at",
    type: "timestamp with time zone",
    notNull: true,
    defaultExpression: "now()",
    identityKind: "",
    generatedKind: "",
  },
  {
    name: "checksum",
    type: checksumType,
    notNull: true,
    defaultExpression: null,
    identityKind: "",
    generatedKind: "",
  },
  {
    name: "migration_name",
    type: "text",
    notNull: true,
    defaultExpression: null,
    identityKind: "",
    generatedKind: "",
  },
];

const historyCatalog = (overrides: Partial<HistoryCatalogState> = {}): HistoryCatalogState => ({
  relationKind: "r",
  relationPersistence: "p",
  rowSecurityEnabled: false,
  forceRowSecurity: false,
  rewriteRuleCount: 0,
  userTriggerCount: 0,
  columns: historyColumns(),
  primaryKeyCount: 1,
  primaryKeyColumns: ["migration_name"],
  primaryKeyDeferrable: false,
  ...overrides,
});

function withHistoryColumn(
  state: HistoryCatalogState,
  columnName: string,
  overrides: Partial<HistoryColumnState>,
): HistoryCatalogState {
  return {
    ...state,
    columns: state.columns.map((column) =>
      column.name === columnName ? { ...column, ...overrides } : column,
    ),
  };
}

function historyAdapterHarness(
  options: {
    catalogState?: HistoryCatalogState | null;
    hasDuplicateNames?: boolean;
    publicHistory?: Array<{
      migrationName: string;
      checksum: string;
      appliedAt: Date;
    }>;
    shadowHistory?: Array<{
      migrationName: string;
      checksum: string;
      appliedAt: Date;
    }>;
  } = {},
) {
  const catalogState = options.catalogState === undefined ? historyCatalog() : options.catalogState;
  const publicHistory = options.publicHistory ?? [];
  const shadowHistory = options.shadowHistory ?? publicHistory;
  const migrationStatements: string[] = [];
  const transaction = Object.assign(
    vi.fn(async () => []),
    {
      unsafe: vi.fn(async (statement: string) => {
        migrationStatements.push(statement);
        return [];
      }),
    },
  );
  const release = vi.fn();
  const reserved = Object.assign(
    vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join("");
      if (statement.includes("migration history relation contract")) {
        return catalogState === null ? [] : [catalogState];
      }
      if (statement.includes("pg_advisory_unlock")) return [{ unlocked: true }];
      if (statement.includes("migration history duplicate check")) {
        return [{ hasDuplicateNames: options.hasDuplicateNames ?? false }];
      }
      if (statement.includes("to_regclass('public.app_manual_migrations') IS NOT NULL")) {
        return [{ exists: catalogState !== null }];
      }
      if (statement.includes("FROM public.app_manual_migrations")) return publicHistory;
      if (statement.includes("FROM app_manual_migrations")) return shadowHistory;
      return [];
    }),
    {
      release,
      begin: vi.fn(async (operation) => operation(transaction)),
    },
  );
  const client = Object.assign(vi.fn(), {
    reserve: vi.fn(async () => reserved),
    end: vi.fn(async () => undefined),
  });
  const adapter = createPostgresMigrationAdapter({
    target: migrationTarget("buwiz_e2e_history"),
    createClient: () => client as never,
  });
  return { adapter, migrationStatements };
}

const managedMigration = {
  ...migration("0028"),
  executionSql: "SELECT 'managed migration';",
} as PreparedMigration;

async function readHistoryThenExecute(
  harness: ReturnType<typeof historyAdapterHarness>,
): Promise<void> {
  await harness.adapter.withGlobalLock(async () => {
    await harness.adapter.readHistory();
    await harness.adapter.transaction((tx) => tx.execute(managedMigration));
  });
}

function adapterHarness(states: {
  migration0028?: Compatibility0028State | undefined;
  migration0029?: Compatibility0029State | undefined;
  historyRow?: {
    migrationName: string;
    checksum: string;
    appliedAt: Date;
  };
  commitFailsOnce?: boolean;
}) {
  const events: string[] = [];
  const transactionBoundaryEvents: string[] = [];
  let commitFailed = false;
  const transaction = Object.assign(
    vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join("");
      events.push(statement);
      if (statement.includes("INSERT INTO public.app_manual_migrations")) {
        return [
          states.historyRow ?? {
            migrationName: "0028_test.sql",
            checksum: "a".repeat(64),
            appliedAt: new Date(0),
          },
        ];
      }
      return [];
    }),
    {
      unsafe: vi.fn(async (statement: string) => {
        events.push(statement);
        if (statement.includes("compatibility state for migration 0028")) {
          return states.migration0028 === undefined ? [] : [states.migration0028];
        }
        if (statement.includes("compatibility state for migration 0029")) {
          return states.migration0029 === undefined ? [] : [states.migration0029];
        }
        if (statement.includes("schema_rows AS") && statement.includes("json_build_object")) {
          return [
            {
              snapshot: {
                schemas: [],
                relations: [],
                columns: [],
                indexes: [],
                constraints: [],
                policies: [],
                functions: [],
                triggers: [],
                extensions: [],
                enums: [],
                privileges: [],
                defaultPrivileges: [],
                roles: [],
              },
            },
          ];
        }
        return [];
      }),
    },
  );
  const { client, reserved } = fakeClient();
  reserved.begin.mockImplementation(async (operation) => {
    transactionBoundaryEvents.push("begin");
    try {
      const result = await operation(transaction);
      if (states.commitFailsOnce && !commitFailed) {
        commitFailed = true;
        throw new Error("commit failed");
      }
      transactionBoundaryEvents.push("commit");
      return result;
    } catch (error) {
      transactionBoundaryEvents.push("rollback");
      throw error;
    }
  });
  const adapter = createPostgresMigrationAdapter({
    target: migrationTarget(),
    createClient: () => client as never,
  });
  return { adapter, events, transaction, transactionBoundaryEvents };
}

async function prepare(
  harness: ReturnType<typeof adapterHarness>,
  id: "0028" | "0029",
): Promise<void> {
  await harness.adapter.withGlobalLock(() =>
    harness.adapter.transaction((tx) => tx.prepareExecution(migration(id))),
  );
}

function fakeClient(options: { unlockFails?: boolean; unlockReturnsFalse?: boolean } = {}) {
  const statements: string[] = [];
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  const reserved = Object.assign(
    vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join("");
      statements.push(statement);
      if (statement.includes("pg_advisory_unlock") && options.unlockFails) {
        throw new Error("unlock failed");
      }
      if (statement.includes("pg_advisory_unlock") && options.unlockReturnsFalse) {
        return [{ unlocked: false }];
      }
      if (statement.includes("pg_advisory_unlock")) return [{ unlocked: true }];
      return [];
    }),
    {
      release,
      begin: vi.fn(),
    },
  );
  const client = Object.assign(vi.fn(), {
    reserve: vi.fn(async () => reserved),
    end,
  });
  return { client, reserved, release, end, statements };
}

describe("PostgreSQL migration adapter", () => {
  it("rejects raw URLs before invoking a client factory", () => {
    const { client } = fakeClient();
    const createClient = vi.fn(() => client as never);

    expect(() =>
      createPostgresMigrationAdapter({
        databaseUrl: "postgresql://raw-url@127.0.0.1/buwiz_e2e_adapter",
        createClient,
      } as never),
    ).toThrow(/target/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects a wrong-purpose target before invoking a client factory", () => {
    const { client } = fakeClient();
    const createClient = vi.fn(() => client as never);

    expect(() =>
      createPostgresMigrationAdapter({
        target: createRuntimeDatabaseTarget("postgresql://runtime@127.0.0.1/buwiz_e2e_adapter"),
        createClient,
      }),
    ).toThrow(/purpose/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("pins a trusted search path before acquiring the global lock", async () => {
    const { client, statements } = fakeClient();
    const adapter = createPostgresMigrationAdapter({
      target: migrationTarget(),
      createClient: () => client as never,
    });

    await adapter.withGlobalLock(async () => undefined);

    expect(statements[0]).toMatch(/pg_catalog\.set_config\('search_path'/i);
    expect(statements[1]).toMatch(/pg_catalog\.pg_advisory_lock\(\s*pg_catalog\.hashtextextended/i);
  });

  it("rejects lifecycle operations that bypass the global lock", async () => {
    const { client } = fakeClient();
    const adapter = createPostgresMigrationAdapter({
      target: migrationTarget(),
      createClient: () => client as never,
    });

    await expect(adapter.readHistory()).rejects.toThrow(/requires the global lifecycle lock/i);
    await expect(
      adapter.verifyHistoricalState({ id: "0018" } as never, {} as never),
    ).rejects.toThrow(/requires the global lifecycle lock/i);
    await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
      /requires the global lifecycle lock/i,
    );
  });

  it("releases its reservation and clears local lock state when unlock fails", async () => {
    const { client, release, end } = fakeClient({ unlockFails: true });
    const adapter = createPostgresMigrationAdapter({
      target: migrationTarget(),
      createClient: () => client as never,
    });

    await expect(adapter.withGlobalLock(async () => "done")).rejects.toThrow(/unlock failed/i);
    expect(release).toHaveBeenCalledOnce();
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledOnce();
  });

  it("poisons the client when the unlock result is false", async () => {
    const { client, release, end } = fakeClient({ unlockReturnsFalse: true });
    const adapter = createPostgresMigrationAdapter({
      target: migrationTarget(),
      createClient: () => client as never,
    });

    await expect(adapter.withGlobalLock(async () => "done")).rejects.toThrow(/unlock cleanly/i);
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    await expect(adapter.withGlobalLock(async () => "retry")).rejects.toThrow(/closed|poisoned/i);
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledOnce();
  });

  it("releases its reservation when the lifecycle operation fails", async () => {
    const { client, release } = fakeClient();
    const adapter = createPostgresMigrationAdapter({
      target: migrationTarget(),
      createClient: () => client as never,
    });

    await expect(
      adapter.withGlobalLock(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow(/operation failed/i);
    expect(release).toHaveBeenCalledOnce();
  });

  it("treats a missing public migration-history table as empty", async () => {
    const { adapter } = historyAdapterHarness({ catalogState: null });

    await expect(adapter.withGlobalLock(() => adapter.readHistory())).resolves.toEqual([]);
  });

  it.each([
    ["dedup", "character(64)", "now()"],
    ["enterprise", "text", "CURRENT_TIMESTAMP"],
  ])("accepts the known %s migration-history shape", async (_name, checksumType, defaultValue) => {
    const row = {
      migrationName: "0028_enterprise_business_groups.sql",
      checksum: "a".repeat(64),
      appliedAt: new Date(0),
    };
    const catalogState = withHistoryColumn(
      historyCatalog({ columns: historyColumns(checksumType) }),
      "applied_at",
      { defaultExpression: defaultValue },
    );
    const { adapter } = historyAdapterHarness({ catalogState, publicHistory: [row] });

    await expect(adapter.withGlobalLock(() => adapter.readHistory())).resolves.toEqual([row]);
  });

  it("reads migration history only from the public schema", async () => {
    const publicRow = {
      migrationName: "0028_enterprise_business_groups.sql",
      checksum: "a".repeat(64),
      appliedAt: new Date(0),
    };
    const shadowRow = {
      migrationName: "0028_shadow.sql",
      checksum: "b".repeat(64),
      appliedAt: new Date(1),
    };
    const { adapter } = historyAdapterHarness({
      publicHistory: [publicRow],
      shadowHistory: [shadowRow],
    });

    await expect(adapter.withGlobalLock(() => adapter.readHistory())).resolves.toEqual([publicRow]);
  });

  it.each([
    ["non-table relation", historyCatalog({ relationKind: "v" })],
    ["unlogged relation", historyCatalog({ relationPersistence: "u" })],
    ["row security", historyCatalog({ rowSecurityEnabled: true })],
    ["forced row security", historyCatalog({ forceRowSecurity: true })],
    ["rewrite rule", historyCatalog({ rewriteRuleCount: 1 })],
    ["user trigger", historyCatalog({ userTriggerCount: 1 })],
    [
      "extra column",
      historyCatalog({
        columns: [
          ...historyColumns(),
          {
            name: "notes",
            type: "text",
            notNull: false,
            defaultExpression: null,
            identityKind: "",
            generatedKind: "",
          },
        ],
      }),
    ],
    ["missing column", historyCatalog({ columns: historyColumns().slice(1) })],
    [
      "renamed column",
      withHistoryColumn(historyCatalog(), "migration_name", { name: "migration_id" }),
    ],
    [
      "migration-name type",
      withHistoryColumn(historyCatalog(), "migration_name", { type: "character varying" }),
    ],
    ["checksum type", withHistoryColumn(historyCatalog(), "checksum", { type: "character(63)" })],
    [
      "applied-at type",
      withHistoryColumn(historyCatalog(), "applied_at", {
        type: "timestamp without time zone",
      }),
    ],
    [
      "migration-name nullability",
      withHistoryColumn(historyCatalog(), "migration_name", { notNull: false }),
    ],
    ["checksum nullability", withHistoryColumn(historyCatalog(), "checksum", { notNull: false })],
    [
      "applied-at nullability",
      withHistoryColumn(historyCatalog(), "applied_at", { notNull: false }),
    ],
    [
      "missing applied-at default",
      withHistoryColumn(historyCatalog(), "applied_at", { defaultExpression: null }),
    ],
    [
      "changed applied-at default",
      withHistoryColumn(historyCatalog(), "applied_at", {
        defaultExpression: "clock_timestamp()",
      }),
    ],
    [
      "unexpected checksum default",
      withHistoryColumn(historyCatalog(), "checksum", { defaultExpression: "''::text" }),
    ],
    ["missing primary key", historyCatalog({ primaryKeyCount: 0, primaryKeyColumns: [] })],
    ["wrong primary key", historyCatalog({ primaryKeyCount: 1, primaryKeyColumns: ["checksum"] })],
    [
      "composite primary key",
      historyCatalog({
        primaryKeyCount: 1,
        primaryKeyColumns: ["migration_name", "checksum"],
      }),
    ],
    [
      "multiple primary keys",
      historyCatalog({ primaryKeyCount: 2, primaryKeyColumns: ["migration_name"] }),
    ],
    ["deferrable primary key", historyCatalog({ primaryKeyDeferrable: true })],
    [
      "generated history column",
      withHistoryColumn(historyCatalog(), "checksum", { generatedKind: "s" }),
    ],
  ])("rejects an incompatible migration-history %s before managed SQL", async (_name, state) => {
    const harness = historyAdapterHarness({ catalogState: state });

    await expect(readHistoryThenExecute(harness)).rejects.toThrow(
      /migration history.*(?:ambiguous|incompatible)/i,
    );
    expect(harness.migrationStatements).toEqual([]);
  });

  it("rejects duplicate migration-history names before managed SQL", async () => {
    const harness = historyAdapterHarness({ hasDuplicateNames: true });

    await expect(readHistoryThenExecute(harness)).rejects.toThrow(/duplicate migration history/i);
    expect(harness.migrationStatements).toEqual([]);
  });

  it.each([
    ["parent default", { parent_column_default: "gen_random_uuid()" }],
    ["parent identity", { parent_column_identity: "d" }],
    ["parent generated", { parent_column_generated: "s" }],
    ["enterprise default", { enterprise_column_default: "'x'::uuid" }],
    ["enterprise identity", { enterprise_column_identity: "d" }],
    ["enterprise generated", { enterprise_column_generated: "s" }],
  ])("rejects 0028 %s column metadata before DDL", async (_name, overrides) => {
    const harness = adapterHarness({
      migration0028: compatibility0028(overrides),
    });

    await expect(prepare(harness, "0028")).rejects.toThrow(/ambiguous|partial/i);
    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
  });

  it("prepares 0028 only for the exact fresh schema shape", async () => {
    const harness = adapterHarness({ migration0028: compatibility0028() });

    await prepare(harness, "0028");

    expect(harness.transaction.unsafe).toHaveBeenCalledWith(
      expect.stringMatching(/ADD COLUMN parent_entity_id uuid/i),
    );
  });

  it.each([
    ["relation absent", compatibility0028({ entities_table: false })],
    [
      "exact legacy nullable parent",
      compatibility0028({
        parent_column_type: "uuid",
        parent_column_not_null: false,
        enterprise_column_type: null,
        enterprise_column_not_null: null,
      }),
    ],
    [
      "exact schema-sync nullable parent",
      compatibility0028({
        parent_column_type: "uuid",
        parent_column_not_null: false,
      }),
    ],
  ])("leaves 0028 %s compatibility state unchanged", async (_name, state) => {
    const harness = adapterHarness({ migration0028: state });

    await prepare(harness, "0028");

    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
  });

  it("rejects a missing 0028 catalog result before DDL", async () => {
    const harness = adapterHarness({});

    await expect(prepare(harness, "0028")).rejects.toThrow(/returned no state/i);
    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
  });

  it.each([
    ["parent type", compatibility0028({ parent_column_type: "text" })],
    [
      "parent nullability",
      compatibility0028({ parent_column_type: "uuid", parent_column_not_null: true }),
    ],
    ["enterprise type", compatibility0028({ enterprise_column_type: "text" })],
    ["enterprise nullability", compatibility0028({ enterprise_column_not_null: false })],
  ])("blocks incompatible 0028 %s before DDL", async (_name, state) => {
    const harness = adapterHarness({ migration0028: state });

    await expect(prepare(harness, "0028")).rejects.toThrow(/ambiguous|partial/i);
    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
    expect(harness.transactionBoundaryEvents).toEqual(["begin", "rollback"]);
  });

  it("prepares exact current 0029 state in controlled dependency order", async () => {
    const harness = adapterHarness({ migration0029: compatibility0029() });

    await prepare(harness, "0029");

    expect(harness.events.slice(1)).toEqual([
      "ALTER TABLE public.organization_group_entities DROP CONSTRAINT organization_group_entities_account_group_fk;",
      "DROP INDEX public.organization_group_entities_account_org_enabled_unique;",
      "ALTER TABLE public.organization_group_entities DROP COLUMN enterprise_account_id;",
      "ALTER TABLE public.organization_groups DROP CONSTRAINT organization_groups_account_id_unique;",
    ]);
  });

  it("leaves exact legacy 0029 state unchanged", async () => {
    const harness = adapterHarness({
      migration0029: compatibility0029({
        enterprise_column_type: null,
        enterprise_column_not_null: null,
        account_group_constraint_type: null,
        account_group_columns: null,
        account_group_referenced_schema: null,
        account_group_referenced_table: null,
        account_group_referenced_columns: null,
        account_group_match_type: null,
        account_group_on_update: null,
        account_group_on_delete: null,
        account_group_deferrable: null,
        account_group_initially_deferred: null,
        account_group_validated: null,
        enabled_index_unique: null,
        enabled_index_primary: null,
        enabled_index_valid: null,
        enabled_index_ready: null,
        enabled_index_method: null,
        enabled_index_columns: null,
        enabled_index_include_columns: null,
        enabled_index_predicate: null,
        group_unique_constraint_type: null,
        group_unique_columns: null,
        group_unique_deferrable: null,
        group_unique_initially_deferred: null,
        group_unique_validated: null,
      }),
    });

    await prepare(harness, "0029");

    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
  });

  it("rejects missing 0029 tables before DDL", async () => {
    const harness = adapterHarness({
      migration0029: compatibility0029({ groups_table: false }),
    });

    await expect(prepare(harness, "0029")).rejects.toThrow(/missing a required table/i);
    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing companion constraint", compatibility0029({ account_group_constraint_type: null })],
    ["wrong foreign-key columns", compatibility0029({ account_group_columns: ["group_id"] })],
    ["wrong foreign-key match", compatibility0029({ account_group_match_type: "full" })],
    ["wrong foreign-key delete action", compatibility0029({ account_group_on_delete: "restrict" })],
    ["deferrable foreign key", compatibility0029({ account_group_deferrable: true })],
    ["invalid partial index", compatibility0029({ enabled_index_valid: false })],
    ["included index column", compatibility0029({ enabled_index_include_columns: ["status"] })],
    [
      "wrong partial predicate",
      compatibility0029({ enabled_index_predicate: "status = 'disabled'::text" }),
    ],
    ["wrong unique columns", compatibility0029({ group_unique_columns: ["id"] })],
    ["invalid unique constraint", compatibility0029({ group_unique_validated: false })],
    ["enterprise default", compatibility0029({ enterprise_column_default: "'x'::uuid" })],
    ["enterprise identity", compatibility0029({ enterprise_column_identity: "d" })],
    ["enterprise generated", compatibility0029({ enterprise_column_generated: "s" })],
    ["unknown enterprise constraint", compatibility0029({ unknownEnterpriseConstraintCount: 1 })],
    ["unknown enterprise index", compatibility0029({ unknownEnterpriseIndexCount: 1 })],
  ])("blocks mixed or malformed 0029 %s before DDL", async (_name, state) => {
    const harness = adapterHarness({ migration0029: state });

    await expect(prepare(harness, "0029")).rejects.toThrow(/ambiguous|partial/i);
    expect(harness.transaction.unsafe).toHaveBeenCalledOnce();
    expect(harness.transactionBoundaryEvents).toEqual(["begin", "rollback"]);
  });

  it("rejects a history row that does not match the requested migration", async () => {
    const harness = adapterHarness({
      migration0028: compatibility0028(),
      historyRow: {
        migrationName: "0028_other.sql",
        checksum: "b".repeat(64),
        appliedAt: new Date(0),
      },
    });
    const item = {
      ...migration("0028"),
      file: "0028_test.sql",
      checksum: "a".repeat(64),
    } as PreparedMigration;

    await expect(
      harness.adapter.withGlobalLock(() => harness.adapter.transaction((tx) => tx.record(item))),
    ).rejects.toThrow(/did not match/i);
    expect(harness.transactionBoundaryEvents).toEqual(["begin", "rollback"]);
  });

  it("does not publish history-table existence until the transaction commits", async () => {
    const harness = adapterHarness({
      migration0028: compatibility0028(),
      commitFailsOnce: true,
    });
    const item = {
      ...migration("0028"),
      file: "0028_test.sql",
      checksum: "a".repeat(64),
    } as PreparedMigration;

    await harness.adapter.withGlobalLock(async () => {
      await expect(harness.adapter.transaction((tx) => tx.record(item))).rejects.toThrow(
        /commit failed/i,
      );
      await expect(harness.adapter.transaction((tx) => tx.record(item))).resolves.toBeDefined();
    });

    expect(
      harness.events.filter((statement) =>
        statement.includes("CREATE TABLE public.app_manual_migrations"),
      ),
    ).toHaveLength(2);
  });

  it("keeps prepare, execute, verify, and history recording inside one adapter transaction", async () => {
    const harness = adapterHarness({ migration0028: compatibility0028() });
    const item = {
      ...migration("0028"),
      executionSql: "SELECT 'immutable migration';",
      file: "0028_test.sql",
      checksum: "a".repeat(64),
    } as PreparedMigration;
    await harness.adapter.withGlobalLock(() =>
      harness.adapter.transaction(async (tx) => {
        await tx.prepareExecution(item);
        await tx.execute(item);
        await tx.verifyHistoricalState(item, {
          mode: "post_apply",
          target: {
            through: "0028",
            includes: (id) => id === "0028",
          },
        });
        await tx.record(item);
      }),
    );

    expect(
      harness.events.map((statement) => {
        if (statement.includes("compatibility state for migration 0028")) return "prepare:inspect";
        if (statement.includes("ADD COLUMN parent_entity_id")) return "prepare:ddl";
        if (statement === "SELECT 'immutable migration';") return "execute";
        if (statement.includes("schema_rows AS")) return "verify";
        if (statement.includes("CREATE TABLE public.app_manual_migrations")) {
          return "history:ensure";
        }
        if (statement.includes("INSERT INTO public.app_manual_migrations")) {
          return "history:record";
        }
        return "unexpected";
      }),
    ).toEqual([
      "prepare:inspect",
      "prepare:ddl",
      "execute",
      "verify",
      "history:ensure",
      "history:record",
    ]);
    expect(harness.transactionBoundaryEvents).toEqual(["begin", "commit"]);
  });
});
