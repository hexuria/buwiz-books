// ============================================================================
// getSessionContext — org/role consistency
//
// The role returned must ALWAYS come from the membership row of the org being
// acted on. The pre-fix fallback took the user's arbitrary first membership
// (no ORDER BY), which could hand back a role from a DIFFERENT org than the
// active one — e.g. admin-in-A silently acting as admin on B.
// ============================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSessionContext } from "../../../src/lib/auth-middleware";
import { AuthorizationError } from "../../../src/lib/auth-errors";

const { selectMock, getSessionMock, setActiveOrganizationMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getSessionMock: vi.fn(),
  setActiveOrganizationMock: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: selectMock,
  },
}));

vi.mock("../../../src/lib/auth", () => ({
  auth: {
    api: {
      getSession: getSessionMock,
      setActiveOrganization: setActiveOrganizationMock,
    },
  },
}));

const USER_ID = "user-1";

interface MembershipRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

/** Build a Better-Auth-shaped session the auth-types accessors understand. */
function sessionWith(opts: { activeOrganizationId?: string | null; activeMemberRole?: string }) {
  return {
    user: { id: USER_ID },
    session: { activeOrganizationId: opts.activeOrganizationId ?? null },
    ...(opts.activeMemberRole ? { activeMember: { role: opts.activeMemberRole } } : {}),
  };
}

/**
 * Mock the membership query chain. Supports both shapes used by
 * getSessionContext:
 *   select().from().where().limit(1)              — active-org role lookup
 *   select().from().where().orderBy().limit(1)    — oldest-membership fallback
 * The orderBy branch sorts rows like the real query (createdAt asc, id asc).
 */
function mockMemberships(rows: MembershipRow[], opts?: { forOrg?: string }) {
  const filtered = opts?.forOrg ? rows.filter((r) => r.organizationId === opts.forOrg) : rows;
  const sorted = [...filtered].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const limitDirect = vi.fn().mockResolvedValue(filtered.slice(0, 1));
  const limitOrdered = vi.fn().mockResolvedValue(sorted.slice(0, 1));
  const orderBy = vi.fn().mockReturnValue({ limit: limitOrdered });
  const where = vi.fn().mockReturnValue({ limit: limitDirect, orderBy });
  const from = vi.fn().mockReturnValue({ where });
  selectMock.mockReturnValue({ from });
}

const HEADERS = new Headers();

describe("getSessionContext org/role consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveOrganizationMock.mockResolvedValue(undefined);
  });

  it("resolves the role from the ACTIVE org's membership, never another org's", async () => {
    // Admin in org A (older membership), member in org B. Active org: B.
    // The pre-fix code would return A's "admin" role for actions on B.
    getSessionMock.mockResolvedValue(sessionWith({ activeOrganizationId: "org-B" }));
    mockMemberships(
      [
        {
          id: "m1",
          organizationId: "org-A",
          userId: USER_ID,
          role: "admin",
          createdAt: new Date("2025-01-01"),
        },
        {
          id: "m2",
          organizationId: "org-B",
          userId: USER_ID,
          role: "member",
          createdAt: new Date("2025-06-01"),
        },
      ],
      { forOrg: "org-B" },
    );

    const ctx = await getSessionContext(HEADERS);
    expect(ctx.orgId).toBe("org-B");
    expect(ctx.role).toBe("member");
  });

  it("keeps the session-provided role when the session already carries org + role", async () => {
    getSessionMock.mockResolvedValue(
      sessionWith({ activeOrganizationId: "org-A", activeMemberRole: "admin" }),
    );
    // No membership query should be needed at all.
    const ctx = await getSessionContext(HEADERS);
    expect(ctx.orgId).toBe("org-A");
    expect(ctx.role).toBe("admin");
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("picks the OLDEST membership deterministically when no active org is set", async () => {
    getSessionMock.mockResolvedValue(sessionWith({ activeOrganizationId: null }));
    mockMemberships([
      {
        id: "m2",
        organizationId: "org-newer",
        userId: USER_ID,
        role: "admin",
        createdAt: new Date("2025-06-01"),
      },
      {
        id: "m1",
        organizationId: "org-older",
        userId: USER_ID,
        role: "member",
        createdAt: new Date("2025-01-01"),
      },
    ]);

    const ctx = await getSessionContext(HEADERS);
    // Both org AND role must come from the same (oldest) row.
    expect(ctx.orgId).toBe("org-older");
    expect(ctx.role).toBe("member");
    expect(setActiveOrganizationMock).toHaveBeenCalledWith({
      headers: HEADERS,
      body: { organizationId: "org-older" },
    });
  });

  it("throws AuthorizationError when the active org has no membership (stale org)", async () => {
    getSessionMock.mockResolvedValue(sessionWith({ activeOrganizationId: "org-gone" }));
    mockMemberships(
      [
        {
          id: "m1",
          organizationId: "org-A",
          userId: USER_ID,
          role: "admin",
          createdAt: new Date("2025-01-01"),
        },
      ],
      { forOrg: "org-gone" },
    );

    await expect(getSessionContext(HEADERS)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("throws when the user has no memberships at all", async () => {
    getSessionMock.mockResolvedValue(sessionWith({ activeOrganizationId: null }));
    mockMemberships([]);

    await expect(getSessionContext(HEADERS)).rejects.toThrow("No active organization");
  });
});
