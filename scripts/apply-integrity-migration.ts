import { readFile } from "node:fs/promises";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const sql = postgres(connectionString, { max: 1 });
try {
  const migration = await readFile(
    new URL("../drizzle/0018_integrity_and_server_secrets.sql", import.meta.url),
    "utf8",
  );
  await sql.unsafe(migration);
} finally {
  await sql.end();
}
