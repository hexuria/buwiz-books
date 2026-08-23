import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { amendPostedJournal } from "../../src/lib/journal-amendment";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Deferred constraint triggers reject at COMMIT; drizzle wraps the real
 * message inside the error cause chain. */
async function expectCommitRefusal(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
    throw new Error(`expected refusal matching ${pattern}`);
  } catch (error) {
    let current: unknown = error;
    const seen: string[] = [];
    while (current instanceof Error) {
      seen.push(current.message);
      current = current.cause;
    }
    expect(seen.join(" | ")).toMatch(pattern);
  }
}

/**
 * Program 2 P3 — posting lifecycle integrity (audit, ledger core).
 *
 * 0051: 0042's forbid-mutation trigger exempted the whole UPDATE whenever
 * the row was being voided — one statement could void AND rewrite
 * date/amount/party. 0052: 0041's balance triggers passed a zero-line
 * posted journal as 0 = 0. And postedAt was never stamped, which made
 * legacy-match-conversion refuse every app-posted journal as
 * invalid_posting_state.
 */
describeDb("posting lifecycle integrity", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `post-life-${randomUUID()}`;
  let cashId: string;
  let expenseId: string;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "Posting Lifecycle Org",
      slug: `pl-${randomUUID().slice(0, 8)}`,
    });
    const [cash] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Cash",
        accountNumber: "11100",
        accountType: "asset",
        subtype: "bank_accounts",
      })
      .returning({ id: accounts.id });
    cashId = cash.id;
    const [expense] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Ops",
        accountNumber: "61100",
        accountType: "expense",
      })
      .returning({ id: accounts.id });
    expenseId = expense.id;
  });
  afterAll(async () => {
    await sql.end();
  });

  async function postJournal(amount = "100.00"): Promise<string> {
    return db.transaction(async (tx: any) => {
      const [header] = await tx
        .insert(journalHeaders)
        .values({
          organizationId: ORG,
          transactionNumber: `TXN-${randomUUID().slice(0, 8)}`,
          transactionDate: "2026-07-01",
          transactionType: "journal",
          source: "manual",
          functionalCurrency: "USD",
          totalAmount: amount,
          status: "posted",
          postedAt: new Date(),
        })
        .returning({ id: journalHeaders.id });
      await tx.insert(journalLines).values([
        { journalHeaderId: header.id, accountId: expenseId, debit: amount, sortOrder: 0 },
        { journalHeaderId: header.id, accountId: cashId, credit: amount, sortOrder: 1 },
      ]);
      return header.id as string;
    });
  }

  it("0051: voiding cannot smuggle a financial rewrite in the same UPDATE", async () => {
    const id = await postJournal();
    await expectCommitRefusal(
      db
        .update(journalHeaders)
        .set({ status: "voided", voidedAt: new Date(), totalAmount: "999.99" })
        .where(eq(journalHeaders.id, id)),
      /cannot be edited in place/,
    );

    // A plain void — status + voidedAt (+ memo) — still passes.
    await db
      .update(journalHeaders)
      .set({ status: "voided", voidedAt: new Date(), memo: "voided in test" })
      .where(eq(journalHeaders.id, id));
    const [row] = await db.select().from(journalHeaders).where(eq(journalHeaders.id, id));
    expect(row.status).toBe("voided");
    expect(row.totalAmount).toBe("100.00000000");
  });

  it("0052: a posted header cannot commit with zero lines", async () => {
    await expectCommitRefusal(
      db.insert(journalHeaders).values({
        organizationId: ORG,
        transactionNumber: `TXN-${randomUUID().slice(0, 8)}`,
        transactionDate: "2026-07-01",
        transactionType: "journal",
        source: "manual",
        functionalCurrency: "USD",
        totalAmount: "50.00",
        status: "posted",
        postedAt: new Date(),
      }),
      /without lines|at least one line/,
    );
  });

  it("deleting the last lines out from under a posted journal is refused", async () => {
    const id = await postJournal();
    // 0042's line trigger fronts this path ("cannot be deleted"); 0052's
    // line-count check is the commit-time backstop behind it.
    await expectCommitRefusal(
      db.delete(journalLines).where(eq(journalLines.journalHeaderId, id)),
      /cannot be deleted|at least one line/,
    );
  });

  it("amendment stamps postedAt on both the reversal and the replacement", async () => {
    const id = await postJournal("80.00");
    const result = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        headerId: id,
        userId: "test-user",
        reason: "postedAt stamping test",
        lines: [
          { accountId: expenseId, debit: "80.00" },
          { accountId: cashId, credit: "80.00" },
        ],
      }),
    );
    const rows = await db
      .select({ id: journalHeaders.id, postedAt: journalHeaders.postedAt })
      .from(journalHeaders)
      .where(
        and(eq(journalHeaders.organizationId, ORG), eq(journalHeaders.id, result.reversalHeaderId)),
      );
    expect(rows[0].postedAt).not.toBeNull();
  });

  it("a voided reversal no longer freezes the original as unamendable", async () => {
    const id = await postJournal("60.00");
    const first = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        headerId: id,
        userId: "test-user",
        reason: "first amendment",
        lines: [
          { accountId: expenseId, debit: "60.00" },
          { accountId: cashId, credit: "60.00" },
        ],
      }),
    );
    // The whole first amendment was wrong: void BOTH the reversal and the
    // replacement (plain voids — 0051 allows them).
    for (const headerId of [first.reversalHeaderId, first.replacementHeaderId]) {
      await db
        .update(journalHeaders)
        .set({ status: "voided", voidedAt: new Date() })
        .where(eq(journalHeaders.id, headerId));
    }
    // The old app-side check counted the voided reversal and threw
    // AlreadyAmendedError; the enforcing index never did.
    const second = await db.transaction((tx: any) =>
      amendPostedJournal(tx, {
        organizationId: ORG,
        headerId: id,
        userId: "test-user",
        reason: "second amendment after voided first",
        lines: [
          { accountId: expenseId, debit: "60.00" },
          { accountId: cashId, credit: "60.00" },
        ],
      }),
    );
    expect(second.reversalHeaderId).toBeDefined();
  });
});
