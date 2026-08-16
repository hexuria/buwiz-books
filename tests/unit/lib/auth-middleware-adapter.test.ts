import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "../../../src/lib/auth-errors";
import { getSessionContext } from "../../../src/lib/auth-middleware";

const { selectMock, getSessionMock, setActiveOrganizationMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getSessionMock: vi.fn(),
  setActiveOrganizationMock: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: selectMock } }));
vi.mock("../../../src/lib/auth", () => ({
  auth: {
    api: {
      getSession: getSessionMock,
      setActiveOrganization: setActiveOrganizationMock,
    },
  },
}));

const HEADERS = new Headers();
const USER_ID = "user-1";

function sessionWith(activeOrganizationId: string | null, activeMemberRole?: string) {
  return {
    user: { id: USER_ID },
    session: { activeOrganizationId },
    ...(activeMemberRole ? { activeMember: { role: activeMemberRole } } : {}),
  };
}

function mockMembershipQuery(row: { organizationId: string; role: string } | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValue({ from });
  return { from, where, orderBy, limit };
}

describe("session organization database adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveOrganizationMock.mockResolvedValue(undefined);
  });

  it("loads the active organization's membership when the session role is absent", async () => {
    getSessionMock.mockResolvedValue(sessionWith("org-b"));
    const query = mockMembershipQuery({ organizationId: "org-b", role: "member" });

    await expect(getSessionContext(HEADERS)).resolves.toMatchObject({
      orgId: "org-b",
      role: "member",
    });
    expect(query.where).toHaveBeenCalledOnce();
    expect(query.orderBy).not.toHaveBeenCalled();
  });

  it("loads the deterministic oldest membership and activates its organization", async () => {
    getSessionMock.mockResolvedValue(sessionWith(null));
    const query = mockMembershipQuery({ organizationId: "org-oldest", role: "member" });

    await expect(getSessionContext(HEADERS)).resolves.toMatchObject({
      orgId: "org-oldest",
      role: "member",
    });
    expect(query.orderBy).toHaveBeenCalledOnce();
    expect(setActiveOrganizationMock).toHaveBeenCalledWith({
      headers: HEADERS,
      body: { organizationId: "org-oldest" },
    });
  });

  it("denies a stale active organization with no matching membership", async () => {
    getSessionMock.mockResolvedValue(sessionWith("org-gone"));
    mockMembershipQuery(null);

    await expect(getSessionContext(HEADERS)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
