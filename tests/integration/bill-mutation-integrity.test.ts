import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { parties } from "../../src/db/schema/parties";
import { assertBillReferences } from "../../src/lib/bill-mutation-guards";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Audit PR-13 — the DB-backed half of the bill mutation guards: every
 * reference on a bill payload must be org-owned, active, and an expense-type
 * account. Before this, createBill/saveBillLineItems accepted any UUID — a
 * crafted request could park bill lines on ANOTHER organization's account.
 */
describeDb("bill reference guards", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG = `bill-guard-${randomUUID()}`;
  const FOREIGN_ORG = `bill-guard-f-${randomUUID()}`;
  let vendorId: string;
  let foreignVendorId: string;
  let expenseAccountId: string;
  let assetAccountId: string;
  let inactiveExpenseId: string;
  let foreignExpenseId: string;

  async function addAccount(orgId: string, opts: Partial<Record<string, unknown>>) {
    const [row] = await db
      .insert(accounts)
      .values({
        organizationId: orgId,
        name: String(opts.name ?? "Account"),
        accountNumber: String(opts.accountNumber ?? Math.floor(Math.random() * 90000) + 10000),
        accountType: String(opts.accountType ?? "expense"),
        isActive: (opts.isActive as boolean | undefined) ?? true,
        status: opts.isActive === false ? "inactive" : "active",
      })
      .returning({ id: accounts.id });
    return row.id as string;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    for (const [id, name] of [
      [ORG, "Bill Guard Org"],
      [FOREIGN_ORG, "Bill Guard Foreign"],
    ] as const) {
      await db.insert(organization).values({
        id,
        name,
        slug: `bg-${randomUUID().slice(0, 12)}`,
      });
    }
    const [vendor] = await db
      .insert(parties)
      .values({ organizationId: ORG, name: "Own Vendor", partyType: "vendor" })
      .returning({ id: parties.id });
    vendorId = vendor.id;
    const [foreignVendor] = await db
      .insert(parties)
      .values({ organizationId: FOREIGN_ORG, name: "Foreign Vendor", partyType: "vendor" })
      .returning({ id: parties.id });
    foreignVendorId = foreignVendor.id;

    expenseAccountId = await addAccount(ORG, { name: "Supplies", accountType: "expense" });
    assetAccountId = await addAccount(ORG, { name: "Equipment", accountType: "asset" });
    inactiveExpenseId = await addAccount(ORG, {
      name: "Old Supplies",
      accountType: "expense",
      isActive: false,
    });
    foreignExpenseId = await addAccount(FOREIGN_ORG, {
      name: "Their Supplies",
      accountType: "expense",
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("accepts an org-owned vendor and active expense accounts", async () => {
    await expect(
      assertBillReferences(db, ORG, vendorId, [{ accountId: expenseAccountId }]),
    ).resolves.toBeUndefined();
  });

  it("refuses another organization's account outright", async () => {
    await expect(
      assertBillReferences(db, ORG, vendorId, [{ accountId: foreignExpenseId }]),
    ).rejects.toThrow(/unavailable/i);
  });

  it("refuses a non-expense account type — the UI never offered it", async () => {
    await expect(
      assertBillReferences(db, ORG, vendorId, [{ accountId: assetAccountId }]),
    ).rejects.toThrow(/expense-type/i);
  });

  it("refuses an inactive account", async () => {
    await expect(
      assertBillReferences(db, ORG, vendorId, [{ accountId: inactiveExpenseId }]),
    ).rejects.toThrow(/unavailable/i);
  });

  it("refuses another organization's vendor", async () => {
    await expect(
      assertBillReferences(db, ORG, foreignVendorId, [{ accountId: expenseAccountId }]),
    ).rejects.toThrow(/vendor/i);
  });

  it("a mixed batch fails when ANY account is bad", async () => {
    await expect(
      assertBillReferences(db, ORG, vendorId, [
        { accountId: expenseAccountId },
        { accountId: foreignExpenseId },
      ]),
    ).rejects.toThrow(/unavailable/i);
  });
});
