import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Pins the bill-void semantic against the defect it carried.
 *
 * Reports and the reporting projection aggregate `status = 'posted'` rows only,
 * so flipping a source journal to "voided" already removes its effect. The bill
 * path ALSO posted a full mirrored reversal, subtracting the same amount a
 * second time — so every voided bill understated its period by the bill's
 * value. The invoice path fixed exactly this, and its own comment calls the
 * reversal "the historical bug".
 *
 * These assert the OUTCOME at the ledger level rather than driving the server
 * function, so the property survives a refactor of the route.
 */
describeDb("bill void — ledger semantics", () => {
  let db: any;
  let sql: postgres.Sql;
  let ORG: string;
  let accountId: string;

  beforeAll(async () => {
    const conn = await createTestDb();
    db = conn.db;
    sql = conn.sql;
    ORG = `org_void_${crypto.randomUUID().slice(0, 8)}`;
    const rows = await sql`SELECT id FROM accounts LIMIT 1`;
    accountId = rows[0].id as string;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function postedHeaderCount(extra?: { source?: string }): Promise<number> {
    const rows = extra?.source
      ? await sql`SELECT count(*)::int AS n FROM journal_headers
                  WHERE organization_id = ${ORG} AND status = 'posted' AND source = ${extra.source}`
      : await sql`SELECT count(*)::int AS n FROM journal_headers
                  WHERE organization_id = ${ORG} AND status = 'posted'`;
    return rows[0].n as number;
  }

  async function postAccrual(amount: string): Promise<string> {
    const header = await db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionDate: "2026-03-15",
          transactionType: "pay_out",
          source: "bill",
          status: "posted",
          sourceDocumentType: "bill",
          totalAmount: amount,
        })
        .returning();
      // A minimal balanced accrual: Dr expense, Cr A/P.
      await tx.insert(journalLines).values([
        { journalHeaderId: created.id, accountId, debit: amount, sortOrder: 0 },
        { journalHeaderId: created.id, accountId, credit: amount, sortOrder: 1 },
      ]);
      return created;
    });
    return header.id;
  }

  it("removes a voided bill's effect exactly once", async () => {
    const headerId = await postAccrual("5000");
    expect(await postedHeaderCount()).toBe(1);

    // Void the way the fixed path does: flip to voided, post NOTHING.
    await db
      .update(journalHeaders)
      .set({ status: "voided" })
      .where(eq(journalHeaders.id, headerId));

    expect(await postedHeaderCount()).toBe(0);
  });

  it("shows why the reversal was a double removal", async () => {
    // Reconstructs the old behaviour to make the defect concrete: voiding the
    // original AND posting a mirrored reversal leaves a posted reversal
    // subtracting an amount the void had already removed.
    const headerId = await postAccrual("7000");
    await db
      .update(journalHeaders)
      .set({ status: "voided" })
      .where(eq(journalHeaders.id, headerId));

    const reversal = await db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionDate: "2026-04-01",
          transactionType: "pay_out",
          source: "system",
          status: "posted",
          sourceDocumentType: "bill",
          memo: "REVERSAL (old behaviour)",
          totalAmount: "7000",
        })
        .returning();
      await tx.insert(journalLines).values([
        { journalHeaderId: created.id, accountId, credit: "7000", sortOrder: 0 },
        { journalHeaderId: created.id, accountId, debit: "7000", sortOrder: 1 },
      ]);
      return created;
    });

    // The original is gone from reports AND a reversal still sits in them —
    // the bill's effect counted against the books twice.
    expect(await postedHeaderCount({ source: "system" })).toBe(1);

    // Clean up by VOIDING, not deleting: a posted journal's lines can no
    // longer be removed (0039), which is the point. Voiding takes it out of
    // every posted aggregate, which is all this cleanup needed.
    await db
      .update(journalHeaders)
      .set({ status: "voided" })
      .where(eq(journalHeaders.id, reversal.id));
    expect(await postedHeaderCount({ source: "system" })).toBe(0);
  });

  it("keeps the void source-of-truth on the header, not on a compensating entry", async () => {
    // The property the fix rests on: a voided header carries no posted lines
    // into any report, so no compensating entry is needed or correct.
    const headerId = await postAccrual("1234.56");
    await db
      .update(journalHeaders)
      .set({ status: "voided" })
      .where(eq(journalHeaders.id, headerId));

    const rows = await sql`
      SELECT count(*)::int AS n
      FROM journal_lines jl
      JOIN journal_headers jh ON jh.id = jl.journal_header_id
      WHERE jh.id = ${headerId} AND jh.status = 'posted'`;
    expect(rows[0].n).toBe(0);
  });

  it("no longer writes a REVERSAL header on the bill-void path", async () => {
    // A source-level guard: the route must not reintroduce the compensating
    // entry. Asserted against the file because the semantic lives there.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(import.meta.dirname, "../../src/routes/api/-bills.ts"),
      "utf8",
    );
    const start = source.indexOf('if (newStatus === "voided")');
    expect(start, "the void branch was not found").toBeGreaterThan(-1);
    // Search forward FROM the block start — searching from 0 finds an earlier
    // occurrence and yields an empty slice that vacuously passes.
    const voidBlock = source.slice(start, source.indexOf('entityType: "bill"', start));
    expect(voidBlock.length).toBeGreaterThan(100);
    expect(voidBlock).not.toContain("REVERSAL:");
    // And it must respect the period lock the sibling paths already check.
    expect(voidBlock).toContain("isDateLocked");
  });

  describe("the posted-journal balance constraint", () => {
    it("refuses a posted journal that does not balance", async () => {
      // No such guarantee existed anywhere in drizzle/. Balance was checked in
      // application code only, on only some paths — both bill-accrual
      // implementations post without calling it at all.
      await expect(
        sql.begin(async (tx) => {
          const [header] = await tx`
            INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
            VALUES (${ORG}, '2026-05-01', 'journal', 'manual', 'posted') RETURNING id`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
            VALUES (${header.id}, ${accountId}, 100, 0)`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, credit, sort_order)
            VALUES (${header.id}, ${accountId}, 60, 1)`;
        }),
      ).rejects.toThrow(/does not balance|cannot be posted/);
    });

    it("catches a sub-centavo imbalance the float check lets through", async () => {
      // validateBalance compares floats rounded to 2dp against a ledger stored
      // at decimal(20,8), so a difference of 0.00000001 passes it. The database
      // compares at full scale.
      await expect(
        sql.begin(async (tx) => {
          const [header] = await tx`
            INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
            VALUES (${ORG}, '2026-05-02', 'journal', 'manual', 'posted') RETURNING id`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
            VALUES (${header.id}, ${accountId}, 100, 0)`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, credit, sort_order)
            VALUES (${header.id}, ${accountId}, 99.99999999, 1)`;
        }),
      ).rejects.toThrow(/0\.00000001/);
    });

    it("accepts a balanced posted journal", async () => {
      await expect(
        sql.begin(async (tx) => {
          const [header] = await tx`
            INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
            VALUES (${ORG}, '2026-05-03', 'journal', 'manual', 'posted') RETURNING id`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
            VALUES (${header.id}, ${accountId}, 100, 0)`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, credit, sort_order)
            VALUES (${header.id}, ${accountId}, 100, 1)`;
          return header.id as string;
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("lets a DRAFT be unbalanced while it is being built", async () => {
      // Deferring to COMMIT is not enough on its own — a draft is legitimately
      // unbalanced for as long as it stays a draft.
      await expect(
        sql.begin(async (tx) => {
          const [header] = await tx`
            INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
            VALUES (${ORG}, '2026-05-04', 'journal', 'manual', 'draft') RETURNING id`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
            VALUES (${header.id}, ${accountId}, 100, 0)`;
          return header.id as string;
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("catches a header promoted to posted with unbalanced lines", async () => {
      // The other direction: lines written first, header flipped later.
      await expect(
        sql.begin(async (tx) => {
          const [header] = await tx`
            INSERT INTO journal_headers (organization_id, transaction_date, transaction_type, source, status)
            VALUES (${ORG}, '2026-05-05', 'journal', 'manual', 'draft') RETURNING id`;
          await tx`
            INSERT INTO journal_lines (journal_header_id, account_id, debit, sort_order)
            VALUES (${header.id}, ${accountId}, 100, 0)`;
          await tx`UPDATE journal_headers SET status = 'posted' WHERE id = ${header.id}`;
        }),
      ).rejects.toThrow(/cannot be posted|does not balance/);
    });
  });
});
