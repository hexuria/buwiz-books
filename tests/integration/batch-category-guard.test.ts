import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Program 2 P2 — the batch targeted-category ambiguity, pinned at the SQL
 * level the route now uses: a split journal posting twice to one account
 * must be detected (count > 1 per header) BEFORE any repoint, because the
 * old blanket UPDATE moved BOTH lines — double the intended amount.
 */
describeDb("batch category ambiguity detection", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `batch-guard-${randomUUID()}`;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "Batch Guard Org",
      slug: `bg-${randomUUID().slice(0, 8)}`,
    });
  });
  afterAll(async () => {
    await sql.end();
  });

  it("flags only headers with more than one line on the source account", async () => {
    const [expense] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Split Expense",
        accountNumber: "61999",
        accountType: "expense",
      })
      .returning({ id: accounts.id });
    const [bank] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Guard Bank",
        accountNumber: "11999",
        accountType: "asset",
        subtype: "bank_accounts",
      })
      .returning({ id: accounts.id });

    async function addJournal(splitOnExpense: boolean) {
      const [header] = await db
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionNumber: `TXN-${randomUUID().slice(0, 8)}`,
          transactionDate: "2026-07-01",
          transactionType: "journal",
          source: "manual",
          functionalCurrency: "USD",
          totalAmount: "100.00",
          status: "draft",
        })
        .returning({ id: journalHeaders.id });
      const lines = splitOnExpense
        ? [
            { accountId: expense.id, debit: "60.00", credit: null },
            { accountId: expense.id, debit: "40.00", credit: null },
            { accountId: bank.id, debit: null, credit: "100.00" },
          ]
        : [
            { accountId: expense.id, debit: "100.00", credit: null },
            { accountId: bank.id, debit: null, credit: "100.00" },
          ];
      await db.insert(journalLines).values(
        lines.map((line, i) => ({
          journalHeaderId: header.id,
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
          sortOrder: i,
        })),
      );
      return header.id as string;
    }

    const splitId = await addJournal(true);
    const simpleId = await addJournal(false);

    const ambiguous = await db
      .select({
        journalHeaderId: journalLines.journalHeaderId,
        matches: drizzleSql<number>`count(*)::int`,
      })
      .from(journalLines)
      .where(
        and(
          inArray(journalLines.journalHeaderId, [splitId, simpleId]),
          eq(journalLines.accountId, expense.id),
        ),
      )
      .groupBy(journalLines.journalHeaderId)
      .having(drizzleSql`count(*) > 1`);

    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].journalHeaderId).toBe(splitId);
  });
});
