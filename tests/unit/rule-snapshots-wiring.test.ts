/**
 * Wiring for Inbox v2 rule snapshots, replay, and the scorecard gate (spec §6,
 * §9, build step 8).
 *
 * The behavior lives in the integration and eval suites; these pin the links
 * that fail silently when they break — a migration no build path runs, a
 * table with no RLS policy, a candidate path that quietly goes back to reading
 * live configs, shadow output that leaks into real findings, a gate CI never
 * runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { routines } from "@/db/schema/routines";
import { ruleSnapshots } from "@/db/schema/rule-snapshots";

const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

describe("rule snapshots wiring", () => {
  it("runs 0055 in the foundation runner, after 0054", () => {
    const runner = read("scripts/apply-tax-foundation.ts");
    const at0054 = runner.indexOf("0054_routines.sql");
    const at0055 = runner.indexOf("0055_rule_snapshots.sql");
    expect(at0054).toBeGreaterThan(-1);
    expect(at0055).toBeGreaterThan(at0054);
  });

  it("keeps the migration convergent and installs the immutability trigger", () => {
    const migration = read("drizzle/0055_rule_snapshots.sql");
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    const dropAt = migration.indexOf("DROP TRIGGER IF EXISTS rule_snapshots_forbid_update");
    const createAt = migration.indexOf("CREATE TRIGGER rule_snapshots_forbid_update");
    expect(dropAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(migration).toContain("BEFORE UPDATE ON rule_snapshots");
    // Both pins restrict deletion of the snapshot they point at.
    expect(migration).toMatch(
      /\('routines', 'rule_snapshot_id', 'rule_snapshots', 'RESTRICT',\s+'routines_rule_snapshot_id_rule_snapshots_id_fk'\)/,
    );
    expect(migration).toMatch(
      /\('routines', 'shadow_rule_snapshot_id', 'rule_snapshots', 'RESTRICT',\s+'routines_shadow_rule_snapshot_id_rule_snapshots_id_fk'\)/,
    );
  });

  it("declares both routine pins as restricting foreign keys in the schema", () => {
    const pins = getTableConfig(routines)
      .foreignKeys.map((fk) => ({
        name: fk.getName(),
        column: fk.reference().columns[0].name,
        target: getTableConfig(fk.reference().foreignTable).name,
        onDelete: fk.onDelete,
      }))
      .filter((fk) => fk.target === "rule_snapshots")
      .sort((left, right) => left.column.localeCompare(right.column));
    expect(pins).toEqual([
      {
        name: "routines_rule_snapshot_id_rule_snapshots_id_fk",
        column: "rule_snapshot_id",
        target: "rule_snapshots",
        onDelete: "restrict",
      },
      {
        name: "routines_shadow_rule_snapshot_id_rule_snapshots_id_fk",
        column: "shadow_rule_snapshot_id",
        target: "rule_snapshots",
        onDelete: "restrict",
      },
    ]);
    expect(
      getTableConfig(ruleSnapshots)
        .columns.map((column) => column.name)
        .sort(),
    ).toEqual(["created_at", "created_by", "id", "label", "organization_id", "snapshot"].sort());
  });

  it("gives rule_snapshots the standard tenant policy", () => {
    const policies = read("drizzle/rls_policies.sql");
    const start = policies.indexOf("Inbox v2 rule snapshots (rule_snapshots)");
    expect(start).toBeGreaterThan(-1);
    const block = policies.slice(start, policies.indexOf("END $$;", start));
    expect(block).toContain("ALTER TABLE rule_snapshots ENABLE ROW LEVEL SECURITY");
    expect(block).toContain(
      "USING (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
    expect(block).toContain(
      "WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
  });

  it("evaluates candidates through the resolved rule set, never a direct live read", () => {
    for (const file of [
      "src/lib/inbox/service.ts",
      "src/lib/inbox/candidate-correction.ts",
      "src/lib/inbox/candidate-classification.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toContain("reviewRuleConfigs");
      expect(source, file).not.toMatch(/\bevaluateBookRules\(/);
      expect(source, file).toContain("evaluateCandidateRules(");
      expect(source, file).toContain("withRuleSetProvenance(");
    }
    const correction = read("src/lib/inbox/candidate-correction.ts");
    expect(correction).toContain("resolveCandidateRuleSets(db, orgId, row.candidate.id");
    expect(correction).toContain("recordShadowRuleEvaluation(db, {");
    // Stage 2 re-evaluates a routine paper after classifying it, and takes its
    // pick threshold from the same rules.
    const classification = read("src/lib/inbox/candidate-classification.ts");
    expect(classification).toContain("resolveCandidateRuleSets(db, orgId, input.candidate.id");
    expect(classification).toContain("lowConfidenceThresholdOf(ruleSets.active)");
    expect(classification).toContain("recordShadowRuleEvaluation(db, {");
  });

  it("stores shadow output only as workflow events", () => {
    const module = read("src/lib/inbox/rule-snapshots.ts");
    expect(module).not.toContain("insert(reviewFindings)");
    expect(module).toContain('action: "rule_shadow_evaluated"');
  });

  it("guards the server functions with the rule-configuration permission and offers no edit", () => {
    const serverFns = read("src/routes/api/-rule-snapshots.ts");
    expect(
      serverFns.match(/withMutationPermissionOrgContext\(\s*"agentRule",\s*"configure"/g),
    ).toHaveLength(3);
    expect(serverFns.match(/withPermissionOrgContext\("agentRule", "view"/g)).toHaveLength(2);
    expect(serverFns).not.toMatch(/export const (update|delete|edit)\w*/i);
  });

  it("wires the scorecard command and runs its gate in CI without a database", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["eval:scorecard"]).toBe("bun run scripts/eval-scorecard.ts");
    expect(pkg.scripts["test:evals"]).toContain("AI_EVALS_MODE=recorded");
    expect(read("vitest.evals.config.ts")).toContain('"tests/evals/scorecard.eval.ts"');

    const workflow = read(".github/workflows/deploy.yml");
    const hermeticJob = workflow.slice(
      workflow.indexOf("static-and-hermetic-tests:"),
      workflow.indexOf("integration-tests:"),
    );
    expect(hermeticJob).toContain("run: bun run test:evals");
    // The hermetic job has no database service or URL to lean on.
    expect(hermeticJob).not.toContain("DATABASE_URL");
    expect(hermeticJob).not.toContain("services:");
  });
});
