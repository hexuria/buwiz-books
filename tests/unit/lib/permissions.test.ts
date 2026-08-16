import { describe, it, expect } from "vitest";
import { statement, member, roles } from "../../../src/lib/permissions";
import type { Resource } from "../../../src/lib/permissions";
import { roleHasPermission } from "../../../src/lib/auth-middleware";

/**
 * ABAC Permission System — Structural Integrity Tests
 *
 * These tests guard against accidental permission escalation or omission.
 * If a role's statements change shape, these tests will catch it.
 */
describe("ABAC Permissions", () => {
  // ========================================================================
  // Statement (resource/action) registry
  // ========================================================================

  describe("statement registry", () => {
    const accountingResources: Resource[] = [
      "account",
      "journal",
      "reconciliation",
      "invoice",
      "bill",
      "document",
      "party",
      "dimension",
      "connection",
      "financialAccount",
      "report",
      "comment",
    ];

    it("should declare all accounting resources", () => {
      for (const resource of accountingResources) {
        expect(statement).toHaveProperty(resource);
        expect(Array.isArray(statement[resource])).toBe(true);
        expect(statement[resource].length).toBeGreaterThan(0);
      }
    });

    it("should include CRUD actions for core entity resources", () => {
      const crudResources: Resource[] = ["account", "party", "dimension", "connection"];
      for (const r of crudResources) {
        const actions = statement[r] as readonly string[];
        expect(actions).toContain("view");
        expect(actions).toContain("create");
        expect(actions).toContain("update");
        expect(actions).toContain("delete");
      }
    });

    it("should include domain-specific actions for journals", () => {
      const actions = statement.journal as readonly string[];
      expect(actions).toContain("post");
      expect(actions).toContain("void");
      expect(actions).toContain("match");
      expect(actions).toContain("unmatch");
    });

    it("should include finalize action for reconciliation", () => {
      const actions = statement.reconciliation as readonly string[];
      expect(actions).toContain("finalize");
    });

    it("should include send action for invoices", () => {
      expect(statement.invoice).toContain("send");
    });

    it("should include pay action for bills", () => {
      expect(statement.bill).toContain("pay");
    });
  });

  // ========================================================================
  // Role parity
  // ========================================================================

  describe("role definitions", () => {
    it("should have owner aliased to superuser", () => {
      expect(roles.owner).toBe(roles.superuser);
    });

    it("should export the application and Better Auth role keys", () => {
      expect(Object.keys(roles)).toHaveLength(6);
      expect(roles).toHaveProperty("superuser");
      expect(roles).toHaveProperty("admin");
      expect(roles).toHaveProperty("member");
      expect(roles).toHaveProperty("clientApprover");
      expect(roles).toHaveProperty("reportViewer");
      expect(roles).toHaveProperty("owner");
    });

    it("keeps report viewers read-only while allowing report exports", () => {
      expect(roleHasPermission("report_viewer", "journal", "view")).toBe(true);
      expect(roleHasPermission("report_viewer", "journal", "create")).toBe(false);
      expect(roleHasPermission("report_viewer", "report", "view")).toBe(true);
      expect(roleHasPermission("report_viewer", "report", "export")).toBe(true);
      expect(roleHasPermission("report_viewer", "comment", "create")).toBe(false);
    });
  });

  // ========================================================================
  // Member restrictions
  // ========================================================================

  describe("member role restrictions", () => {
    it("should NOT have delete on accounts", () => {
      const memberStatements = member.statements as Record<string, readonly string[]>;
      const accountActions = memberStatements.account ?? [];
      expect(accountActions).not.toContain("delete");
    });

    it("should have view-only access to reconciliation", () => {
      const memberStatements = member.statements as Record<string, readonly string[]>;
      const reconActions = memberStatements.reconciliation ?? [];
      expect(reconActions).toContain("view");
      expect(reconActions).not.toContain("finalize");
    });

    it("should NOT moderate comments", () => {
      const memberStatements = member.statements as Record<string, readonly string[]>;
      const commentActions = memberStatements.comment ?? [];
      expect(commentActions).not.toContain("moderate");
    });

    it("should reserve posted journal match and unmatch for owner/admin roles", () => {
      const memberJournal = member.statements.journal as readonly string[];
      const approverJournal = roles.clientApprover.statements.journal as readonly string[];
      const adminJournal = roles.admin.statements.journal as readonly string[];
      const ownerJournal = roles.owner.statements.journal as readonly string[];

      expect(memberJournal).not.toContain("match");
      expect(memberJournal).not.toContain("unmatch");
      expect(approverJournal).not.toContain("match");
      expect(approverJournal).not.toContain("unmatch");
      expect(adminJournal).toContain("match");
      expect(adminJournal).toContain("unmatch");
      expect(ownerJournal).toContain("match");
      expect(ownerJournal).toContain("unmatch");
    });
  });

  // ========================================================================
  // Master-data creation gate (guards the OCR entity-resolver fix)
  // ========================================================================

  describe("roleHasPermission — master-data creation", () => {
    // The entity resolver only auto-creates parties / GL accounts / financial
    // accounts when the caller actually holds the create permission. These
    // pins keep that invariant honest against role-definition drift.
    for (const resource of ["party", "account", "financialAccount"] as const) {
      it(`allows owner/admin but denies non-admin roles to create ${resource}`, () => {
        expect(roleHasPermission("owner", resource, "create")).toBe(true);
        expect(roleHasPermission("admin", resource, "create")).toBe(true);
        expect(roleHasPermission("member", resource, "create")).toBe(false);
        expect(roleHasPermission("client_approver", resource, "create")).toBe(false);
        expect(roleHasPermission("report_viewer", resource, "create")).toBe(false);
      });
    }

    it("returns false for an unknown role", () => {
      expect(roleHasPermission("nonexistent", "party", "create")).toBe(false);
    });
  });
});
