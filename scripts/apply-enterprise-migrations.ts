import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const MIGRATION_FILES = [
  "0028_enterprise_business_groups.sql",
  "0029_business_group_entity_exclusivity.sql",
  "0030_business_group_assignment_probe.sql",
  "0031_flat_business_group_entities.sql",
  "0032_reporting_projections.sql",
  "0033_projection_reconciliation.sql",
  "0034_business_group_admin_guards.sql",
  "0035_enterprise_stripe_billing.sql",
  "0036_enterprise_checkout.sql",
] as const;
const connectionString = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_ADMIN or DATABASE_URL is required");

const client = postgres(connectionString, { max: 1 });
try {
  await client`
    CREATE TABLE IF NOT EXISTS app_manual_migrations (
      migration_name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  for (const migrationName of MIGRATION_FILES) {
    const migration = await readFile(
      new URL(`../drizzle/${migrationName}`, import.meta.url),
      "utf8",
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    await client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('buwiz:enterprise-migrations', 0))`;
      const [applied] = await tx<Array<{ checksum: string }>>`
        SELECT checksum FROM app_manual_migrations WHERE migration_name = ${migrationName}
      `;
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(
            `${migrationName} was already applied with a different checksum; add a new migration instead`,
          );
        }
        console.log(`${migrationName}: already applied`);
        return;
      }
      // drizzle-kit push reflects the current flat schema before these manual
      // migrations run on a fresh database. The immutable 0028 migration still
      // creates its historical parent index, so provide that legacy column for
      // the duration of the chain; 0031 removes it again. Existing databases
      // that already recorded 0028 never enter this branch.
      if (migrationName === "0028_enterprise_business_groups.sql") {
        await tx`
          ALTER TABLE IF EXISTS organization_group_entities
          ADD COLUMN IF NOT EXISTS parent_entity_id uuid
        `;
      }
      if (migrationName === "0029_business_group_entity_exclusivity.sql") {
        // The current Drizzle schema already contains 0029's denormalized
        // account key. On a fresh push, temporarily remove those objects so
        // the immutable migration can recreate and validate them exactly as
        // it did for older databases.
        await tx`
          ALTER TABLE IF EXISTS organization_group_entities
          DROP CONSTRAINT IF EXISTS organization_group_entities_account_group_fk
        `;
        await tx`DROP INDEX IF EXISTS organization_group_entities_account_org_enabled_unique`;
        await tx`
          ALTER TABLE IF EXISTS organization_group_entities
          DROP COLUMN IF EXISTS enterprise_account_id
        `;
        await tx`
          ALTER TABLE IF EXISTS organization_groups
          DROP CONSTRAINT IF EXISTS organization_groups_account_id_unique
        `;
      }
      await tx.unsafe(migration);
      await tx`
        INSERT INTO app_manual_migrations (migration_name, checksum)
        VALUES (${migrationName}, ${checksum})
      `;
      console.log(`${migrationName}: applied`);
    });
  }
} finally {
  await client.end();
}
