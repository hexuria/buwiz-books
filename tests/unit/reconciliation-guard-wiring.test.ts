import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Program 2 P6 — reconciliation guard cluster, source-shape ratchets for the
 * route-level guards (the behavioral halves live in the lib suites).
 */
describe("reconciliation guard wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

  it("the detail page's matched set unions BOTH clearing representations", () => {
    const source = read("src/routes/api/reconciliations/-_list-detail.ts");
    expect(source).toContain("from(statementLineMatches)");
    expect(source).toContain("...splitMatches.map(");
  });

  it("agent auto-finalize is marked, anomaly-annotated machine work", () => {
    const source = read("src/routes/api/reconciliations/-_agent.ts");
    expect(source).toContain("aiAutoFinalized: true");
    expect(source).toContain("await persistReconciliationAnomalies(db, {");
  });

  it("split allocations refuse duplicates and mixed signs at validation", () => {
    const persist = read("src/lib/match-assist/persist.ts");
    expect(persist).toContain("lists the same ledger line more than once");
    expect(persist).toContain("mixes signs against the statement line");
    const blocking = read("src/lib/match-assist/blocking.ts");
    expect(blocking).toContain("Math.sign(candidate.amount) === targetSign");
  });

  it("connection party lookups escape their like patterns", () => {
    const source = read("src/routes/api/-connections.ts");
    expect(source).toContain("ilike(parties.name, escapeLikePattern(displayName))");
  });

  it("generated statements use cents and a truthful ocrConfidence scale", () => {
    const source = read("src/routes/api/reconciliations/-_statement-upload.ts");
    expect(source).toContain("const openingCents = moneyToCents(");
    expect(source).toContain('ocrConfidence: "100"');
    expect(source).not.toContain('ocrConfidence: "1.0"');
  });

  it("the bank ledger link is validated and repoint-guarded", () => {
    const source = read("src/routes/api/-financial-accounts.ts");
    expect(source).toContain("assertLedgerAccountAssignable(db, orgId, parsed.ledgerAccountId)");
    expect(source).toContain('eq(reconciliations.status, "finalized")');
    expect(source).toContain("bank_accounts");
  });

  it("financial-account reuse matches by last-four identity before label", () => {
    const source = read("src/lib/entity-creation.ts");
    expect(source).toContain("eq(financialAccounts.lastFour, lastFour)");
  });
});
