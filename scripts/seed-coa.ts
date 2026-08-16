/**
 * Seed Chart of Accounts Script
 *
 * A thin wrapper over the same preset applier the app uses, so the CLI path and
 * the product path cannot drift. The account tree itself now lives in
 * `src/lib/coa/presets/`.
 *
 * Idempotent and scoped to ONE organization: it never deletes, accounts the org
 * already has (matched by number, then name) are reused rather than duplicated,
 * and no other organization's data is touched. The previous version ran
 * `DELETE FROM accounts` with no org predicate, which wiped every tenant's chart.
 *
 * Usage:
 *   ORG_ID=<org> bun run scripts/seed-coa.ts
 *   ORG_ID=<org> COA_PRESET=saas_startup bun run scripts/seed-coa.ts
 */
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../src/db";
import { executeCoaPlan } from "../src/lib/coa/execute-plan";
import { planCoaPreset } from "../src/lib/coa/plan-preset";
import { DEFAULT_PRESET_ID, getPreset, listPresets } from "../src/lib/coa/presets";
import { loadCoaSnapshot } from "../src/lib/coa/snapshot";

async function seedCOA() {
  const presetId = process.env.COA_PRESET || DEFAULT_PRESET_ID;
  const preset = getPreset(presetId);
  if (!preset) {
    console.error(
      `❌ Unknown preset "${presetId}". Available: ${listPresets()
        .map((p) => p.id)
        .join(", ")}`,
    );
    process.exit(1);
  }

  const orgId =
    process.env.ORG_ID ||
    ((await db.execute(sql`SELECT id FROM auth_organizations LIMIT 1`)) as any)?.[0]?.id;
  if (!orgId) {
    console.error("❌ No organization found. Set ORG_ID or create an org first.");
    process.exit(1);
  }

  console.log(`🌱 Applying "${preset.label}" to organization ${orgId}...\n`);

  // The executor asserts it is inside an org context and refuses to run without
  // one, so this wrapper is required rather than incidental.
  const result = await withOrgContext(orgId, "system", "admin", async (tx) => {
    const snapshot = await loadCoaSnapshot(tx, orgId);
    const plan = planCoaPreset(snapshot, preset, { onConflict: "renumber" });
    return executeCoaPlan(tx, orgId, plan, "system");
  });

  console.log(`  ➕ Created:          ${result.created}`);
  console.log(`  ♻️  Reused existing:  ${result.reused}`);
  console.log(`  🏷️  Subtypes filled:  ${result.subtypesFilled}`);
  console.log(`  🔗 Mappings written: ${result.mappingsWritten}`);
  if (result.mappingsSkipped > 0) {
    console.log(`  ⏭️  Mappings kept:    ${result.mappingsSkipped} (already set)`);
  }
  for (const r of result.renumbered) {
    console.log(`  🔢 Renumbered "${r.name}": ${r.from} → ${r.to}`);
  }
  for (const warning of result.warnings) {
    console.log(`  ⚠️  ${warning}`);
  }
  console.log("\n✅ Chart of Accounts applied successfully!\n");
}

seedCOA()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error seeding COA:", error);
    process.exit(1);
  });
