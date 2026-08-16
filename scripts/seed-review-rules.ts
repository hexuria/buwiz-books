/**
 * Seed and inspect the review-rule catalog.
 *
 * `review_rule_definitions` is a GLOBAL table — no `organization_id`, deliberately excluded
 * from every RLS policy list — so there is no org context to establish and no ORG_ID to pass.
 *
 * Its 14 original rows only ever shipped inside drizzle/0019_inbox_review_foundation.sql, a
 * hand-applied migration that `drizzle-kit` does not run (0019 is absent from
 * drizzle/meta/_journal.json). `db:fresh`, `make migrate` and the CI deploy all create the
 * table from the Drizzle schema and leave it empty, which is why `/review-agents` renders
 * "No review agents are configured." on an otherwise healthy database.
 *
 * Idempotent and additive: ON CONFLICT (key) DO NOTHING. Existing rows are never modified —
 * 0020 already changed `possible_duplicate`'s defaults, and re-asserting a TypeScript constant
 * over a reviewed migration would silently retune duplicate blocking for every tenant.
 *
 * Deliberately NOT folded into `db:dedup:migrate`: adding that to the deploy path would apply
 * 0019-0024 to production for the first time — CHECK constraints, tenant-lineage FKs, pg_trgm —
 * a large unreviewed schema change on a live accounting database.
 *
 * BOTH MODES PRINT THE TARGET DATABASE FIRST. An unset DATABASE_URL makes psql fall back to the
 * database named after your OS user and report "relation does not exist" for a table that is
 * present and healthy somewhere else — the same trap CLAUDE.md documents for db:reset/db:rls.
 * Never answer "is the catalog seeded?" without seeing which database answered.
 *
 * Usage:
 *   DATABASE_URL=... bun run scripts/seed-review-rules.ts
 *   DATABASE_URL=... bun run scripts/seed-review-rules.ts --status   # read-only
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  REVIEW_RULE_CATALOG,
  seedReviewRuleDefinitions,
} from "../src/lib/inbox/review-rule-catalog";

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

async function catalogExists(): Promise<boolean> {
  const [row] = await query(
    sql`SELECT to_regclass('public.review_rule_definitions') IS NOT NULL AS present`,
  );
  return row?.present === true;
}

async function reportStatus() {
  if (!(await catalogExists())) {
    console.log("❌ review_rule_definitions does not exist on this database.");
    console.log(
      "   The table is in the Drizzle schema, so a `drizzle-kit push` has not run here.\n" +
        "   That is a schema problem, not a seeding problem — do not run the seeder to fix it.",
    );
    return;
  }

  const rows = await query(sql`
    SELECT key, group_name, formula_version, default_config
    FROM review_rule_definitions ORDER BY group_name, key
  `);
  const present = new Set(rows.map((row) => String(row.key)));
  const missing = REVIEW_RULE_CATALOG.filter((rule) => !present.has(rule.key));
  const unknown = rows.filter((row) => !REVIEW_RULE_CATALOG.some((r) => r.key === row.key));

  console.log(`📋 Catalog: ${rows.length} row(s), catalog defines ${REVIEW_RULE_CATALOG.length}`);
  for (const group of ["book", "review", "system"]) {
    const count = rows.filter((row) => row.group_name === group).length;
    const expected = REVIEW_RULE_CATALOG.filter((rule) => rule.group === group).length;
    console.log(`   ${group.padEnd(7)} ${count}/${expected}`);
  }
  if (missing.length > 0) {
    console.log(`\n➕ Would insert ${missing.length}: ${missing.map((r) => r.key).join(", ")}`);
  } else {
    console.log("\n✅ Every catalog rule is present — the seeder would be a no-op.");
  }
  if (unknown.length > 0) {
    console.log(
      `\n⚠️  ${unknown.length} row(s) not in the catalog: ${unknown.map((r) => r.key).join(", ")}\n` +
        "   Left untouched (DO NOTHING), but reconcile the catalog constant with them.",
    );
  }

  // The one row whose defaults are behaviour-bearing: loadDuplicateEngineConfig reads mode and
  // scores straight off default_config, so drift here silently retunes duplicate blocking.
  const duplicate = rows.find((row) => row.key === "possible_duplicate");
  if (duplicate) {
    const config = (duplicate.default_config ?? {}) as Record<string, unknown>;
    const expected = REVIEW_RULE_CATALOG.find((r) => r.key === "possible_duplicate")!;
    const drifted =
      config.mode !== expected.defaultConfig.mode ||
      config.blockingScore !== expected.defaultConfig.blockingScore ||
      Number(duplicate.formula_version) < expected.formulaVersion;
    console.log(
      `\n🔁 possible_duplicate: mode=${config.mode} blocking=${config.blockingScore} ` +
        `shadow=${config.shadowScore} v${duplicate.formula_version}` +
        (drifted
          ? "\n   ⚠️  Differs from the catalog constant — reconcile before relying on it."
          : ""),
    );
  }

  if (!(await catalogTableExists("review_findings"))) return;

  // Findings written by the pre-fix engine, which never set inbox_item_id. Their only resolution
  // path is the /review-agents findings panel.
  const orphaned = await query(sql`
    SELECT rule_key, state, count(*)::int AS n
    FROM review_findings WHERE inbox_item_id IS NULL
    GROUP BY 1, 2 ORDER BY 1, 2
  `);
  console.log("\n🔎 Findings not attached to an Inbox item:");
  if (orphaned.length === 0) {
    console.log("   none — the on-demand run has never produced findings here.");
  } else {
    for (const row of orphaned) console.log(`   ${row.rule_key} (${row.state}): ${row.n}`);
    console.log("   Resolve these from the /review-agents findings panel.");
  }

  // Calibration evidence for the enforce-vs-shadow decision.
  const duplicates = await query(sql`
    SELECT state, count(*)::int AS n
    FROM review_findings WHERE rule_key = 'possible_duplicate'
    GROUP BY 1 ORDER BY 1
  `);
  console.log("\n📊 Duplicate detection to date:");
  if (duplicates.length === 0) {
    console.log("   no duplicate findings — nothing to calibrate against yet.");
  } else {
    for (const row of duplicates) console.log(`   ${row.state}: ${row.n}`);
    console.log("   A high resolved-as-not-a-duplicate rate argues for shadow mode until tuned.");
  }

  await reportKeepSeparateExposure(!duplicate);
}

/**
 * The one way seeding is NOT behaviour-neutral, so it is checked before, not discovered after.
 *
 * `loadDuplicateEngineConfig` derives the matcher's `algorithmVersion` as a max() that includes
 * the definition's `formula_version`. With no definition row it settles at
 * DUPLICATE_MATCHER_VERSION; seeding introduces `possible_duplicate` at formula_version 2 and the
 * max() moves to 2.
 *
 * That number gates whether a duplicate pair a reviewer already dismissed as "keep separate"
 * stays dismissed (duplicate-engine.ts, the `unchanged` check). Bumping it re-raises those
 * decisions — an accounting judgement being silently undone, which is worth a query beforehand.
 */
