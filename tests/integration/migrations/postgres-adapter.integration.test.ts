import postgres, { type Sql } from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDestructiveE2EDatabaseTarget,
  createMigrationDatabaseTarget,
} from "@/lib/database-target";
import { getDisposableResetPostgresOptions } from "@/lib/database-target-internal";
import { createPostgresMigrationAdapter } from "@/lib/migrations/postgres-adapter";
import { createMigrationEngine } from "@/lib/migrations/engine";
import { loadPreparedMigrations } from "@/lib/migrations/loader";
import { migrationManifest } from "@/lib/migrations/manifest";

const rawDatabaseUrl = process.env.TEST_DATABASE_URL;
const resetConfirmation = process.env.E2E_RESET_CONFIRM;
const describeDisposable = rawDatabaseUrl && resetConfirmation ? describe : describe.skip;

describeDisposable("PostgreSQL migration adapter disposable integration", () => {
  if (!rawDatabaseUrl || !resetConfirmation) return;

  const resetTarget = createDestructiveE2EDatabaseTarget(rawDatabaseUrl!, resetConfirmation!);
  const migrationTarget = createMigrationDatabaseTarget(rawDatabaseUrl!);

  async function createResetClient(): Promise<Sql> {
    return postgres({
      ...getDisposableResetPostgresOptions(resetTarget),
      max: 1,
      prepare: false,
    });
  }

  async function resetObjects(sql: Sql): Promise<void> {
    await sql.unsafe(`
      DROP TABLE IF EXISTS public.app_manual_migrations CASCADE;
      DROP TABLE IF EXISTS public.adapter_integration_probe CASCADE;
    `);
  }

  async function withAdapter<T>(
    operation: (adapter: ReturnType<typeof createPostgresMigrationAdapter>, sql: Sql) => Promise<T>,
  ): Promise<T> {
    const sql = await createResetClient();
    const adapter = createPostgresMigrationAdapter({
      target: migrationTarget,
      createClient: () => sql,
    });
    try {
      return await operation(adapter, sql);
    } finally {
      await adapter.close();
    }
  }

  beforeEach(async () => {
    const sql = await createResetClient();
    try {
      await resetObjects(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    const sql = await createResetClient();
    try {
      await resetObjects(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("rolls back a failed migration transaction", async () => {
    await withAdapter(async (adapter, sql) => {
      const migration = {
        id: "0018",
        file: "0018_integrity_and_server_secrets.sql",
        executionSql: "CREATE TABLE public.adapter_integration_probe (id integer);",
      } as never;

      await expect(
        adapter.withGlobalLock(() =>
          adapter.transaction(async (tx) => {
            await tx.execute(migration);
            throw new Error("forced migration failure");
          }),
        ),
      ).rejects.toThrow(/forced migration failure/i);

      const [state] = await sql<{ relationKind: string | null }[]>`
        SELECT to_regclass('public.adapter_integration_probe')::text AS "relationKind"
      `;
      expect(state?.relationKind).toBeNull();
    });
  });

  it("serializes competing global-lock holders on separate connections", async () => {
    const firstSql = await createResetClient();
    const secondSql = await createResetClient();
    const first = createPostgresMigrationAdapter({
      target: migrationTarget,
      createClient: () => firstSql,
    });
    const second = createPostgresMigrationAdapter({
      target: migrationTarget,
      createClient: () => secondSql,
    });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    try {
      const firstOperation = first.withGlobalLock(async () => {
        firstEntered();
        await firstReleased;
      });
      await firstStarted;

      let secondEntered = false;
      const secondOperation = second.withGlobalLock(async () => {
        secondEntered = true;
      });
      const completedBeforeRelease = await Promise.race([
        secondOperation.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);

      expect(completedBeforeRelease).toBe(false);
      expect(secondEntered).toBe(false);
      releaseFirst();
      await Promise.all([firstOperation, secondOperation]);
      expect(secondEntered).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("rejects a non-permanent history relation before reading history", async () => {
    await withAdapter(async (adapter, sql) => {
      await sql.unsafe(`
        CREATE UNLOGGED TABLE public.app_manual_migrations (
          migration_name text PRIMARY KEY,
          checksum char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await expect(adapter.withGlobalLock(() => adapter.readHistory())).rejects.toThrow(
        /permanently stored/i,
      );
    });
  });

  it("reports checksum drift without attempting migration verification or execution", async () => {
    await withAdapter(async (adapter, sql) => {
      await sql.unsafe(`
        CREATE TABLE public.app_manual_migrations (
          migration_name text PRIMARY KEY,
          checksum char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await sql`
        INSERT INTO public.app_manual_migrations (migration_name, checksum)
        VALUES ('0018_integrity_and_server_secrets.sql', ${"b".repeat(64)})
      `;
      const [prepared] = await loadPreparedMigrations({ manifest: [migrationManifest[0]] });
      const engine = createMigrationEngine([prepared], adapter);

      const report = await engine.status();
      expect(report.ok).toBe(false);
      expect(report.outcomes[0]?.state).toBe("drift");
    });
  });
});
