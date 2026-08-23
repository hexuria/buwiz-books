// Applies the idempotent post-schema migrations, in order.
//
// NAME IS HISTORICAL: this started as the PH tax foundation applier (0037+)
// and is now the general home for every post-schema migration the managed
// manifest does not carry (0048 clearing exclusivity, 0049/0050, and future
// entries). Renaming the file would churn CI, package scripts, and the
// wiring tests for no behavioral gain — recorded in docs/audit-backlog.md.
//
// Runs BEFORE `drizzle-kit push --force` in every build path, for the same
// reason scripts/apply-ai-foundation.ts does: with unmanaged tables present
// (app_manual_migrations), push prompts interactively for brand-new tables
// ("created or renamed?"), which hangs a non-TTY deploy. Locally `db:fresh`
// drops the schema first, so this failure mode only ever appears in
// production — which is why the ordering is asserted in
// tests/unit/tax-reference-wiring.test.ts rather than left to convention.
//
// See docs/tax/IMPLEMENTATION-PLAN.md blocker B2.
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const sql = postgres(connectionString, { max: 1 });
try {
  // Order matters: 0035's foreign keys reference `parties`, which push creates,
  // but its own tables must exist before the seeder and before any payroll
  // query. Both files are convergent, so running them twice is a no-op.
  const files = [
    "0037_tax_reference_core.sql",
    "0038_payroll_compliance.sql",
    "0039_payroll_contribution_check.sql",
    "0040_party_tax_profiles.sql",
    "0041_journal_balance_constraint.sql",
    "0042_journal_amendment_lineage.sql",
    "0043_payroll_run_journal_link.sql",
    "0044_payroll_acknowledgement_note.sql",
    "0045_tax_certificates.sql",
    "0046_payroll_filing_state.sql",
    "0047_tax_stage_remainder.sql",
    "0048_statement_clearing_exclusivity.sql",
    "0049_contribution_deferred_status.sql",
    "0050_year_state_opening_balance.sql",
    "0051_void_rewrite_guard.sql",
    "0052_posted_journal_needs_lines.sql",
  ];
  for (const file of files) {
    const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    await sql.unsafe(migration);
  }
  console.log(`✅ Tax foundation applied, idempotent (${files.length} migrations)`);
} finally {
  await sql.end();
}
