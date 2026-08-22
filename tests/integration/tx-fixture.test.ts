/**
 * The fixtures themselves.
 *
 * The important claim in `tx-fixture.ts` is that a rollback-per-test harness
 * CANNOT observe a `DEFERRABLE INITIALLY DEFERRED` constraint, because that
 * constraint fires at COMMIT and a rolled-back transaction never commits. If
 * that claim were wrong, `withCommittedScope` would be pointless complexity —
 * and if it were silently true but untested, every future balance test written
 * against `withRollback` would pass while asserting nothing.
 *
 * So it is asserted directly, both ways.
 */
import { describe, it, expect } from "vitest";
import { withRollback, withCommittedScope } from "../utils/tx-fixture";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

async function seedOrg(sql: any, orgId: string) {
  await sql`INSERT INTO auth_organizations (id, name, slug)
            VALUES (${orgId}, 'Fixture Org', ${`fixture-${orgId.slice(0, 8)}`})`;
  const [account] = await sql`
    INSERT INTO accounts (organization_id, account_number, name, account_type, is_active)
    VALUES (${orgId}, '9000', 'Fixture Account', 'expense', true) RETURNING id`;
  return account.id as string;
}

describeDb("tx-fixture", () => {
  describe("withRollback", () => {
    it("returns the callback's value", async () => {
      const value = await withRollback(async () => 42);
      expect(value).toBe(42);
    });

    it("leaves nothing behind", async () => {
      const orgId = crypto.randomUUID();
      await withRollback(async (sql) => {
        await seedOrg(sql, orgId);
        const [row] =
          await sql`SELECT count(*)::int AS n FROM auth_organizations WHERE id = ${orgId}`;
        // Visible inside the transaction...
        expect(row.n).toBe(1);
      });

      await withCommittedScope(async ({ sql }) => {
        const [row] =
          await sql`SELECT count(*)::int AS n FROM auth_organizations WHERE id = ${orgId}`;
        // ...and gone once it rolls back.
        expect(row.n).toBe(0);
      });
    });

    it("propagates a real error rather than swallowing it with the sentinel", async () => {
      await expect(
        withRollback(async () => {
          throw new Error("the actual failure");
        }),
      ).rejects.toThrow("the actual failure");
    });

    it("CANNOT observe the deferred balance constraint — this is the trap", async () => {
      // An unbalanced posted journal. Under a rollback fixture this write
      // succeeds silently: the constraint is deferred to COMMIT, and COMMIT
      // never happens. A balance test written against withRollback would pass
      // while proving nothing at all.
      const orgId = crypto.randomUUID();
      await withRollback(async (sql) => {
        const accountId = await seedOrg(sql, orgId);
        const [header] = await sql`
          INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
          VALUES (${orgId}, '2026-08-01', 'journal', 'manual', 'posted') RETURNING id`;
        await sql`INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
                  VALUES (${header.id}, ${accountId}, 100, 0)`;
        await sql`INSERT INTO journal_lines (journal_header_id, account_id, credit, sort_order)
                  VALUES (${header.id}, ${accountId}, 60, 1)`;
        // No error. 100 != 60, and the write went through.
        const [row] = await sql`
          SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines
          WHERE journal_header_id = ${header.id}`;
        expect(Number(row.d)).toBe(100);
        expect(Number(row.c)).toBe(60);
      });
    });
  });

  describe("withCommittedScope", () => {
    it("DOES observe the deferred balance constraint", async () => {
      // The same write, committed. The constraint fires and rejects it — which
      // is why this fixture exists.
      const orgId = crypto.randomUUID();
      await withCommittedScope(async ({ sql, track }) => {
        track(orgId);
        const accountId = await seedOrg(sql, orgId);
        await expect(
          sql.begin(async (tx) => {
            const [header] = await tx`
              INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
              VALUES (${orgId}, '2026-08-01', 'journal', 'manual', 'posted') RETURNING id`;
            await tx`INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
                     VALUES (${header.id}, ${accountId}, 100, 0)`;
            await tx`INSERT INTO journal_lines (journal_header_id, account_id, credit, sort_order)
                     VALUES (${header.id}, ${accountId}, 60, 1)`;
          }),
        ).rejects.toThrow(/does not balance|cannot be posted/);
      });
    });

    it("cleans up tracked organizations, including amendment lineage", async () => {
      // Lineage pointers are ON DELETE RESTRICT, so cleanup must clear them
      // before deleting the headers or teardown fails and leaks rows.
      const orgId = crypto.randomUUID();
      await withCommittedScope(async ({ sql, track }) => {
        track(orgId);
        const accountId = await seedOrg(sql, orgId);
        const original = await sql.begin(async (tx) => {
          const [h] = await tx`
            INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
            VALUES (${orgId}, '2026-08-02', 'journal', 'manual', 'posted') RETURNING id`;
          await tx`INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
                   VALUES (${h.id}, ${accountId}, 10, 0)`;
          await tx`INSERT INTO journal_lines (journal_header_id, account_id, credit, sort_order)
                   VALUES (${h.id}, ${accountId}, 10, 1)`;
          return h.id as string;
        });
        await sql`
          INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status, reverses_header_id)
          VALUES (${orgId}, '2026-08-03', 'journal', 'manual', 'posted', ${original})`;
      });

      // Teardown ran; nothing left.
      await withCommittedScope(async ({ sql }) => {
        const [row] = await sql`
          SELECT count(*)::int AS n FROM journal_headers WHERE organization_id = ${orgId}`;
        expect(row.n).toBe(0);
      });
    });

    it("cleans up even when the test body throws", async () => {
      const orgId = crypto.randomUUID();
      await expect(
        withCommittedScope(async ({ sql, track }) => {
          track(orgId);
          await seedOrg(sql, orgId);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      await withCommittedScope(async ({ sql }) => {
        const [row] =
          await sql`SELECT count(*)::int AS n FROM auth_organizations WHERE id = ${orgId}`;
        expect(row.n).toBe(0);
      });
    });
  });
});
