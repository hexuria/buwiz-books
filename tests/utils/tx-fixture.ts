/**
 * Transaction-isolated fixtures for integration tests.
 *
 * WHY `db-utils.ts` IS NOT ENOUGH. `createTestDb` returns a raw pooled
 * connection with no isolation, so every test writes into the shared test
 * database and leaves its rows behind. Tests then have to invent unique
 * organization ids and clean up by hand, and any test that forgets pollutes
 * the ones after it.
 *
 * WHY NOT JUST WRAP EACH TEST IN A ROLLED-BACK TRANSACTION. The usual trick —
 * open a transaction, run the test, roll back — is unavailable for the
 * constraint this suite most needs to exercise. `journal_lines_balance_check`
 * is `DEFERRABLE INITIALLY DEFERRED`: it fires at COMMIT, and only at COMMIT.
 * A test that never commits never triggers it, so a rollback-per-test harness
 * silently passes every balance violation it is supposed to catch. The same
 * applies to any deferred constraint added later.
 *
 * So there are two fixtures here, and choosing between them is a real
 * decision rather than a preference:
 *
 *   - `withRollback` — fast, fully isolated, leaves nothing behind. Correct for
 *     everything EXCEPT deferred constraints. It cannot observe them.
 *   - `withCommittedScope` — actually commits, so deferred constraints fire,
 *     then deletes what it created. Correct when the commit IS the thing under
 *     test.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

function connectionString(): string {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for integration tests");
  }
  return url;
}

/**
 * Run `fn` inside a transaction that is ALWAYS rolled back.
 *
 * Nothing survives, so tests need no cleanup and cannot leak into each other.
 *
 * DEFERRED CONSTRAINTS DO NOT FIRE HERE. If what you are testing is a
 * `DEFERRABLE INITIALLY DEFERRED` constraint — the journal balance check, for
 * instance — this fixture will pass no matter what you write. Use
 * `withCommittedScope` instead.
 */
export async function withRollback<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(connectionString(), { max: 1, onnotice: () => {} });

  // The callback receives the postgres.js transaction handle, NOT a drizzle
  // instance: drizzle cannot wrap a transaction handle (it reaches for
  // connection-level `parsers` that only the root client has). Tests needing
  // the query builder should use `withRollbackDb`, which goes through
  // drizzle's own transaction support.
  class Rollback extends Error {
    constructor(readonly value: T) {
      super("rollback");
    }
  }

  try {
    await sql.begin(async (tx) => {
      // A sentinel forces the rollback: postgres.js COMMITS when the callback
      // resolves, so returning normally would persist every write.
      const value = await fn(tx as unknown as postgres.Sql);
      throw new Rollback(value);
    });
    throw new Error("unreachable: the rollback sentinel was not thrown");
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  } finally {
    await sql.end();
  }
}

/**
 * The same always-rolled-back isolation, but through drizzle's transaction so
 * the callback gets a working query builder.
 *
 * Carries the identical deferred-constraint limitation as `withRollback`.
 */
export async function withRollbackDb<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
  const sql = postgres(connectionString(), { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  class Rollback extends Error {
    constructor(readonly value: T) {
      super("rollback");
    }
  }

  try {
    await db.transaction(async (tx) => {
      const value = await fn(tx as unknown as TestDb);
      throw new Rollback(value);
    });
    throw new Error("unreachable: the rollback sentinel was not thrown");
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  } finally {
    await sql.end();
  }
}

/**
 * A committed scope for tests that need deferred constraints to actually fire.
 *
 * Every organization id passed to `track` is deleted afterwards, in foreign-key
 * order. Cleanup runs even when the test throws — a failing balance assertion
 * still leaves the database clean for the next test.
 */
export async function withCommittedScope<T>(
  fn: (ctx: {
    db: TestDb;
    sql: postgres.Sql;
    /** Register an organization id for teardown. */
    track: (organizationId: string) => void;
  }) => Promise<T>,
): Promise<T> {
  const sql = postgres(connectionString(), { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const organizations = new Set<string>();

  try {
    return await fn({ db, sql, track: (id) => organizations.add(id) });
  } finally {
    for (const orgId of organizations) {
      await cleanupOrganization(sql, orgId);
    }
    await sql.end();
  }
}

/**
 * Remove everything an integration test created for one organization.
 *
 * Order matters twice over. Headers reference each other through the
 * amendment-lineage and duplicate pointers, which are ON DELETE RESTRICT, so
 * those are cleared first and the headers then go in one statement rather than
 * in dependency order. And trigger 0039 refuses to delete the lines of a
 * POSTED journal at all, so the headers must leave that state before the lines
 * can be removed — which is why the UPDATE comes before the DELETE.
 */
export async function cleanupOrganization(sql: postgres.Sql, organizationId: string) {
  // Posted headers first: trigger 0039 refuses to delete the lines of a posted
  // journal, so teardown has to take them out of that state before it can
  // clean up. Voiding is the one status change the trigger permits.
  await sql`
    UPDATE journal_headers
       SET status = 'voided',
           reverses_header_id = NULL,
           replaces_header_id = NULL,
           duplicate_of_header_id = NULL
     WHERE organization_id = ${organizationId}`;
  await sql`
    DELETE FROM journal_lines
     WHERE journal_header_id IN (
       SELECT id FROM journal_headers WHERE organization_id = ${organizationId}
     )`;
  await sql`DELETE FROM payroll_lines WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM payroll_runs WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM journal_headers WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM payroll_employee_year_state WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM payroll_previous_employer_2316 WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM party_tax_profiles WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM tax_certificates WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM bill_line_items WHERE bill_id IN (
              SELECT id FROM bills WHERE organization_id = ${organizationId})`;
  await sql`DELETE FROM bills WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM category_mappings WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM accounts WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM parties WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM organization_accounting_settings WHERE organization_id = ${organizationId}`;
  await sql`DELETE FROM auth_organizations WHERE id = ${organizationId}`;
}
