/**
 * Apply 0028-0036 as plain SQL on a disposable, push-built test database.
 *
 * The managed lifecycle cannot install these on a pushed schema: 0028's CREATE
 * TABLE IF NOT EXISTS is a no-op, so its inline constraints never appear, and
 * the 0034 verifier then treats leftover 0028 functions as a 0034 footprint.
 * CI already applies this sequence in .github/workflows/deploy.yml. Local
 * db:test:fresh / db:fresh must do the same or Business Group and Stripe
 * integration tests assert against missing triggers and missing tables.
 *
 * Never run this against a real database. The compatibility DDL is narrower
 * than the adapter's prepare0028/prepare0029 and is safe only because the
 * target is rebuilt from scratch.
 */
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const files = [
  "0029_business_group_entity_exclusivity.sql",
  "0030_business_group_assignment_probe.sql",
  "0031_flat_business_group_entities.sql",
  "0032_reporting_projections.sql",
  "0033_projection_reconciliation.sql",
  "0034_business_group_admin_guards.sql",
  "0035_enterprise_stripe_billing.sql",
  "0036_enterprise_checkout.sql",
] as const;

const sql = postgres(connectionString, { max: 1 });
try {
  await sql.unsafe(`
    ALTER TABLE IF EXISTS organization_group_entities
      ADD COLUMN IF NOT EXISTS parent_entity_id uuid;
  `);
  await sql.begin(async (tx) => {
    const enterprise = await readFile(
      new URL("../drizzle/0028_enterprise_business_groups.sql", import.meta.url),
      "utf8",
    );
    await tx.unsafe(enterprise);
  });
  await sql.unsafe(`
    ALTER TABLE IF EXISTS organization_group_entities
      DROP CONSTRAINT IF EXISTS organization_group_entities_account_group_fk;
    DROP INDEX IF EXISTS organization_group_entities_account_org_enabled_unique;
    ALTER TABLE IF EXISTS organization_group_entities
      DROP COLUMN IF EXISTS enterprise_account_id;
    ALTER TABLE IF EXISTS organization_groups
      DROP CONSTRAINT IF EXISTS organization_groups_account_id_unique;
  `);
  for (const file of files) {
    const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
    });
  }
  console.log(`✅ Enterprise test SQL applied, idempotent (${files.length + 1} migrations)`);
} finally {
  await sql.end();
}
