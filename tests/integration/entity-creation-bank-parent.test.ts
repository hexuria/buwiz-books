import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { COA_PRESETS } from "../../src/lib/coa/presets";
import { planCoaPreset } from "../../src/lib/coa/plan-preset";
import { executeCoaPlan } from "../../src/lib/coa/execute-plan";
import { loadCoaSnapshot } from "../../src/lib/coa/snapshot";
import { ensureBankInfrastructure } from "../../src/lib/entity-creation";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * `ensureBankInfrastructure` writes a COA account carrying the SAME subtype as
 * the parent it just looked up, so every account it creates is a candidate
 * parent for the next call. Without a total ordering on that lookup, the second
 * bank account can be parented under the first — a chain that distorts every
 * reporting rollup that walks the tree. This path can run unattended, so the
 * ordering is the only thing preventing it.
 */
describeDb("bank infrastructure parent selection", () => {
  let ORG: string;
  let db: any;
  let sql: postgres.Sql;

  async function withOrgContext<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  }

  const bankEntity = (name: string, identifier: string, accountType = "checking") => ({
    entityType: "bank" as const,
    name,
    identifier,
    accountType,
    matchedPartyId: "",
  });

  async function nodeBySubtypeUnderRoot(tx: any, subtype: string) {
    const rows = await tx
      .select({ id: accounts.id, name: accounts.name, parentId: accounts.parentId })
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG), eq(accounts.subtype, subtype)));
    // The preset node is the one whose own parent is a system root.
    for (const row of rows) {
      if (!row.parentId) continue;
      const [parent] = await tx
        .select({ isSystem: accounts.isSystem })
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, row.parentId)));
      if (parent?.isSystem) return row;
    }
    return undefined;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG = crypto.randomUUID();
    await withOrgContext(ORG, async (tx) => {
      const snapshot = await loadCoaSnapshot(tx, ORG);
      const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
        onConflict: "renumber",
      });
      await executeCoaPlan(tx, ORG, plan, "test");
    });
  });

  it("parents every created bank account under the preset node, never under a sibling", async () => {
    await withOrgContext(ORG, async (tx) => {
      const bankAccountsNode = await nodeBySubtypeUnderRoot(tx, "bank_accounts");
      expect(bankAccountsNode).toBeTruthy();

      const first = await ensureBankInfrastructure(tx, ORG, bankEntity("Acme Bank", "****1111"));
      const second = await ensureBankInfrastructure(tx, ORG, bankEntity("Beta Bank", "****2222"));
      const third = await ensureBankInfrastructure(tx, ORG, bankEntity("Gamma Bank", "****3333"));

      const createdIds = [first.accountId, second.accountId, third.accountId];
      expect(createdIds.every(Boolean)).toBe(true);
      expect(new Set(createdIds).size).toBe(3);

      for (const id of createdIds) {
        const [row] = await tx
          .select({ parentId: accounts.parentId })
          .from(accounts)
          .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, id!)));
        expect(row.parentId).toBe(bankAccountsNode!.id);
      }

      // Nothing created here may be the parent of anything else.
      for (const id of createdIds) {
        const children = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.organizationId, ORG), eq(accounts.parentId, id!)));
        expect(children).toHaveLength(0);
      }
    });
  });

  it("still picks the preset node when unnumbered siblings already exist", async () => {
    await withOrgContext(ORG, async (tx) => {
      const bankAccountsNode = await nodeBySubtypeUnderRoot(tx, "bank_accounts");

      // Simulate accounts an earlier run created: same subtype, no number,
      // hanging off the preset node.
      for (const name of ["Legacy One", "Legacy Two", "Legacy Three"]) {
        await tx.insert(accounts).values({
          organizationId: ORG,
          name,
          accountType: "asset",
          subtype: "bank_accounts",
          parentId: bankAccountsNode!.id,
        });
      }

      const created = await ensureBankInfrastructure(tx, ORG, bankEntity("Delta Bank", "****4444"));
      const [row] = await tx
        .select({ parentId: accounts.parentId })
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, created.accountId!)));
      expect(row.parentId).toBe(bankAccountsNode!.id);
    });
  });

  it("parents credit cards under the credit-card preset node", async () => {
    await withOrgContext(ORG, async (tx) => {
      const creditCardsNode = await nodeBySubtypeUnderRoot(tx, "credit_cards");
      expect(creditCardsNode).toBeTruthy();

      const first = await ensureBankInfrastructure(
        tx,
        ORG,
        bankEntity("Acme Card", "****5555", "credit_card"),
      );
      const second = await ensureBankInfrastructure(
        tx,
        ORG,
        bankEntity("Beta Card", "****6666", "credit_card"),
      );

      for (const id of [first.accountId, second.accountId]) {
        const [row] = await tx
          .select({ parentId: accounts.parentId, accountType: accounts.accountType })
          .from(accounts)
          .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, id!)));
        expect(row.parentId).toBe(creditCardsNode!.id);
        expect(row.accountType).toBe("liability");
      }
    });
  });

  it("reuses the existing financial account instead of creating a second one", async () => {
    await withOrgContext(ORG, async (tx) => {
      const entity = bankEntity("Acme Bank", "****1111");
      const first = await ensureBankInfrastructure(tx, ORG, entity);
      const again = await ensureBankInfrastructure(tx, ORG, entity);
      expect(again.financialAccountId).toBe(first.financialAccountId);
      expect(again.accountId).toBe(first.accountId);
    });
  });
});
