/**
 * Integration tests for aggregateBalances — the SQL that feeds the balance sheet, P&L,
 * cash flow, and trial balance. Verifies the posted-only filter, date-window inclusivity,
 * per-account debit/credit sums, and org isolation against a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { aggregateBalances } from "../../src/services/reports";
import type postgres from "postgres";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("aggregateBalances", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG = crypto.randomUUID();
  const OTHER_ORG = crypto.randomUUID();
  const CASH = crypto.randomUUID();
  const REVENUE = crypto.randomUUID();
  const OTHER_CASH = crypto.randomUUID();
  const OTHER_REVENUE = crypto.randomUUID();

  async function postEntry(opts: {
    org?: string;
    date: string;
    status: "posted" | "draft" | "voided";
    debitAccount: string;
    creditAccount: string;
    amount: string;
    duplicateOfHeaderId?: string;
  }) {
    const [h] = await db
      .insert(journalHeaders)
      .values({
        organizationId: opts.org ?? ORG,
        transactionDate: opts.date,
        transactionType: "journal",
        status: opts.status,
        duplicateOfHeaderId: opts.duplicateOfHeaderId,
      })
      .returning();
    await db.insert(journalLines).values([
      {
        journalHeaderId: h.id,
        accountId: opts.debitAccount,
        debit: opts.amount,
        credit: null,
        sortOrder: 0,
      },
      {
        journalHeaderId: h.id,
        accountId: opts.creditAccount,
        debit: null,
        credit: opts.amount,
        sortOrder: 1,
      },
    ]);
    return h.id;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    // Chart of accounts for both orgs (only ORG's are exercised; OTHER_ORG proves isolation).
    await db.insert(accounts).values([
      {
        id: CASH,
        organizationId: ORG,
        name: "Cash",
        accountType: "asset",
        subtype: "bank_accounts",
      },
      {
        id: REVENUE,
        organizationId: ORG,
        name: "Sales",
        accountType: "revenue",
        subtype: "sales_revenue",
      },
    ]);
    // Posted, in-window
    const canonicalMarchEntry = await postEntry({
      date: "2026-03-10",
      status: "posted",
      debitAccount: CASH,
      creditAccount: REVENUE,
      amount: "100.00",
    });
    // A confirmed duplicate keeps every original row for audit, but must not
    // affect any financial report.
    await postEntry({
      date: "2026-03-10",
      status: "posted",
      debitAccount: CASH,
      creditAccount: REVENUE,
      amount: "100.00",
      duplicateOfHeaderId: canonicalMarchEntry,
    });
    await postEntry({
      date: "2026-03-20",
      status: "posted",
      debitAccount: CASH,
      creditAccount: REVENUE,
      amount: "50.00",
    });
    // Posted, OUT of window (April)
    await postEntry({
      date: "2026-04-05",
      status: "posted",
      debitAccount: CASH,
      creditAccount: REVENUE,
      amount: "999.00",
    });
    // Draft and voided — must be excluded
    await postEntry({
      date: "2026-03-15",
      status: "draft",
      debitAccount: CASH,
      creditAccount: REVENUE,
      amount: "777.00",
    });
    await postEntry({
      date: "2026-03-15",
      status: "voided",
      debitAccount: CASH,
      creditAccount: REVENUE,
      amount: "888.00",
    });
    // A second org's posted entry — must never leak into ORG's aggregation
    await db.insert(accounts).values([
      {
        id: OTHER_CASH,
        organizationId: OTHER_ORG,
        name: "Other Cash",
        accountType: "asset",
      },
      {
        id: OTHER_REVENUE,
        organizationId: OTHER_ORG,
        name: "Other Revenue",
        accountType: "revenue",
      },
    ]);
    await postEntry({
      org: OTHER_ORG,
      date: "2026-03-11",
      status: "posted",
      debitAccount: OTHER_CASH,
      creditAccount: OTHER_REVENUE,
      amount: "5000.00",
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("excludes draft and voided entries; sums only posted", async () => {
    const rows = await aggregateBalances(ORG, "2026-03-01", "2026-03-31", db);
    const cash = rows.find((r) => r.accountId === CASH);
    // March effective posted debits: 100 + 50 = 150. Draft, voided, and the
    // retained 100 duplicate are excluded.
    expect(Number.parseFloat(cash?.totalDebit ?? "0")).toBe(150);
    expect(Number.parseFloat(cash?.totalCredit ?? "0")).toBe(0);
  });

  it("respects the date window (excludes April activity)", async () => {
    const rows = await aggregateBalances(ORG, "2026-03-01", "2026-03-31", db);
    const cash = rows.find((r) => r.accountId === CASH);
    // The 999 April entry is outside [Mar 1, Mar 31].
    expect(Number.parseFloat(cash?.totalDebit ?? "0")).toBe(150);
  });

  it("is cumulative from inception when dateFrom is null (trial-balance basis)", async () => {
    const rows = await aggregateBalances(ORG, null, "2026-12-31", db);
    const cash = rows.find((r) => r.accountId === CASH);
    // All posted: 100 + 50 + 999 = 1149.
    expect(Number.parseFloat(cash?.totalDebit ?? "0")).toBe(1149);
  });

  it("returns only the requested org's accounts", async () => {
    const rows = await aggregateBalances(ORG, null, "2026-12-31", db);
    expect(rows.every((r) => r.accountId === CASH || r.accountId === REVENUE)).toBe(true);
    expect(rows.some((r) => r.accountId === CASH)).toBe(true);
    expect(rows.some((r) => r.accountId === OTHER_CASH || r.accountId === OTHER_REVENUE)).toBe(
      false,
    );
  });
});
