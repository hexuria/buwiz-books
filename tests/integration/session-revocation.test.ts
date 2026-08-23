import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { member, organization, session, user } from "../../src/db/schema/auth";
import { resolveSessionOrganization } from "../../src/lib/session-organization-policy";
import { revokeUserSessions } from "../../src/lib/session-revocation";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Session revocation, end to end at the database layer.
 *
 * The middleware's per-request path is: read the auth_members row for
 * (user, active org), then resolve. These tests drive exactly that pair of
 * steps against real rows, pinning the two behaviors the audit found missing:
 * removal forbids the NEXT request, and demotion changes the effective role
 * on the NEXT request — neither waits out the 24h cookie cache. Plus the
 * belt-and-braces: revokeUserSessions kills all of one user's sessions and
 * nobody else's.
 */
describeDb("session revocation", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  /** The exact lookup getSessionContext performs for an active organization. */
  async function nextRequestResolution(userId: string, orgId: string) {
    const [row] = await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
      .limit(1);
    return resolveSessionOrganization({
      activeOrganizationId: orgId,
      membership: { state: "loaded", membership: row ?? null },
    });
  }

  async function seedUserInOrg(role: string) {
    const userId = randomUUID();
    const orgId = `sess-rev-${randomUUID()}`;
    await db.insert(user).values({
      id: userId,
      name: "Session User",
      email: `${userId}@t.local`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Session Org",
      slug: `sess-${randomUUID().slice(0, 8)}`,
    });
    const memberId = randomUUID();
    await db.insert(member).values({ id: memberId, userId, organizationId: orgId, role });
    return { userId, orgId, memberId };
  }

  it("a removed member is forbidden on the very next request", async () => {
    const { userId, orgId, memberId } = await seedUserInOrg("admin");
    expect(await nextRequestResolution(userId, orgId)).toMatchObject({
      kind: "resolved",
      role: "admin",
    });

    await db.delete(member).where(eq(member.id, memberId));

    expect(await nextRequestResolution(userId, orgId)).toEqual({ kind: "forbidden" });
  });

  it("a demotion is effective on the very next request, not after cache expiry", async () => {
    const { userId, orgId, memberId } = await seedUserInOrg("admin");

    await db.update(member).set({ role: "member" }).where(eq(member.id, memberId));

    // Whatever the session cookie still claims, the resolved role is the row's.
    expect(await nextRequestResolution(userId, orgId)).toMatchObject({
      kind: "resolved",
      role: "member",
    });
  });

  it("revokeUserSessions deletes every session of the target and nobody else's", async () => {
    const target = await seedUserInOrg("member");
    const bystander = await seedUserInOrg("member");

    for (const owner of [target, bystander]) {
      for (let i = 0; i < 2; i++) {
        await db.insert(session).values({
          id: randomUUID(),
          userId: owner.userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        });
      }
    }

    const revoked = await revokeUserSessions(db, target.userId);
    expect(revoked).toBe(2);

    const targetLeft = await db.select().from(session).where(eq(session.userId, target.userId));
    const bystanderLeft = await db
      .select()
      .from(session)
      .where(eq(session.userId, bystander.userId));
    expect(targetLeft.length).toBe(0);
    expect(bystanderLeft.length).toBe(2);
  });
});
