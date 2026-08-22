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
