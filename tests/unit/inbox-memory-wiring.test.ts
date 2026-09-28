/**
 * Wiring for Inbox v2 classification memories (spec §7, build step 10).
 *
 * The behavior lives in the integration suite (tests/integration/inbox-memory.test.ts);
 * these pin the links that fail silently when they break — a migration no
 * build path runs, a table with no RLS policy, a finding no one can see, a
 * memory that stops being consulted before the models, an undo that stops
 * being counted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEW_RULE_BY_KEY } from "../../src/lib/inbox/review-rule-catalog";
import { REVIEW_AGENT_SCHEMAS } from "../../src/lib/review-agents/agent-config-schema";

const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

describe("classification memory wiring", () => {
  it("runs 0059 in the foundation runner, after 0058", () => {
    const runner = read("scripts/apply-tax-foundation.ts");
    const at0058 = runner.indexOf("0058_party_name_trigram.sql");
    const at0059 = runner.indexOf("0059_classification_memories.sql");
    expect(at0058).toBeGreaterThan(-1);
    expect(at0059).toBeGreaterThan(at0058);
  });

  it("keeps the migration convergent and the unique key the spec names", () => {
    const migration = read("drizzle/0059_classification_memories.sql");
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).toContain(
      "ON classification_memories (organization_id, match_kind, match_key)",
    );
    // Two consecutive undos disable a memory in code; a CHECK on the counter
    // would reject the update that records the second undo.
    expect(migration).not.toMatch(/consecutive_undos\s*<\s*2/u);
  });

  it("gives the table the standard tenant policy", () => {
    const policies = read("drizzle/rls_policies.sql");
    const start = policies.indexOf("-- Inbox v2 classification memories");
    expect(start).toBeGreaterThan(-1);
    const block = policies.slice(start, policies.indexOf("END $$;", start));
    expect(block).toContain("ALTER TABLE classification_memories ENABLE ROW LEVEL SECURITY");
    expect(block).toContain(
      "USING (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
    expect(block).toContain(
      "WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())",
    );
  });

  it("exports the Drizzle table, which the v5 export/import carries", () => {
    expect(read("src/db/schema/index.ts")).toContain('export * from "./classification-memories";');
    const schema = read("src/db/schema/classification-memories.ts");
    expect(schema).toContain("exported since version 5");
    expect(read("src/lib/export-inbox.ts")).toContain(
      "export async function exportClassificationMemories(",
    );
  });

  it("registers memory_conflict as a blocking system rule with a Settings entry", () => {
    const rule = REVIEW_RULE_BY_KEY.get("memory_conflict");
    expect(rule).toMatchObject({ group: "system", evaluatorKey: "memory_conflict" });
    expect(REVIEW_AGENT_SCHEMAS.memory_conflict?.cadence).toBe("system");
    expect(read("src/lib/inbox/memory/conflict.ts")).toContain('impact: "blocking"');
  });

  it("consults memory before any model, and skips the models on a hit or a conflict", () => {
    const classifier = read("src/lib/inbox/candidate-classification.ts");
    const lookupAt = classifier.indexOf("const memory = await lookupMemoryForDraft(db, {");
    const modelsAt = classifier.indexOf(
      "const models = answeredByMemory(context) ? NO_MODEL_RESULTS : await runModels(context, complete);",
    );
    expect(lookupAt).toBeGreaterThan(-1);
    expect(modelsAt).toBeGreaterThan(lookupAt);
    // The decision is re-made under lock before anything is written.
    expect(classifier).toContain("{ lock: true },");
    expect(classifier).toContain("sameMemoryDecision(memoryDecision, recheck.decision)");
  });

  it("treats memory-written lines as system lines new facts may replace", () => {
    const correction = read("src/lib/inbox/candidate-correction.ts");
    expect(correction).toContain('source === "inbox_classification" || source === "memory"');
  });

  it("counts undos on correction and reversal, and confirms on approval", () => {
    expect(read("src/lib/inbox/candidate-correction.ts")).toContain(
      "await noteCorrectionOfMemoryAnswer(db, {",
    );
    expect(read("src/lib/inbox/service.ts")).toContain("await noteApprovalOfMemoryAnswer(db, {");
    const amendment = read("src/lib/journal-amendment.ts");
    expect(amendment).toContain("await noteReversedMemoryEntries(db, {");
    expect(amendment).toContain('"posted_entry_reversed"');
    expect(read("src/routes/api/transactions/-_mutations.ts")).toContain(
      'reason: "posted_entry_voided",',
    );
    const bills = read("src/routes/api/-bills.ts");
    expect(bills).toContain('reason: "bill_voided",');
    // Delete lives in the session-free core the deleteBill server function calls.
    expect(bills).toContain("deleteBillCore(db, orgId, userId, parsed.id)");
    expect(read("src/lib/posting/bill-delete.ts")).toContain('reason: "bill_deleted",');
    expect(read("src/routes/api/-invoices.ts")).toContain('reason: "invoice_voided",');
  });

  it("gates the server functions: approvers save, admins manage", () => {
    const api = read("src/routes/api/-inbox-memory.ts");
    const block = (name: string) => {
      const start = api.indexOf(`export const ${name} `);
      const next = api.indexOf("export const ", start + 1);
      return api.slice(start, next === -1 ? undefined : next);
    };
    expect(block("rememberCorrection")).toContain('"inbox",\n      "approve",');
    expect(block("previewMemoryScope")).toContain('withPermissionOrgContext("inbox", "approve"');
    expect(block("listMemories")).toContain('withPermissionOrgContext("inbox", "view"');
    for (const name of ["enableMemory", "disableMemory", "deleteMemory"]) {
      expect(block(name), name).toContain('"agentRule",\n      "configure",');
    }
    // Cross-party memories are checked in the service, against the same grant.
    expect(read("src/lib/inbox/memory/service.ts")).toContain(
      'const MEMORY_ADMIN_PERMISSION = { resource: "agentRule", action: "configure" } as const;',
    );
  });

  it("gates CI on the memory test lock through the recorded evals", () => {
    expect(read("vitest.evals.config.ts")).toContain('"tests/evals/memory-lock.eval.ts"');
    expect(read(".github/workflows/deploy.yml")).toContain("run: bun run test:evals");
  });

  it("mounts the prompt in the reading pane and the memories in Review Rules", () => {
    const pane = read("src/components/inbox-v2/InboxV2Pane.tsx");
    expect(pane).toContain("<RememberThisPrompt");
    expect(pane).toContain("correctionChangesAnswer(draftAnswer(detail), correction)");
    expect(read("src/components/inbox-v2/InboxV2Page.tsx")).toContain("<RememberThisPrompt");
    expect(read("src/components/settings/ReviewRulesSettings.tsx")).toContain(
      "<MemoriesSettings />",
    );
  });

  it("builds memory query keys under the Inbox prefix", () => {
    const keys = read("src/lib/query-keys.ts");
    expect(keys).toContain('memories: () => ["inbox", "memories"] as const,');
  });
});
