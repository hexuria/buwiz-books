/**
 * Amend-by-reversal for posted journals.
 *
 * A posted journal was freely editable in place: the transaction mutation path
 * deleted every line and reinserted replacements with no `status = 'posted'`
 * check, and the batch path bulk-repointed `account_id`. Either could silently
 * rewrite a tax line after the return it fed had been filed, leaving only an
 * activity-log row.
 *
 * These assert the replacement semantics AND the database guarantees, because
 * the application guard is a friendly message and the triggers are the actual
 * enforcement.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import {
  amendPostedJournal,
  AlreadyAmendedError,
  NotPostedError,
} from "../../src/lib/journal-amendment";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("amend-by-reversal", () => {
  let db: any;
  let sql: postgres.Sql;
  let ORG: string;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    const conn = await createTestDb();
    db = conn.db;
    sql = conn.sql;
    ORG = `org_amend_${crypto.randomUUID().slice(0, 8)}`;
    const rows = await sql`SELECT id FROM accounts LIMIT 2`;
    accountA = rows[0].id as string;
    accountB = rows[1].id as string;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function post(amount: string, status = "posted"): Promise<string> {
    return await db.transaction(async (tx: any) => {
      const [header] = await tx
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionDate: "2026-06-15",
          transactionType: "journal",
          source: "manual",
          status,
          totalAmount: amount,
          functionalCurrency: "PHP",
        })
        .returning();
      await tx.insert(journalLines).values([
        { journalHeaderId: header.id, accountId: accountA, debit: amount, sortOrder: 0 },
        { journalHeaderId: header.id, accountId: accountB, credit: amount, sortOrder: 1 },
      ]);
      return header.id as string;
    });
  }

  it("leaves the original untouched and posts a mirrored reversal", async () => {
    const original = await post("1000");

    const result = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        userId: "test-user",
        headerId: original,
        reason: "Wrong expense account",
        lines: [
          { accountId: accountB, debit: "1000" },
          { accountId: accountA, credit: "1000" },
        ],
      }),
    );

    const [orig] = await db.select().from(journalHeaders).where(eq(journalHeaders.id, original));
    expect(orig.status).toBe("posted");
    expect(orig.totalAmount).toBe("1000.00000000");

    const reversalLines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, result.reversalHeaderId))
      .orderBy(journalLines.sortOrder);
    // Debit and credit exchanged, account-for-account.
    expect(reversalLines[0].accountId).toBe(accountA);
    expect(reversalLines[0].credit).toBe("1000.00000000");
    expect(reversalLines[0].debit).toBeNull();
    expect(reversalLines[1].accountId).toBe(accountB);
    expect(reversalLines[1].debit).toBe("1000.00000000");
  });

  it("nets the original and its reversal to zero without report changes", async () => {
    // The property the whole design rests on: reports aggregate posted rows,
    // and after an amendment the original + reversal contribute nothing, so
    // only the replacement's figures survive.
    const original = await post("750");
    const result = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        userId: "test-user",
        headerId: original,
        reason: "Amount was wrong",
        lines: [
          { accountId: accountA, debit: "900" },
          { accountId: accountB, credit: "900" },
        ],
      }),
    );

    const [net] = await sql`
      SELECT COALESCE(SUM(jl.debit), 0)::numeric AS debits
      FROM journal_lines jl
      JOIN journal_headers jh ON jh.id = jl.journal_header_id
      WHERE jh.status = 'posted'
        AND jl.account_id = ${accountA}
        AND jh.id IN (${original}, ${result.reversalHeaderId})`;
    const [reversalCredit] = await sql`
      SELECT COALESCE(SUM(credit), 0)::numeric AS credits
      FROM journal_lines
      WHERE journal_header_id = ${result.reversalHeaderId} AND account_id = ${accountA}`;
    // 750 debited on the original, 750 credited on the reversal.
    expect(Number(net.debits)).toBe(750);
    expect(Number(reversalCredit.credits)).toBe(750);
  });

  it("reverses without replacing when the entry should not have existed", async () => {
    const original = await post("500");
    const result = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        userId: "test-user",
        headerId: original,
        reason: "Duplicate capture",
      }),
    );
    expect(result.replacementHeaderId).toBeNull();
    expect(result.reversalHeaderId).toEqual(expect.any(String));
  });

  it("records lineage on both new headers", async () => {
    const original = await post("300");
    const result = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        userId: "test-user",
        headerId: original,
        reason: "Reclassify",
        lines: [
          { accountId: accountA, debit: "300" },
          { accountId: accountB, credit: "300" },
        ],
      }),
    );

    const [rev] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.reversalHeaderId));
    const [rep] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, result.replacementHeaderId!));

    expect(rev.reversesHeaderId).toBe(original);
    expect(rev.replacesHeaderId).toBeNull();
    expect(rep.replacesHeaderId).toBe(original);
    expect(rep.reversesHeaderId).toBeNull();
    expect(rep.amendmentReason).toBe("Reclassify");
    // Currency is carried across, not re-defaulted to USD.
    expect(rep.functionalCurrency).toBe("PHP");
  });

  it("refuses a second amendment of the same original", async () => {
    const original = await post("200");
    await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        userId: "test-user",
        headerId: original,
        reason: "First",
      }),
    );
    await expect(
      db.transaction((tx: any) =>
        amendPostedJournal(tx, {
          organizationId: ORG,
          userId: "test-user",
          headerId: original,
          reason: "Second",
        }),
      ),
    ).rejects.toThrow(AlreadyAmendedError);
  });

  it("refuses to amend a draft — edit it directly instead", async () => {
    const draft = await post("100", "draft");
    await expect(
      db.transaction((tx: any) =>
        amendPostedJournal(tx, {
          organizationId: ORG,
          userId: "test-user",
          headerId: draft,
          reason: "nope",
        }),
      ),
    ).rejects.toThrow(NotPostedError);
  });

  it("requires a reason", async () => {
    const original = await post("100");
    await expect(
      db.transaction((tx: any) =>
        amendPostedJournal(tx, {
          organizationId: ORG,
          userId: "test-user",
          headerId: original,
          reason: "   ",
        }),
      ),
    ).rejects.toThrow(/reason is required/);
  });

  it("refuses an unbalanced replacement with a message naming the amendment", async () => {
    const original = await post("100");
    await expect(
      db.transaction((tx: any) =>
        amendPostedJournal(tx, {
          organizationId: ORG,
          userId: "test-user",
          headerId: original,
          reason: "Unbalanced",
          lines: [
            { accountId: accountA, debit: "100" },
            { accountId: accountB, credit: "60" },
          ],
        }),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it("catches a sub-centavo imbalance in the replacement", async () => {
    // Scaled-integer comparison, not rounded floats — the same class of defect
    // the 0038 balance trigger exists to catch.
    const original = await post("100");
    await expect(
      db.transaction((tx: any) =>
        amendPostedJournal(tx, {
          organizationId: ORG,
          userId: "test-user",
          headerId: original,
          reason: "Sub-centavo",
          lines: [
            { accountId: accountA, debit: "100" },
            { accountId: accountB, credit: "99.99999999" },
          ],
        }),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  describe("the database guarantees underneath", () => {
    it("blocks in-place line deletion on a posted journal", async () => {
      const original = await post("400");
      await expect(
        sql`DELETE FROM journal_lines WHERE journal_header_id = ${original}`,
      ).rejects.toThrow(/posted/);
    });

    it("blocks re-pointing account_id on a posted line", async () => {
      const original = await post("400");
      await expect(
        sql`UPDATE journal_lines SET account_id = ${accountB}
            WHERE journal_header_id = ${original} AND account_id = ${accountA}`,
      ).rejects.toThrow(/posted/);
    });

    it("blocks changing a posted header's date or amount", async () => {
      const original = await post("400");
      await expect(
        sql`UPDATE journal_headers SET transaction_date = '2026-09-09' WHERE id = ${original}`,
      ).rejects.toThrow(/posted/);
      await expect(
        sql`UPDATE journal_headers SET total_amount = 1 WHERE id = ${original}`,
      ).rejects.toThrow(/posted/);
    });

    it("still allows re-tagging dimensions and editing the memo", async () => {
      // Deliberately not frozen: these move no money, and the batch dimension
      // edit is a legitimate feature.
      const original = await post("400");
      await expect(
        sql`UPDATE journal_lines SET department_id = NULL WHERE journal_header_id = ${original}`,
      ).resolves.toBeDefined();
      await expect(
        sql`UPDATE journal_headers SET memo = 'clarified' WHERE id = ${original}`,
      ).resolves.toBeDefined();
    });

    it("still allows voiding a posted journal", async () => {
      const original = await post("400");
      await expect(
        sql`UPDATE journal_headers SET status = 'voided' WHERE id = ${original}`,
      ).resolves.toBeDefined();
    });

    it("leaves drafts freely editable", async () => {
      const draft = await post("400", "draft");
      await expect(
        sql`DELETE FROM journal_lines WHERE journal_header_id = ${draft}`,
      ).resolves.toBeDefined();
    });
  });
});
