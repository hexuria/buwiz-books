// ============================================================================
// AI permission matrix — pins the two-key model per role.
//
// Key 1: every AI endpoint gates aiTask:<action> in its wrapper.
// Key 2: the endpoint (or proposal applier) asserts the UNDERLYING resource
// permission. This matrix pins both layers so a grant change that would
// silently widen or break AI access fails a test instead.
// ============================================================================
import { describe, expect, it } from "vitest";
import { roleHasPermission } from "../../../src/lib/auth-middleware";

// Better Auth role keys as stored on memberships
const ROLES = ["owner", "admin", "member", "client_approver", "report_viewer"] as const;

describe("aiTask resource grants", () => {
  it.each([
    ["owner", "view", true],
    ["owner", "run", true],
    ["owner", "configure", true],
    ["admin", "view", true],
    ["admin", "run", true],
    ["admin", "configure", true],
    ["member", "view", true],
    ["member", "run", true],
    ["member", "configure", false],
    // ai_findings #16 fix: the all-view role can use read-only AI tasks
    ["client_approver", "view", true],
    ["client_approver", "run", true],
    ["client_approver", "configure", false],
    ["report_viewer", "view", true],
    ["report_viewer", "run", false],
    ["report_viewer", "configure", false],
  ] as const)("%s aiTask:%s → %s", (role, action, expected) => {
    expect(roleHasPermission(role, "aiTask", action)).toBe(expected);
  });
});

describe("two-key model: endpoint underlying permissions", () => {
  // Mirror of the endpoint gate table in the Phase-1 plan.
  const ENDPOINT_UNDERLYING: Array<{
    endpoint: string;
    resource: string;
    action: string;
    expected: Record<(typeof ROLES)[number], boolean>;
  }> = [
    {
      endpoint: "transaction-parse",
      resource: "journal",
      action: "create",
      expected: {
        owner: true,
        admin: true,
        member: true,
        client_approver: false,
        report_viewer: false,
      },
    },
    {
      endpoint: "receipt-ocr / bbox",
      resource: "document",
      action: "view",
      expected: {
        owner: true,
        admin: true,
        member: true,
        client_approver: true,
        report_viewer: true,
      },
    },
    {
      endpoint: "statement-ocr",
      resource: "reconciliation",
      action: "create",
      expected: {
        owner: true,
        admin: true,
        member: false,
        client_approver: false,
        report_viewer: false,
      },
    },
    {
      endpoint: "bill-ocr",
      resource: "bill",
      action: "create",
      expected: {
        owner: true,
        admin: true,
        member: true,
        client_approver: false,
        report_viewer: false,
      },
    },
    {
      endpoint: "classify-document",
      resource: "document",
      action: "upload",
      expected: {
        owner: true,
        admin: true,
        member: true,
        client_approver: false,
        report_viewer: false,
      },
    },
  ];

  for (const row of ENDPOINT_UNDERLYING) {
    for (const role of ROLES) {
      it(`${row.endpoint}: ${role} ${row.resource}:${row.action} → ${row.expected[role]}`, () => {
        expect(roleHasPermission(role, row.resource, row.action)).toBe(row.expected[role]);
      });
    }
  }
});

describe("two-key model: proposal applier underlying permissions", () => {
  // create_party applier: party:create (+account/financialAccount for banks)
  it("member cannot approve create_party (lacks party:create)", () => {
    expect(roleHasPermission("member", "party", "create")).toBe(false);
  });
  it("admin can approve create_party incl. bank infrastructure", () => {
    expect(roleHasPermission("admin", "party", "create")).toBe(true);
    expect(roleHasPermission("admin", "account", "create")).toBe(true);
    expect(roleHasPermission("admin", "financialAccount", "create")).toBe(true);
  });
  it("client_approver cannot approve any writing proposal kind", () => {
    expect(roleHasPermission("client_approver", "party", "create")).toBe(false);
    expect(roleHasPermission("client_approver", "document", "upload")).toBe(false);
  });
});

describe("aiTask never grants underlying writes on its own", () => {
  it("member holds aiTask:run but not party:create / reconciliation:create", () => {
    expect(roleHasPermission("member", "aiTask", "run")).toBe(true);
    expect(roleHasPermission("member", "party", "create")).toBe(false);
    expect(roleHasPermission("member", "reconciliation", "create")).toBe(false);
  });
});
