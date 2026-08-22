import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { roleHasPermission } from "../../../src/lib/permission-policy";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Two permissions were declared, deliberately withheld from roles, and then
 * never actually consulted by the code that does the thing they gate.
 *
 *  - `report:export` was enforced nowhere at all, while four export endpoints
 *    ran on session-only wrappers.
 *  - `bill:pay` was never consulted; the endpoint that records a payment gated
 *    on `bill:update`, which member holds.
 *
 * Both are role boundaries rather than tenant boundaries — organization scoping
 * was never in question — but a grant the code never reads is not a grant.
 *
 * The model half of this file pins WHO is denied. The wiring half pins that the
 * denial is actually reachable, because a permission is only as real as the
 * call site that asks for it.
 */
describe("export and payment permissions", () => {
  describe("the model withholds them", () => {
    it("denies report:export to member and clientApprover", () => {
      expect(roleHasPermission("member", "report", "export")).toBe(false);
      expect(roleHasPermission("client_approver", "report", "export")).toBe(false);
    });

    it("still grants report:export to the roles meant to have it", () => {
      expect(roleHasPermission("admin", "report", "export")).toBe(true);
      expect(roleHasPermission("report_viewer", "report", "export")).toBe(true);
    });

    it("denies bill:pay to member while still allowing bill:update", () => {
      // This gap is the whole reason the payment branch needs its own check:
      // the endpoint gates on update, which member has.
      expect(roleHasPermission("member", "bill", "update")).toBe(true);
      expect(roleHasPermission("member", "bill", "pay")).toBe(false);
    });

    it("everyone keeps plain view, so view-gating changes nothing", () => {
      // Recorded because it explains why the other ~68 session-only reads are
      // not a finding: no role is denied `view` on any resource today.
      // Role keys are snake_case here — ROLE_MAP in permission-policy.ts maps
      // them, and an unknown key silently returns false rather than throwing.
      for (const role of ["member", "client_approver", "report_viewer", "admin"]) {
        expect(roleHasPermission(role, "report", "view")).toBe(true);
        expect(roleHasPermission(role, "bill", "view")).toBe(true);
      }
    });
  });

  describe("the code actually asks", () => {
    const exportSources = [
      "src/routes/api/-export-transactions.ts",
      "src/routes/api/-export-import.ts",
    ];

    it("gates every export endpoint on report:export", () => {
      for (const path of exportSources) {
        const src = read(path);
        const exportFns = [...src.matchAll(/export const (\w*[Ee]xport\w*) =/g)].map((m) => m[1]);
        expect(exportFns.length).toBeGreaterThan(0);
        // No export endpoint may fall back to the session-only wrapper.
        const gated = [...src.matchAll(/withPermissionOrgContext\("report",\s*"export"/g)].length;
        expect(gated).toBeGreaterThanOrEqual(2);
      }
    });

    it("asks for bill:pay on the branch that records a payment", () => {
      const src = read("src/routes/api/-bills.ts");
      const payIndex = src.indexOf("recordManualBillPayment(db, {");
      expect(payIndex).toBeGreaterThan(-1);
      // The assertion must precede the call, inside the same branch.
      const before = src.slice(Math.max(0, payIndex - 800), payIndex);
      expect(before).toContain('assertRolePermission(role, "bill", "pay")');
    });
  });
});
