/**
 * Wiring for Inbox v2 routines (spec §3, build step 4).
 *
 * The behavior lives in the integration suites; these pin the links that fail
 * silently when they break — a migration no build path runs, a table with no
 * RLS policy, a job type with no handler, a webhook that stops tagging rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

describe("routines wiring", () => {
  it("runs 0054 in the foundation runner, after 0052", () => {
    const runner = read("scripts/apply-tax-foundation.ts");
    const at0052 = runner.indexOf("0052_posted_journal_needs_lines.sql");
    const at0054 = runner.indexOf("0054_routines.sql");
    expect(at0052).toBeGreaterThan(-1);
    expect(at0054).toBeGreaterThan(at0052);
  });

  it("keeps the migration convergent: every create is guarded", () => {
    const migration = read("drizzle/0054_routines.sql");
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    // 0054 predates rule_snapshots; the pin's foreign key is 0055's job.
    expect(migration).not.toMatch(/REFERENCES rule_snapshots/);
  });

  it("gives both routine tables the standard tenant policy", () => {
    const policies = read("drizzle/rls_policies.sql");
    expect(policies).toContain("ARRAY['routines', 'routine_secrets']");
    expect(policies).toContain(
      "USING (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
  });

  it("registers the routine_webhook job type with a handler", () => {
    const registry = read("src/lib/jobs/registry.ts");
    expect(registry).toContain("[ROUTINE_WEBHOOK_JOB_TYPE]: processRoutineWebhookJob");
    const retry = read("src/lib/jobs/retry-policy.ts");
    expect(retry).toContain("routine_webhook: BACKGROUND");
  });

  it("fires due schedule routines from the drain, before the claim loop", () => {
    const registry = read("src/lib/jobs/registry.ts");
    expect(registry).toContain("[ROUTINE_SCHEDULE_RUN_JOB_TYPE]: processRoutineScheduleRunJob");
    const fireAt = registry.indexOf(
      "if (jobTypes.includes(ROUTINE_SCHEDULE_RUN_JOB_TYPE)) await fireDueScheduleRoutines();",
    );
    const claimAt = registry.indexOf("const job = await claimNextProcessingJob(db, {");
    expect(fireAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(fireAt);
    expect(read("src/lib/jobs/retry-policy.ts")).toContain("routine_schedule_run: BACKGROUND");

    const scheduler = read("src/lib/routines/scheduler.ts");
    expect(scheduler).toContain('.for("update", { skipLocked: true })');
    // Every write for a due routine happens in THAT routine's org context.
    expect(scheduler).toMatch(
      /withOrgContext\(\s*candidate\.organizationId,\s*"system",\s*"admin",/,
    );
  });

  it("routes inbound email through the organization's email routine", () => {
    const source = read("server/routes/api/inbound-email/resend.post.ts");
    expect(source).toContain("ensureInboundEmailRoutine(tx, settings.organizationId)");
    expect(source).toContain('withOrgContext(settings.organizationId, "system", "admin"');
    // Both the ingestion event and the processing job carry the routine.
    expect(source.match(/routineId: routine\.id/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('action: "routine_disabled_skipped"');
  });

  it("verifies the generic webhook before its first insert", () => {
    const source = read("server/routes/api/routines/[routineId]/webhook.post.ts");
    const verifiedAt = source.indexOf("verifyRoutineWebhookSignature({");
    const firstInsert = source.indexOf(".insert(");
    expect(verifiedAt).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(verifiedAt);
    expect(source).toContain('withOrgContext(owner.organizationId, "system", "admin"');
  });

  it("never returns the secret reference from a routine read", () => {
    const service = read("src/lib/routines/service.ts");
    expect(service).toContain(
      "const { secret_ref: secretRef, ...publicConfig } = row.triggerConfig;",
    );
    expect(service).toContain("triggerConfig: toSerializableRecord(publicConfig)");
  });
});
