/**
 * Wiring for Inbox v2 Jev approval lanes (spec §8, build step 11).
 *
 * The behavior lives in the unit and integration suites; these pin the links
 * that fail silently when they break — a migration no build path runs, a table
 * with no RLS policy, an auto lane the database would accept without limits.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { aiAutonomyLanes, aiRunFeedback, organizationAiSettings } from "@/db/schema/ai";

const ROOT = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/** Every TypeScript source file under the given roots, as repo-relative paths. */
function sourceFiles(...roots: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(relative(ROOT, path));
    }
  };
  for (const root of roots) walk(join(ROOT, root));
  return files;
}

describe("Jev approval lanes wiring", () => {
  it("runs 0060 in the foundation runner, after 0059", () => {
    const runner = read("scripts/apply-tax-foundation.ts");
    const at0059 = runner.indexOf("0059_classification_memories.sql");
    const at0060 = runner.indexOf("0060_ai_autonomy_lanes.sql");
    expect(at0059).toBeGreaterThan(-1);
    expect(at0060).toBeGreaterThan(at0059);
  });

  it("keeps the migration convergent: every create and add is guarded", () => {
    const migration = read("drizzle/0060_ai_autonomy_lanes.sql");
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    // Every CHECK is added only when its name is absent.
    for (const name of [
      "ai_autonomy_lanes_level_check",
      "ai_autonomy_lanes_lane_key_check",
      "ai_autonomy_lanes_threshold_range_check",
      "ai_autonomy_lanes_amount_cap_check",
      "ai_autonomy_lanes_auto_limits_check",
      "organization_ai_settings_spot_check_rate_check",
    ]) {
      expect(migration).toContain(`WHERE conname = '${name}'`);
    }
    expect(migration).toMatch(
      /\('ai_run_feedback', 'lane_id', 'ai_autonomy_lanes', 'SET NULL',\s+'ai_run_feedback_lane_id_ai_autonomy_lanes_id_fk'\)/,
    );
  });

  it("declares the lane identity, the one-label-per-proposal key, and the auto-limits CHECK", () => {
    const lanes = getTableConfig(aiAutonomyLanes);
    const indexes = lanes.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      columns: index.config.columns.map((column) => ("name" in column ? column.name : "?")),
    }));
    expect(indexes).toContainEqual({
      name: "ai_autonomy_lanes_identity_unique",
      unique: true,
      columns: ["organization_id", "lane_key", "party_id", "doc_kind"],
    });
    expect(indexes).toContainEqual({
      name: "ai_autonomy_lanes_partyless_unique",
      unique: true,
      columns: ["organization_id", "lane_key", "doc_kind"],
    });
    expect(lanes.checks.map((item) => item.name).sort()).toEqual(
      [
        "ai_autonomy_lanes_amount_cap_check",
        "ai_autonomy_lanes_auto_limits_check",
        "ai_autonomy_lanes_lane_key_check",
        "ai_autonomy_lanes_level_check",
        "ai_autonomy_lanes_threshold_range_check",
      ].sort(),
    );

    const feedback = getTableConfig(aiRunFeedback);
    const laneFk = feedback.foreignKeys.find((fk) => fk.reference().columns[0].name === "lane_id");
    expect(laneFk?.onDelete).toBe("set null");
    expect(getTableConfig(laneFk!.reference().foreignTable).name).toBe("ai_autonomy_lanes");
    const labelIndex = feedback.indexes.find(
      (index) => index.config.name === "ai_run_feedback_org_label_key_unique",
    );
    expect(labelIndex?.config.unique).toBe(true);

    // The org switch is off unless an admin turns it on.
    const settings = getTableConfig(organizationAiSettings);
    const enabled = settings.columns.find((column) => column.name === "inbox_autoapprove_enabled");
    expect(enabled?.default).toBe(false);
    expect(enabled?.notNull).toBe(true);
  });

  it("gives ai_autonomy_lanes the standard tenant policy", () => {
    const policies = read("drizzle/rls_policies.sql");
    const start = policies.indexOf("Jev approval lanes (ai_autonomy_lanes)");
    expect(start).toBeGreaterThan(-1);
    const block = policies.slice(start, policies.indexOf("END $$;", start));
    expect(block).toContain("ALTER TABLE ai_autonomy_lanes ENABLE ROW LEVEL SECURITY");
    expect(block).toContain(
      "USING (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
    expect(block).toContain(
      "WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
  });

  it("records stage 2's proposal in the classify job's apply transaction, after completion", () => {
    const handler = read("src/lib/jobs/handlers/classify-inbox-candidate.ts");
    const completeAt = handler.indexOf("completeProcessingJob(tx, job.id, ctx.workerId)");
    const recordAt = handler.indexOf("recordJevProposalAfterClassification(tx, {");
    expect(completeAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(completeAt);
    // The hook runs in a savepoint and never fails the classification; it
    // queues Jev's approval only when the proposal already passed every check.
    const hook = read("src/lib/inbox/jev-approval/after-classification.ts");
    expect(hook).toContain("return await tx.transaction(async (savepoint) => {");
    expect(hook).toContain("if (proposal?.evaluation.approve) {");
    expect(hook).toContain("await enqueueJevAutoApproval(savepoint, {");
  });

  it("registers the jev_auto_approve job and runs it in the job row's organization", () => {
    const registry = read("src/lib/jobs/registry.ts");
    expect(registry).toContain("[JEV_AUTO_APPROVE_JOB_TYPE]: processJevAutoApproveJob");
    expect(read("src/lib/jobs/retry-policy.ts")).toContain("jev_auto_approve: BACKGROUND");
    const handler = read("src/lib/jobs/handlers/jev-auto-approve.ts");
    expect(handler).toMatch(/withOrgContext\(\s*job\.organizationId,/);
    // Completion commits with the approval: a lost lease rolls both back.
    const runAt = handler.indexOf("await runJevAutoApproval(tx, {");
    const completeAt = handler.indexOf("completeProcessingJob(tx, job.id, ctx.workerId)");
    expect(runAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(runAt);
  });

  it("mints lane grants in the approval job only, after the lifecycle lock and the decision", () => {
    const minters = sourceFiles("src", "server").filter((file) =>
      read(file).includes("mintJevApprovalGrant("),
    );
    expect(minters.sort()).toEqual(
      [
        "src/lib/inbox/jev-approval/auto-approve.ts",
        "src/lib/posting/system-approval-grant.ts",
      ].sort(),
    );
    const job = read("src/lib/inbox/jev-approval/auto-approve.ts");
    const lockAt = job.indexOf("await lockInboxCandidateLifecycle(tx, orgId, identity.id)");
    const decideAt = job.indexOf("const decision = evaluateJevApproval(approvalInput);");
    const holdAt = job.indexOf(
      "if (!decision.approve || !lane || facts.answer.confidence === null)",
    );
    const mintAt = job.indexOf("const grant = mintJevApprovalGrant({");
    expect(lockAt).toBeGreaterThan(-1);
    expect(decideAt).toBeGreaterThan(lockAt);
    expect(holdAt).toBeGreaterThan(decideAt);
    expect(mintAt).toBeGreaterThan(holdAt);
    // The lane and the org switch are share-locked for the decision.
    expect(job).toContain('{ lock: "share" }');
  });

  it("builds the posting system actor in approveInboxItem only", () => {
    const builders = sourceFiles("src", "server").filter((file) =>
      /type: "system", key: "jev", grant/.test(read(file)),
    );
    expect(builders).toEqual(["src/lib/inbox/service.ts"]);
  });

  it("labels every human decision on a proposal: approve, reject, correct", () => {
    const service = read("src/lib/inbox/service.ts");
    expect(service).toContain('action: "approve",');
    expect(service).toContain('action: "reject",');
    expect(service.match(/recordJevLaneFeedback\(/g)).toHaveLength(2);
    const correction = read("src/lib/inbox/candidate-correction.ts");
    expect(correction).toContain('action: "correct",');
    expect(correction.match(/recordJevLaneFeedback\(/g)).toHaveLength(1);
  });
});
