import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * A CHARACTERISATION test for the tenant boundary. It pins what the RLS
 * policies do today, including the part that is deliberately open.
 *
 * Every policy is written
 *   USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
 * so an unset organization makes the predicate true for every row. Two request
 * wrappers rely on that: withSessionUserContext and withMutationSessionUserContext
 * run through `withUserContext`, which sets ONLY app.current_user_id and never
 * app.current_organization_id, because their whole purpose is reading across
 * organizations (Enterprise Business Group portfolios).
 *
 * That makes those two wrappers the one request path with no database-level
 * tenant isolation: correctness there rests entirely on the predicates each
 * query writes by hand. Nothing else asserted that property, so this file does.
 *
 * It is written to FAIL LOUDLY when the planned hardening lands — a dedicated
 * BYPASSRLS admin role with the `IS NULL` clause dropped. At that point the
 * second test flips from "sees every organization" to "sees none", silently, for
 * every caller of those two wrappers. The failure here is the signal to go and
 * give them an explicit organization scope.
 */
describeDb("tenant isolation contract", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG_A = crypto.randomUUID();
  const ORG_B = crypto.randomUUID();
  const USER = crypto.randomUUID();
  const ids: string[] = [];

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    for (const [org, name] of [
      [ORG_A, "A Checking"],
      [ORG_B, "B Checking"],
    ] as const) {
      const [row] = await db
        .insert(accounts)
        .values({
          organizationId: org,
          name,
          accountNumber: `1100-${crypto.randomUUID().slice(0, 4)}`,
          accountType: "asset" as const,
          subtype: "bank_accounts" as const,
        })
        .returning({ id: accounts.id });
      ids.push(row.id);
    }
  });

  afterAll(async () => {
    if (ids.length) await db.delete(accounts).where(inArray(accounts.id, ids));
    await sql.end();
  });

  /** Mirrors withOrgContext: role + all three session variables. */
  async function asOrg<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${USER}, true)`);
      return fn(tx);
    });
  }

  /** Mirrors withUserContext: role + user id ONLY, no organization. */
  async function asUser<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${USER}, true)`);
      return fn(tx);
    });
  }

  const visible = (tx: any) =>
    tx
      .select({ id: accounts.id, organizationId: accounts.organizationId })
      .from(accounts)
      .where(inArray(accounts.id, ids));

  it("scopes reads to one organization when an organization is set", async () => {
    const rows = (await asOrg(ORG_A, visible)) as Array<{ organizationId: string }>;
    expect(rows.map((r: any) => r.organizationId)).toEqual([ORG_A]);
  });

  it("hides another organization's row even when addressed by id", async () => {
    const rows = await asOrg(ORG_A, (tx: any) =>
      tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, ids[1]), eq(accounts.organizationId, ORG_B))),
    );
    expect(rows).toHaveLength(0);
  });

  it("leaves the organization unset under user context", async () => {
    const [row] = (await asUser((tx: any) =>
      tx.execute(drizzleSql`SELECT current_organization_id() IS NULL AS unset`),
    )) as Array<{ unset: boolean }>;
    expect(row.unset).toBe(true);
  });

  it("sees EVERY organization under user context — the deliberate escape hatch", async () => {
    // Not a bug: withSessionUserContext exists to read across organizations.
    // The point of pinning it is that the database enforces nothing here, so
    // every query inside those wrappers must scope itself, and the planned
    // BYPASSRLS hardening will invert this result rather than error.
    const rows = (await asUser(visible)) as Array<{ organizationId: string }>;
    expect(rows.map((r: any) => r.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
  });
});

