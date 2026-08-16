import postgres from "postgres";
import { SNAPSHOT_DATA } from "./fixtures/snapshot-data";
import { resolve } from "path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env.test") });

async function seedSnapshot() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.includes("buwiz-books-tests")) {
    throw new Error("Invalid or missing DATABASE_URL. Must point to buwiz-books-tests.");
  }

  const sql = postgres(dbUrl);
  console.log("🌱 Restoring Test Database from E2E Snapshot...");

  // Assume the test DB already has exactly one org based on seed-superuser!
  const orgs = await sql`SELECT id FROM auth_organizations LIMIT 1`;
  const users = await sql`SELECT id FROM auth_users LIMIT 1`;

  if (!orgs.length || !users.length) {
    console.error("Missing organization or user. Run db:seed first.");
    process.exit(1);
  }

  const targetOrgId = orgs[0].id;
  const targetUserId = users[0].id;

  console.log(`Mapping snapshot payload to Org ID: ${targetOrgId}`);

  // Retrieve instantiated data with dynamically replaced keys
  const data = SNAPSHOT_DATA(targetOrgId, targetUserId);

  try {
    // Clear out base tables to prevent unique constraint failures, relying on ON DELETE CASCADE
    await sql`DELETE FROM accounts WHERE organization_id = ${targetOrgId}`;
    await sql`DELETE FROM parties WHERE organization_id = ${targetOrgId}`;
    await sql`DELETE FROM financial_accounts WHERE organization_id = ${targetOrgId}`;

    const order = [
      "accounts",
      "parties",
      "dimensions",
      "financial_accounts",
      "documents",
      "journal_headers",
      "journal_lines",
      "document_attachments",
      "reconciliations",
      "statement_lines",
    ];

    for (const table of order) {
      const rows = (data as any)[table];
      if (rows && rows.length > 0) {
        // Use postgres helper to easily insert an array of raw objects!
        await sql`INSERT INTO ${sql(table)} ${sql(rows)}`;
        console.log(`✅ ${table}: ${rows.length}`);
      }
    }

    console.log("🎯 E2E Snapshot completely restored!");
  } catch (e) {
    console.error("Seeding failed", e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

seedSnapshot();
