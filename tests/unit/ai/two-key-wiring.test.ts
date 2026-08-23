import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Audit PR-19 — the two-key model at the AI route boundary. aiTask:run is
 * the first key (may the caller invoke AI at all); handlers that touch or
 * stage an underlying resource must also assert that resource's permission.
 */
describe("AI route two-key wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../../..", rel), "utf-8");

  it("the entity resolver asserts party:create before staging create_party proposals", () => {
    const source = read("src/routes/api/-ai-entity-resolver.ts");
    expect(source).toContain('assertRolePermission(role, "party", "create")');
  });

  it("date parsing stays deliberately single-key — read-only, no underlying resource", () => {
    const source = read("src/routes/api/-ai-date-parse.ts");
    // The ai_findings #16 decision: clientApprover can use the date filter
    // without document:upload. The comment documents it; keep it that way.
    expect(source).toContain("aiTask:run alone suffices");
    expect(source).not.toContain("assertRolePermission(");
  });
});
