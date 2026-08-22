/**
 * Fallback loader for `.env.test`.
 *
 * CI passes TEST_DATABASE_URL as a real job env var and `.env.test` is
 * gitignored, so it does not exist there. Locally the opposite is true: the
 * file holds the values and nothing exports them, because neither
 * `test:integration` nor `test:component` passes `--env-file` (only the
 * `db:*` scripts do).
 *
 * So this fills the gap in one direction only. A variable that is ALREADY set
 * always wins and is never overwritten — CI keeps its own values, and an
 * explicit `TEST_DATABASE_URL=... bun run test:integration` still beats the
 * file. A missing file is not an error; the caller's own check reports the
 * missing variable with its real message.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const KEYS = [
  "TEST_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "MIGRATION_SCHEMA_SYNC_CONFIRM",
] as const;

export function loadTestEnv(file = resolve(process.cwd(), ".env.test")): void {
  if (!existsSync(file)) return;

  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!(KEYS as readonly string[]).includes(key)) continue;
    // Never clobber a value the environment already provided.
    if (process.env[key]) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
}
