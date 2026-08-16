import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const MIGRATION_FILES = [
  "0019_inbox_review_foundation.sql",
  "0020_transaction_deduplication.sql",
  "0021_safe_journal_merge.sql",
  "0022_legacy_match_conversion.sql",
  "0023_operation_idempotency.sql",
  "0024_tenant_lineage_integrity.sql",
] as const;

interface CliOptions {
  statusOnly: boolean;
}

function usage(): string {
  return `Apply the Inbox and transaction-deduplication migrations

Usage:
  bun run db:dedup:migrate
  bun run db:dedup:migrate --status

This command applies 0019 through 0024 in order and records their SHA-256
checksums in app_manual_migrations. Re-running it is safe: recorded migrations
are skipped and a changed applied migration is rejected.
`;
}

function parseOptions(argv: string[]): CliOptions {
  let statusOnly = false;
  for (const argument of argv) {
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--status") {
      statusOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { statusOnly };
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    if (options.statusOnly) {
      const [migrationTable] = await client<Array<{ exists: boolean }>>`
        SELECT to_regclass('public.app_manual_migrations') IS NOT NULL AS exists
      `;
      if (!migrationTable.exists) {
        for (const migrationName of MIGRATION_FILES) {
          console.log(`${migrationName}: pending`);
        }
        console.log("Status check complete; no schema or data was changed.");
        return;
      }
    } else {
      await client`
        CREATE TABLE IF NOT EXISTS app_manual_migrations (
          migration_name text PRIMARY KEY,
          checksum char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
    }

    for (const migrationName of MIGRATION_FILES) {
      const contents = await readFile(
        new URL(`../drizzle/${migrationName}`, import.meta.url),
        "utf8",
      );
      const expectedChecksum = checksum(contents);

      const outcome = await client.begin(async (tx) => {
        // postgres.js's TransactionSql type currently loses the Sql call
        // signature through Omit even though the runtime value remains a tag.
        const query = tx as unknown as typeof client;
        await query`
          SELECT pg_advisory_xact_lock(
            hashtextextended('digits:dedup-schema-migrations', 0::bigint)
          )
        `;
        const [applied] = await query<Array<{ checksum: string; appliedAt: Date }>>`
          SELECT checksum, applied_at AS "appliedAt"
          FROM app_manual_migrations
          WHERE migration_name = ${migrationName}
          FOR UPDATE
        `;
        if (applied) {
          if (applied.checksum.trim() !== expectedChecksum) {
            throw new Error(
              `${migrationName} was already applied with a different checksum. ` +
                "Do not edit an applied migration; add a new migration instead.",
            );
          }
          return { state: "applied" as const, appliedAt: applied.appliedAt };
        }
        if (options.statusOnly) return { state: "pending" as const, appliedAt: null };

        await tx.unsafe(contents);
        const [recorded] = await query<Array<{ appliedAt: Date }>>`
          INSERT INTO app_manual_migrations (migration_name, checksum)
          VALUES (${migrationName}, ${expectedChecksum})
          RETURNING applied_at AS "appliedAt"
        `;
        return { state: "installed" as const, appliedAt: recorded.appliedAt };
      });

      console.log(
        `${migrationName}: ${outcome.state}` +
          (outcome.appliedAt ? ` (${outcome.appliedAt.toISOString()})` : ""),
      );
    }

    if (options.statusOnly) {
      console.log("Status check complete; no schema or data was changed.");
    } else {
      console.log("Deduplication migrations are current.");
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
