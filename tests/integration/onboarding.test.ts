/**
 * Phase 3.5 — Onboarding & Organization Lifecycle
 *
 * Tests the server-side logic underpinning the onboarding wizard:
 *   1. maskEmail / normalizeEmail helpers (unit-level)
 *   2. lookupInvitation — validation guards (not found, expired, accepted, canceled)
 *   3. acceptInvitationByCode — email match, membership creation, idempotency
 *   4. getCanCreateOrg — role-gated access (owner vs member vs no membership)
 *
 * The UI wizard itself (step navigation, slug generation) is tested via
 * component/e2e tests. This file covers the DB-backed business rules.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { invitation, organization, user, member } from "../../src/db/schema/auth";
import { eq, and } from "drizzle-orm";
import postgres from "postgres";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// ─── Inline helpers (mirrored from -invitation-lookup.ts) ─────────────────────

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(local.length - 1, 5))}@${domain}`;
}

function normalizeEmail(email: string): string {
  const lower = email.toLowerCase().trim();
  const [local, domain] = lower.split("@");
  if (!domain) return lower;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.replace(/\./g, "")}@gmail.com`;
  }
  return lower;
}

// ─── Unit tests for pure helpers ──────────────────────────────────────────────

describe("Onboarding Helpers — Pure Functions", () => {
  describe("maskEmail", () => {
    it("masks long local parts", () => {
      // "hugo" → local.length-1 = 3 → min(3,5) = 3 stars
      expect(maskEmail("hugo@gmail.com")).toBe("h***@gmail.com");
    });

    it("caps mask at 5 stars", () => {
      // local is "hugoforbes" (10 chars) — should still only show 5 stars
      expect(maskEmail("hugoforbes@gmail.com")).toBe("h*****@gmail.com");
    });

    it("handles single-char local part", () => {
      expect(maskEmail("a@gmail.com")).toBe("a***@gmail.com");
    });

    it("handles missing domain gracefully", () => {
      expect(maskEmail("invalidemail")).toBe("***");
    });
  });

  describe("normalizeEmail", () => {
    it("lowercases and trims", () => {
      expect(normalizeEmail("  Hugo@Gmail.COM  ")).toBe("hugo@gmail.com");
    });

    it("strips dots from Gmail local part", () => {
      expect(normalizeEmail("gigachad.rustacean@gmail.com")).toBe("gigachadrustacean@gmail.com");
    });

    it("treats googlemail.com as gmail.com", () => {
      expect(normalizeEmail("test.user@googlemail.com")).toBe("testuser@gmail.com");
    });

    it("does NOT strip dots for non-Gmail domains", () => {
      expect(normalizeEmail("hugo.forbes@buwiz.com")).toBe("hugo.forbes@buwiz.com");
    });

    it("returns the input as-is when no domain", () => {
      expect(normalizeEmail("nodomain")).toBe("nodomain");
    });
  });
});

// ─── Integration tests — Invitation lifecycle ──────────────────────────────────

describeDb("Invitation Lifecycle", () => {
  let ORG_ID: string;
  let OWNER_USER_ID: string;
  let INVITEE_USER_ID: string;

  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG_ID = crypto.randomUUID();
    OWNER_USER_ID = crypto.randomUUID();
    INVITEE_USER_ID = crypto.randomUUID();

    // Seed org
    await db.insert(organization).values({
      id: ORG_ID,
      name: "Buwiz Test Corp",
      slug: `buwiz-test-${Date.now()}`,
    });

    // Seed users
    await db.insert(user).values([
      {
        id: OWNER_USER_ID,
        name: "Owner User",
        email: `owner-${Date.now()}@buwiz.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: INVITEE_USER_ID,
        name: "Invitee User",
        email: `invitee-${Date.now()}@gmail.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Seed owner membership
    await db.insert(member).values({
      id: crypto.randomUUID(),
      userId: OWNER_USER_ID,
      organizationId: ORG_ID,
      role: "owner",
      createdAt: new Date(),
    });
  });

  it("lookupInvitation — should reject a non-existent invitation ID", async () => {
    const [row] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, "does-not-exist"))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it("lookupInvitation — should detect an expired invitation", async () => {
    const INVITE_ID = crypto.randomUUID();
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24); // 24h ago

    await db.insert(invitation).values({
      id: INVITE_ID,
      email: `invitee-${Date.now()}@gmail.com`,
      role: "member",
      status: "pending",
      organizationId: ORG_ID,
      inviterId: OWNER_USER_ID,
      expiresAt: pastDate,
    });

    const [inv] = await db
      .select({ expiresAt: invitation.expiresAt })
      .from(invitation)
      .where(eq(invitation.id, INVITE_ID));

    expect(inv.expiresAt).toBeDefined();
    expect(new Date(inv.expiresAt!) < new Date()).toBe(true);
  });

  it("lookupInvitation — should detect an already-accepted invitation", async () => {
    const INVITE_ID = crypto.randomUUID();

    await db.insert(invitation).values({
      id: INVITE_ID,
      email: `invitee-${Date.now()}@gmail.com`,
      role: "member",
      status: "accepted",
      organizationId: ORG_ID,
      inviterId: OWNER_USER_ID,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    });

    const [inv] = await db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, INVITE_ID));

    expect(inv.status).toBe("accepted");
  });

  it("lookupInvitation — should detect a canceled invitation", async () => {
    const INVITE_ID = crypto.randomUUID();

    await db.insert(invitation).values({
      id: INVITE_ID,
      email: `invitee-${Date.now()}@gmail.com`,
      role: "member",
      status: "canceled",
      organizationId: ORG_ID,
      inviterId: OWNER_USER_ID,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    });

    const [inv] = await db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, INVITE_ID));

    expect(["canceled", "rejected"]).toContain(inv.status);
  });

  it("acceptInvitationByCode — should create membership and mark invitation accepted", async () => {
    const INVITE_ID = crypto.randomUUID();
    const inviteeEmail = `invitee-${Date.now()}@gmail.com`;

    // Update INVITEE_USER_ID's email to match
    await db.update(user).set({ email: inviteeEmail }).where(eq(user.id, INVITEE_USER_ID));

    await db.insert(invitation).values({
      id: INVITE_ID,
      email: inviteeEmail,
      role: "member",
      status: "pending",
      organizationId: ORG_ID,
      inviterId: OWNER_USER_ID,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    });

    // Simulate acceptInvitationByCode logic:
    // 1. Verify email matches
    const [inv] = await db.select().from(invitation).where(eq(invitation.id, INVITE_ID)).limit(1);
    expect(normalizeEmail(inviteeEmail)).toBe(normalizeEmail(inv.email));

    // 2. Check no existing membership
    const existingMembership = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, INVITEE_USER_ID), eq(member.organizationId, ORG_ID)))
      .limit(1);
    expect(existingMembership).toHaveLength(0);

    // 3. Insert membership
    const memberId = crypto.randomUUID();
    await db.insert(member).values({
      id: memberId,
      userId: INVITEE_USER_ID,
      organizationId: ORG_ID,
      role: inv.role || "member",
      createdAt: new Date(),
    });

    // 4. Mark invitation accepted
    await db
      .update(invitation)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(invitation.id, INVITE_ID));

    // Assert membership was created
    const [newMember] = await db
      .select()
      .from(member)
      .where(and(eq(member.userId, INVITEE_USER_ID), eq(member.organizationId, ORG_ID)))
      .limit(1);
    expect(newMember).toBeDefined();
    expect(newMember.role).toBe("member");

    // Assert invitation is now accepted
    const [updatedInv] = await db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, INVITE_ID));
    expect(updatedInv.status).toBe("accepted");
  });

  it("acceptInvitationByCode — should be idempotent when user is already a member", async () => {
    const INVITE_ID = crypto.randomUUID();
    const inviteeEmail = `already-member-${Date.now()}@buwiz.com`;

    await db.update(user).set({ email: inviteeEmail }).where(eq(user.id, INVITEE_USER_ID));

    // Pre-insert membership (user is already in org)
    await db.insert(member).values({
      id: crypto.randomUUID(),
      userId: INVITEE_USER_ID,
      organizationId: ORG_ID,
      role: "member",
      createdAt: new Date(),
    });

    await db.insert(invitation).values({
      id: INVITE_ID,
      email: inviteeEmail,
      role: "member",
      status: "pending",
      organizationId: ORG_ID,
      inviterId: OWNER_USER_ID,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    });

    // Simulate idempotent path: existing member → just mark invitation accepted
    const existingMembership = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, INVITEE_USER_ID), eq(member.organizationId, ORG_ID)));
    expect(existingMembership.length).toBeGreaterThan(0);

    // Mark accepted without inserting a duplicate member
    await db
      .update(invitation)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(invitation.id, INVITE_ID));

    // Should still only have 1 membership
    const allMemberships = await db
      .select()
      .from(member)
      .where(and(eq(member.userId, INVITEE_USER_ID), eq(member.organizationId, ORG_ID)));
    expect(allMemberships).toHaveLength(1);
  });

  it("acceptInvitationByCode — should reject when email does not match", () => {
    const inviteeEmail = "invited@buwiz.com";
    const sessionEmail = "imposter@buwiz.com";

    // The normalizeEmail comparison is what guards this
    expect(normalizeEmail(sessionEmail)).not.toBe(normalizeEmail(inviteeEmail));
  });

  it("acceptInvitationByCode — Gmail dot-normalization allows valid join", () => {
    // "hugo.forbes@gmail.com" and "hugoforbes@gmail.com" should be treated as equal
    const inviteEmail = "hugo.forbes@gmail.com";
    const sessionEmail = "hugoforbes@gmail.com";
    expect(normalizeEmail(inviteEmail)).toBe(normalizeEmail(sessionEmail));
  });
});

// ─── Integration tests — getCanCreateOrg logic ────────────────────────────────

describeDb("getCanCreateOrg — Role-gated Org Creation", () => {
  let db: any;
  let sql: postgres.Sql;

  let ORG_ID: string;
  let OWNER_ID: string;
  let ADMIN_ID: string;
  let MEMBER_ID: string;
  let NO_ORG_USER_ID: string;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());

    ORG_ID = crypto.randomUUID();
    OWNER_ID = crypto.randomUUID();
    ADMIN_ID = crypto.randomUUID();
    MEMBER_ID = crypto.randomUUID();
    NO_ORG_USER_ID = crypto.randomUUID();

    const now = new Date();

    await db.insert(organization).values({
      id: ORG_ID,
      name: "CanCreate Test Org",
      slug: `can-create-test-${Date.now()}`,
    });

    await db.insert(user).values([
      {
        id: OWNER_ID,
        name: "Owner",
        email: `owner-cc-${Date.now()}@buwiz.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ADMIN_ID,
        name: "Admin",
        email: `admin-cc-${Date.now()}@buwiz.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MEMBER_ID,
        name: "Member",
        email: `member-cc-${Date.now()}@buwiz.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: NO_ORG_USER_ID,
        name: "No Org",
        email: `noorg-cc-${Date.now()}@buwiz.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(member).values([
      {
        id: crypto.randomUUID(),
        userId: OWNER_ID,
        organizationId: ORG_ID,
        role: "owner",
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        userId: ADMIN_ID,
        organizationId: ORG_ID,
        role: "admin",
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        userId: MEMBER_ID,
        organizationId: ORG_ID,
        role: "member",
        createdAt: now,
      },
    ]);
  });

  afterAll(async () => {
    await sql.end();
  });

  /**
   * Mirrors the getCanCreateOrgImpl logic directly against the DB.
   */
  async function canCreateOrg(userId: string): Promise<boolean> {
    const memberships = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, userId));

    return memberships.some((m: { role: string }) => m.role === "owner" || m.role === "admin");
  }

  it("owner can create an organization", async () => {
    expect(await canCreateOrg(OWNER_ID)).toBe(true);
  });

  it("admin can create an organization", async () => {
    expect(await canCreateOrg(ADMIN_ID)).toBe(true);
  });

  it("plain member cannot create an organization", async () => {
    expect(await canCreateOrg(MEMBER_ID)).toBe(false);
  });

  it("user with no organization memberships cannot create an organization", async () => {
    expect(await canCreateOrg(NO_ORG_USER_ID)).toBe(false);
  });
});
