import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { categoryMappings } from "../../src/db/schema/category-mappings";
import {
  assertMappingTargetAssignable,
  assertNotMappingTarget,
  assertValidParentAssignment,
} from "../../src/lib/coa/account-guards";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Audit PR-14 — the DB-backed guards that keep the chart and the category
 * mappings coherent: a mapping can only point at an org-owned, active,
 * type-compatible account; a live mapping target cannot be deactivated or
 * deleted (checkpoint C7); a parent must be org-owned, same-typed, acyclic.
 */
describeDb("account and mapping guards", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG = `map-guard-${randomUUID()}`;
  const FOREIGN_ORG = `map-guard-f-${randomUUID()}`;
  let apAccountId: string;
  let expenseAccountId: string;
  let inactiveLiabilityId: string;
  let foreignLiabilityId: string;

  async function addAccount(orgId: string, opts: Record<string, unknown>) {
    const [row] = await db
      .insert(accounts)
      .values({
        organizationId: orgId,
        name: String(opts.name),
        accountNumber: String(opts.accountNumber ?? Math.floor(Math.random() * 90000) + 10000),
        accountType: String(opts.accountType),
        subtype: (opts.subtype as string | undefined) ?? null,
        parentId: (opts.parentId as string | undefined) ?? null,
        isActive: (opts.isActive as boolean | undefined) ?? true,
        status: opts.isActive === false ? "inactive" : "active",
      })
      .returning({ id: accounts.id });
    return row.id as string;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    for (const [id, name] of [
      [ORG, "Mapping Guard Org"],
      [FOREIGN_ORG, "Mapping Guard Foreign"],
    ] as const) {
      await db.insert(organization).values({ id, name, slug: `mg-${randomUUID().slice(0, 12)}` });
    }
    apAccountId = await addAccount(ORG, {
      name: "Accounts Payable",
      accountType: "liability",
      subtype: "accounts_payable",
    });
    expenseAccountId = await addAccount(ORG, { name: "Supplies", accountType: "expense" });
    inactiveLiabilityId = await addAccount(ORG, {
      name: "Old AP",
      accountType: "liability",
      isActive: false,
    });
    foreignLiabilityId = await addAccount(FOREIGN_ORG, {
      name: "Their AP",
      accountType: "liability",
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  describe("mapping target assignment", () => {
    it("accepts a compatible org-owned active account", async () => {
      await expect(
        assertMappingTargetAssignable(db, ORG, "bill", "accounts_payable", apAccountId),
      ).resolves.toBeUndefined();
    });

    it("refuses an unknown mapping key outright", async () => {
      await expect(
        assertMappingTargetAssignable(db, ORG, "bill", "no_such_key", apAccountId),
      ).rejects.toThrow(/unknown mapping/i);
      await expect(
        assertMappingTargetAssignable(db, ORG, "payroll", "accounts_payable", apAccountId),
      ).rejects.toThrow(/unknown mapping/i);
    });

    it("refuses a type-incompatible target — the wrong-ledger reroute", async () => {
      await expect(
        assertMappingTargetAssignable(db, ORG, "bill", "accounts_payable", expenseAccountId),
      ).rejects.toThrow(/liability/i);
    });

    it("refuses foreign and inactive accounts", async () => {
      await expect(
        assertMappingTargetAssignable(db, ORG, "bill", "accounts_payable", foreignLiabilityId),
      ).rejects.toThrow(/unavailable/i);
      await expect(
        assertMappingTargetAssignable(db, ORG, "bill", "accounts_payable", inactiveLiabilityId),
      ).rejects.toThrow(/unavailable/i);
    });
  });

  describe("mapping target protection (C7)", () => {
    it("blocks deactivating or deleting a live mapping target, naming the mapping", async () => {
      await db.insert(categoryMappings).values({
        organizationId: ORG,
        mappingType: "bill",
        sourceKey: "accounts_payable",
        targetCategoryId: apAccountId,
        updatedAt: new Date(),
      });
      await expect(assertNotMappingTarget(db, ORG, apAccountId, "deactivate")).rejects.toThrow(
        /bill\/accounts_payable/,
      );
      await expect(assertNotMappingTarget(db, ORG, apAccountId, "delete")).rejects.toThrow(
        /repoint/i,
      );
    });

    it("an untargeted account passes", async () => {
      await expect(
        assertNotMappingTarget(db, ORG, expenseAccountId, "deactivate"),
      ).resolves.toBeUndefined();
    });
  });

  describe("parent assignment", () => {
    it("accepts a same-type org-owned parent", async () => {
      const child = await addAccount(ORG, { name: "Child Expense", accountType: "expense" });
      await expect(
        assertValidParentAssignment(db, ORG, child, expenseAccountId, "expense"),
      ).resolves.toBeUndefined();
    });

    it("refuses a foreign parent — the old walk silently wrote it", async () => {
      const child = await addAccount(ORG, { name: "Child L", accountType: "liability" });
      await expect(
        assertValidParentAssignment(db, ORG, child, foreignLiabilityId, "liability"),
      ).rejects.toThrow(/unavailable/i);
    });

    it("refuses a cross-type parent", async () => {
      const child = await addAccount(ORG, { name: "Child E2", accountType: "expense" });
      await expect(
        assertValidParentAssignment(db, ORG, child, apAccountId, "expense"),
      ).rejects.toThrow(/same account type/i);
    });

    it("refuses self-parenting and cycles", async () => {
      const a = await addAccount(ORG, { name: "Cycle A", accountType: "expense" });
      const b = await addAccount(ORG, { name: "Cycle B", accountType: "expense", parentId: a });
      await expect(assertValidParentAssignment(db, ORG, a, a, "expense")).rejects.toThrow(
        /own parent/i,
      );
      // Moving A under B would close the loop A -> B -> A.
      await expect(assertValidParentAssignment(db, ORG, a, b, "expense")).rejects.toThrow(/cycle/i);
    });
  });
});