describeDb("credential and identity table policies", () => {
  // The 2026-08 audit found these five org/user-scoped tables with NO policy
  // at all — organization_secrets and financial_account_secrets holding
  // encrypted credentials, and auth_members being the table the tenant
  // boundary itself is derived from. The policies keep the permissive
  // IS NULL escape (nothing changes until the role hardening); what this
  // test pins is that the RATCHET exists and scopes correctly under an org
  // or user context.
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  it("every previously-unpoliced table now has RLS enabled with a policy", async () => {
    const rows = (await db.execute(drizzleSql`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_enabled,
             count(p.polname)::int AS policies
      FROM pg_class c
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
      WHERE c.relname IN (
        'organization_secrets', 'financial_account_secrets',
        'auth_members', 'auth_sessions', 'auth_invitations'
      )
      GROUP BY c.relname, c.relrowsecurity
    `)) as Array<{ table_name: string; rls_enabled: boolean; policies: number }>;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.rls_enabled, row.table_name).toBe(true);
      expect(row.policies, row.table_name).toBeGreaterThanOrEqual(1);
    }
  });

  it("org context scopes organization_secrets; user context scopes auth_sessions", async () => {
    const ORG_A = crypto.randomUUID();
    const ORG_B = crypto.randomUUID();
    const USER_A = `secrets-user-a-${crypto.randomUUID()}`;
    const USER_B = `secrets-user-b-${crypto.randomUUID()}`;

    await db.execute(drizzleSql`
      INSERT INTO auth_users (id, name, email, email_verified)
      VALUES (${USER_A}, 'A', ${USER_A + "@t.local"}, true),
             (${USER_B}, 'B', ${USER_B + "@t.local"}, true)
    `);
    await db.execute(drizzleSql`
      INSERT INTO auth_organizations (id, name, slug)
      VALUES (${ORG_A}, 'Secrets A', ${"sa-" + ORG_A.slice(0, 8)}),
             (${ORG_B}, 'Secrets B', ${"sb-" + ORG_B.slice(0, 8)})
    `);
    await db.execute(drizzleSql`
      INSERT INTO organization_secrets (organization_id, resend_api_key)
      VALUES (${ORG_A}, 'enc-a'), (${ORG_B}, 'enc-b')
    `);
    await db.execute(drizzleSql`
      INSERT INTO auth_sessions (id, token, user_id, expires_at)
      VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${USER_A}, now() + interval '1 day'),
             (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${USER_B}, now() + interval '1 day')
    `);

    // Under ORG_A's context, only ORG_A's secret is visible.
    const orgScoped = await db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`,
      );
      return (await tx.execute(
        drizzleSql`SELECT organization_id FROM organization_secrets WHERE organization_id IN (${ORG_A}, ${ORG_B})`,
      )) as Array<{ organization_id: string }>;
    });
    expect(orgScoped.map((r: any) => r.organization_id)).toEqual([ORG_A]);

    // Under USER_A's context, only USER_A's session is visible.
    const userScoped = await db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${USER_A}, true)`);
      return (await tx.execute(
        drizzleSql`SELECT user_id FROM auth_sessions WHERE user_id IN (${USER_A}, ${USER_B})`,
      )) as Array<{ user_id: string }>;
    });
    expect(userScoped.map((r: any) => r.user_id)).toEqual([USER_A]);
  });

  it("a member row is visible to its own user AND inside its organization", async () => {
    const ORG = crypto.randomUUID();
    const OWNER = `member-owner-${crypto.randomUUID()}`;
    const OTHER = `member-other-${crypto.randomUUID()}`;
    await db.execute(drizzleSql`
      INSERT INTO auth_users (id, name, email, email_verified)
      VALUES (${OWNER}, 'O', ${OWNER + "@t.local"}, true)
    `);
    await db.execute(drizzleSql`
      INSERT INTO auth_organizations (id, name, slug)
      VALUES (${ORG}, 'Member Org', ${"mo-" + ORG.slice(0, 8)})
    `);
    await db.execute(drizzleSql`
      INSERT INTO auth_members (id, user_id, organization_id, role)
      VALUES (${crypto.randomUUID()}, ${OWNER}, ${ORG}, 'owner')
    `);

    // The user sees their own membership with NO org context — the org
    // picker depends on exactly this.
    const own = await db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${OWNER}, true)`);
      return (await tx.execute(
        drizzleSql`SELECT user_id FROM auth_members WHERE organization_id = ${ORG}`,
      )) as Array<{ user_id: string }>;
    });
    expect(own).toHaveLength(1);

    // A DIFFERENT user with a DIFFERENT org context sees nothing.
    const foreign = await db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${OTHER}, true)`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${crypto.randomUUID()}, true)`,
      );
      return (await tx.execute(
        drizzleSql`SELECT user_id FROM auth_members WHERE organization_id = ${ORG}`,
      )) as Array<{ user_id: string }>;
    });
    expect(foreign).toHaveLength(0);
  });
});
