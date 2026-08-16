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
export async function createTestDb() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is required for integration tests");
  }
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql, { schema });

  return { db, sql };
}
