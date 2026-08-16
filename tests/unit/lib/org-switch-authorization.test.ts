// ============================================================================
// adminSwitchOrg / listAllOrganizations — the tenant boundary
//
// `adminSwitchOrg` used to insert an auth_members row for a client-supplied
// organizationId whenever the caller held admin or owner in ANY organization.
// Every user who creates a workspace is its owner, so that predicate is
// self-assignable: any customer could grant themselves admin in any tenant and
// then read that tenant's ledger through the normal RLS wrappers.
//
// The rule these tests pin down: a membership row is written ONLY for the
// ADMIN_EMAIL platform operator, and the platform-wide org list — every entry of
// which is a cross-tenant target — is disclosed to nobody else.
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { withSessionOrgContextMock, withMutationPermissionOrgContextMock } = vi.hoisted(() => ({
  withSessionOrgContextMock: vi.fn(),
  withMutationPermissionOrgContextMock: vi.fn(),
}));

// `createServerFn().handler(fn)` needs the Start runtime's AsyncLocalStorage to
// dispatch. The routing layer is not what is under test — the authorization
// decision inside the handler is — so the builder is reduced to the identity
// wrapper the client call shape (`fn({ data })`) already assumes.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (fn: (opts: { data: unknown }) => unknown) => (opts?: { data?: unknown }) =>
      fn({ data: opts?.data }),
  }),
}));

// The wrappers resolve the session and set the RLS org context; both are out of
// scope here, so each just hands the callback the ctx built per test. Passing
// them at all means the caller already cleared `organization:update`, which is
// exactly the attacker's position in the finding.
vi.mock("@/lib/server-context", () => ({
  withSessionOrgContext: withSessionOrgContextMock,
  withMutationPermissionOrgContextMock,
  withMutationPermissionOrgContext: withMutationPermissionOrgContextMock,
}));

import { adminSwitchOrg, listAllOrganizations } from "@/routes/api/-org-settings";

const OPERATOR_EMAIL = "operator@example.com";
const ATTACKER_ID = "user-attacker";
const VICTIM_ORG = "org-victim";
const OWN_ORG = "org-own";

/** Rows the mocked `select ... from(member).where(...)` returns. */
let membershipRows: Array<{ id: string }>;
/** Every row handed to `insert(...).values(...)`, so a write cannot pass unseen. */
let inserted: unknown[];
/** Rows the mocked platform-wide organization query returns. */
const ALL_ORGS = [{ id: VICTIM_ORG, name: "Victim Ltd", slug: "victim", logo: null }];

function buildCtx(email: string | undefined) {
  const limit = vi.fn(async () => membershipRows);
  const orderBy = vi.fn(async () => ALL_ORGS);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where, orderBy }));
  return {
    userId: ATTACKER_ID,
    orgId: OWN_ORG,
    role: "owner",
    session: email ? { user: { id: ATTACKER_ID, email } } : { user: { id: ATTACKER_ID } },
    db: {
      select: vi.fn(() => ({ from })),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          inserted.push(row);
        }),
      })),
    },
  };
}

/** Point both wrappers at a context whose session carries `email`. */
function signedInAs(email: string | undefined) {
  const ctx = buildCtx(email);
  withSessionOrgContextMock.mockImplementation((fn: any) => fn(ctx));
  withMutationPermissionOrgContextMock.mockImplementation((_r: any, _a: any, _g: any, fn: any) =>
    fn(ctx),
  );
  return ctx;
}

describe("cross-organization switching", () => {
  const originalAdminEmail = process.env.ADMIN_EMAIL;

  beforeEach(() => {
    membershipRows = [];
    inserted = [];
    process.env.ADMIN_EMAIL = OPERATOR_EMAIL;
  });

  afterEach(() => {
    if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = originalAdminEmail;
    vi.clearAllMocks();
  });

  describe("adminSwitchOrg", () => {
    it("refuses a non-member and writes no membership row", async () => {
      signedInAs("attacker@example.com");
      membershipRows = []; // not a member of the victim org

      await expect(
        (adminSwitchOrg as any)({ data: { organizationId: VICTIM_ORG } }),
      ).rejects.toThrow(/not authorized/i);
      expect(inserted).toEqual([]);
    });

    it("still refuses when ADMIN_EMAIL is unset, so the path fails closed", async () => {
      delete process.env.ADMIN_EMAIL;
      signedInAs(OPERATOR_EMAIL); // the operator address, but nothing is configured
      membershipRows = [];

      await expect(
        (adminSwitchOrg as any)({ data: { organizationId: VICTIM_ORG } }),
      ).rejects.toThrow(/not authorized/i);
      expect(inserted).toEqual([]);
    });

    it("refuses when the session carries no email at all", async () => {
      signedInAs(undefined);
      membershipRows = [];

      await expect(
        (adminSwitchOrg as any)({ data: { organizationId: VICTIM_ORG } }),
      ).rejects.toThrow(/not authorized/i);
      expect(inserted).toEqual([]);
    });

    it("lets an existing member switch without writing anything", async () => {
      signedInAs("member@example.com");
      membershipRows = [{ id: "membership-1" }];

      await expect((adminSwitchOrg as any)({ data: { organizationId: OWN_ORG } })).resolves.toEqual(
        { success: true },
      );
      expect(inserted).toEqual([]);
    });

    it("grants the platform operator a membership row, case- and space-insensitively", async () => {
      signedInAs(`  ${OPERATOR_EMAIL.toUpperCase()} `);
      membershipRows = [];

      await expect(
        (adminSwitchOrg as any)({ data: { organizationId: VICTIM_ORG } }),
      ).resolves.toEqual({ success: true });
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        userId: ATTACKER_ID,
        organizationId: VICTIM_ORG,
        role: "admin",
      });
    });
  });

  describe("listAllOrganizations", () => {
    it("discloses nothing to a tenant admin", async () => {
      signedInAs("attacker@example.com");

      await expect((listAllOrganizations as any)({ data: {} })).resolves.toEqual({
        orgs: [],
        isAdmin: false,
      });
    });

    it("returns the platform list to the operator", async () => {
      signedInAs(OPERATOR_EMAIL);

      await expect((listAllOrganizations as any)({ data: {} })).resolves.toEqual({
        orgs: ALL_ORGS,
        isAdmin: true,
      });
    });
  });
});
