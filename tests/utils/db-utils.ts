/**
 * Database Test Utilities
 * Helpers for managing test database state and connections
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema";

/**
 * Creates a test-isolated database connection
 * The integration project deliberately accepts only the isolated test database URL.
 */
export async function createTestDb(options?: {
  /**
   * Called once per statement actually sent to Postgres.
   *
   * Exists so a test can assert ROUND TRIPS, not just results — the only way to
   * prove a batched query stayed batched. Optional, so existing callers are
   * unaffected and pay nothing.
   */
  onQuery?: (query: string) => void;
}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is required for integration tests");
  }
  const onQuery = options?.onQuery;
  const sql = postgres(connectionString, {
    max: 1,
    ...(onQuery ? { debug: (_conn: number, query: string) => onQuery(query) } : {}),
  });
  const db = drizzle(sql, { schema });

  return { db, sql };
}
