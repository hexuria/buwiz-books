/**
 * Seed and inspect the Philippine tax reference catalog.
 *
 * The four catalog tables are GLOBAL — no `organization_id`, excluded from every
 * RLS policy list — so there is no org context to establish and no ORG_ID to
 * pass. Statutory rates are not tenant data.
 *
 * Idempotent and additive: ON CONFLICT DO NOTHING. Existing rows are never
 * modified. A rate is behaviour-bearing data, and re-asserting a TypeScript
 * constant over a shipped figure would silently retune withholding for every
 * tenant at deploy time with no version bump and no audit row. Changing a
 * shipped figure means a new dataset version. See DECISIONS D-N12.
 *
 * BOTH MODES PRINT THE TARGET DATABASE FIRST. An unset DATABASE_URL makes the
 * client fall back to the database named after your OS user and report
 * "relation does not exist" for a table that is present and healthy somewhere
 * else — the same trap CLAUDE.md documents for db:reset/db:rls. Never answer
 * "is the catalog seeded?" without seeing which database answered.
 *
 * Usage:
 *   DATABASE_URL=... bun run scripts/seed-tax-reference.ts
 *   DATABASE_URL=... bun run scripts/seed-tax-reference.ts --status   # read-only
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  DATASET_V1,
  seedTaxReference,
  taxReferenceStatus,
  WITHHOLDING_BRACKETS,
  DE_MINIMIS_CEILINGS,
} from "../src/lib/tax/reference-catalog";

type Row = Record<string, unknown>;

async function query(statement: ReturnType<typeof sql>): Promise<Row[]> {
  const result = (await db.execute(statement)) as unknown;
  return (Array.isArray(result) ? result : ((result as { rows?: Row[] }).rows ?? [])) as Row[];
}

/** Print the connection first, so a surprising answer can never be blamed on the wrong database. */
async function reportTarget() {
  const [row] = await query(sql`
    SELECT current_database() AS db,
           current_user       AS usr,
           coalesce(inet_server_addr()::text, 'local socket') AS host
  `);
  console.log(`🔌 ${row?.db} as ${row?.usr} (${row?.host})\n`);
}

async function tableExists(table: string): Promise<boolean> {
  const [row] = await query(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
  return row?.present === true;
}

async function reportStatus() {
  if (!(await tableExists("tax_reference_datasets"))) {
    console.log("❌ tax_reference_datasets does not exist on this database.");
    console.log(
      "   It is created by drizzle/0037_tax_reference_core.sql via\n" +
        "   scripts/apply-tax-foundation.ts, which must run BEFORE `drizzle-kit push`.\n" +
        "   That is a migration-wiring problem, not a seeding problem — do not run the seeder to fix it.",
    );
    return;
  }

  const status = await taxReferenceStatus(db);
  console.log(`📋 Dataset ${DATASET_V1.version}`);
  console.log(
    `   withholding brackets  ${status.brackets.actual}/${status.brackets.expected}` +
      `   de minimis ceilings  ${status.deMinimis.actual}/${status.deMinimis.expected}`,
  );

  const byAnnex = await query(sql`
    SELECT annex, count(*)::int AS n FROM tax_withholding_tables
    WHERE dataset_version = ${DATASET_V1.version} GROUP BY 1 ORDER BY 1
  `);
  if (byAnnex.length > 0) {
    const parts = byAnnex.map((r) => `Annex ${r.annex}: ${r.n}`).join("   ");
    console.log(`   ${parts}`);
  }
  // Both generations must be present: RR 11-2018's own Illustrations 6-15 —
  // the golden vectors — compute under Annex D. A catalog carrying only
  // Annex E red-builds the vector suite (blocker B3).
  const annexes = new Set(byAnnex.map((r) => String(r.annex)));
  if (status.brackets.actual > 0 && (!annexes.has("D") || !annexes.has("E"))) {
    console.log("\n⚠️  Only one annex generation is present. Both D and E are required — see B3.");
  }

  if (status.brackets.actual === 0 && status.deMinimis.actual === 0) {
    console.log(
      `\n➕ Empty — the seeder would insert ${WITHHOLDING_BRACKETS.length} bracket(s) and ` +
        `${DE_MINIMIS_CEILINGS.length} ceiling(s).`,
    );
  } else if (
    status.brackets.actual === status.brackets.expected &&
    status.deMinimis.actual === status.deMinimis.expected
  ) {
    console.log("\n✅ Complete — the seeder would be a no-op.");
  } else {
    console.log("\n➕ Partially seeded; the seeder would insert the remainder.");
  }

  // The staleness signal the whole governance mechanism hangs on. Unverified is
  // the correct state today: RR 11-2018 Annexes D and E were not retrievable
  // from bir-cdn.bir.gov.ph (DECISIONS U7 / blocker B3).
  if (status.lastVerifiedAt) {
    console.log(`\n🔎 Last verified against primary sources: ${status.lastVerifiedAt}`);
  } else {
    console.log(
      "\n⚠️  UNVERIFIED against primary sources.\n" +
        "   Retrieve RR 11-2018 Annex E (and RMC 1-2018 for Annex D), confirm every\n" +
        "   prescribed-tax constant, then set last_verified_at. Until then the UI shows\n" +
        "   this dataset as stale — that warning is correct, do not suppress it.",
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "❌ DATABASE_URL is not set.\n" +
        "   Local:  DATABASE_URL=\"$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"')\" bun run db:tax-reference:status",
    );
    process.exit(1);
  }

  await reportTarget();

  if (process.argv.includes("--status")) {
    await reportStatus();
    console.log("\nStatus check complete; nothing was written.");
    return;
  }

  if (!(await tableExists("tax_reference_datasets"))) {
    console.error(
      "❌ tax_reference_datasets does not exist. Run scripts/apply-tax-foundation.ts first.",
    );
    process.exit(1);
  }

  console.log(
    `🌱 Seeding tax reference dataset ${DATASET_V1.version} ` +
      `(${WITHHOLDING_BRACKETS.length} brackets, ${DE_MINIMIS_CEILINGS.length} ceilings)...\n`,
  );
  const result = await seedTaxReference(db);
  console.log(`  📦 Dataset row:      ${result.datasetInserted ? "inserted" : "already present"}`);
  console.log(
    `  ➕ Brackets:         ${result.brackets.inserted} inserted, ${result.brackets.skipped} already present`,
  );
  console.log(
    `  ➕ De minimis:       ${result.deMinimis.inserted} inserted, ${result.deMinimis.skipped} already present`,
  );
  console.log("\n✅ Tax reference catalog seeded.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