async function reportKeepSeparateExposure(catalogEmpty: boolean) {
  if (!(await catalogTableExists("source_match_candidates"))) return;

  const [row] = await query(sql`
    SELECT
      count(*) FILTER (WHERE state = 'resolved' AND resolution_action = 'keep_separate')::int AS keep_separate,
      count(*)::int AS total,
      coalesce(max(algorithm_version), 0)::int AS max_version
    FROM source_match_candidates
  `);
  const keepSeparate = Number(row?.keep_separate ?? 0);

  console.log("\n🧮 Duplicate matcher version exposure:");
  console.log(
    `   ${row?.total ?? 0} match candidate(s), highest algorithm_version ${row?.max_version ?? 0}`,
  );
  if (!catalogEmpty) {
    console.log("   Catalog already seeded — the version is settled; nothing to weigh.");
    return;
  }
  if (keepSeparate === 0) {
    console.log(
      "   0 resolved as 'keep separate', so the version bump seeding causes re-raises nothing.\n" +
        "   ✅ Safe to seed.",
    );
    return;
  }
  console.log(
    `   ⚠️  ${keepSeparate} pair(s) resolved as 'keep separate'. Seeding moves the matcher\n` +
      "   version, which stops preserving those resolutions — reviewers would see duplicates\n" +
      "   they already dismissed come back. Decide that deliberately before seeding.",
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "❌ DATABASE_URL is not set.\n" +
        "   Local:  DATABASE_URL=\"$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"')\" bun run db:review-rules:status",
    );
    process.exit(1);
  }

  await reportTarget();

  if (process.argv.includes("--status")) {
    await reportStatus();
    console.log("\nStatus check complete; nothing was written.");
    return;
  }

  if (!(await catalogExists())) {
    console.error("❌ review_rule_definitions does not exist. Push the schema first.");
    process.exit(1);
  }

  console.log(`🌱 Seeding ${REVIEW_RULE_CATALOG.length} review rule definitions...\n`);
  const { inserted, skipped } = await seedReviewRuleDefinitions(db);
  console.log(`  ➕ Inserted:         ${inserted}`);
  console.log(`  ♻️  Already present:  ${skipped}`);
  console.log("\n✅ Review rule catalog seeded.\n");
}

async function catalogTableExists(table: string): Promise<boolean> {
  const [row] = await query(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
  return row?.present === true;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
