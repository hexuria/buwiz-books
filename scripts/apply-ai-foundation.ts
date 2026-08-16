// Applies drizzle/0026_ai_foundation.sql (idempotent AI tables + indexes).
// Runs BEFORE `drizzle-kit push --force` in deploy so push never hits its
// interactive created-or-renamed prompt for these tables. Modeled on
// scripts/apply-integrity-migration.ts.
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const sql = postgres(connectionString, { max: 1 });
try {
  for (const file of ["0026_ai_foundation.sql", "0027_vendor_aliases.sql"]) {
    const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    await sql.unsafe(migration);
  }
  console.log("✅ AI foundation tables applied (idempotent)");
} finally {
  await sql.end();
}
