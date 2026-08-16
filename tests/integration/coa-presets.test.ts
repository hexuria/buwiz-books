import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { categoryMappings } from "../../src/db/schema/category-mappings";
import { eq, and, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { COA_PRESETS } from "../../src/lib/coa/presets";
import { planCoaPreset, isNoopPlan } from "../../src/lib/coa/plan-preset";
import { executeCoaPlan } from "../../src/lib/coa/execute-plan";
import { loadCoaSnapshot } from "../../src/lib/coa/snapshot";
import { allMappingKeys } from "../../src/lib/coa/mapping-registry";
import { resolveMappedAccountId } from "../../src/lib/coa/resolve-mapped-account";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Chart-of-accounts presets", () => {
  let ORG_A: string;
  let ORG_B: string;
  let db: any;
  let sql: postgres.Sql;

  /** Mirrors src/db/index.ts withOrgContext: one transaction, org context pinned. */
  async function withOrgContext<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  }

  async function apply(orgId: string, presetId: keyof typeof COA_PRESETS, options = {}) {
    return withOrgContext(orgId, async (tx) => {
      const snapshot = await loadCoaSnapshot(tx, orgId);
      const plan = planCoaPreset(snapshot, COA_PRESETS[presetId], {
        onConflict: "renumber",
        ...options,
      });
      return executeCoaPlan(tx, orgId, plan, "test");
    });
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG_A = crypto.randomUUID();
    ORG_B = crypto.randomUUID();
  });

  describe.each(Object.keys(COA_PRESETS))("%s", (presetId) => {
    it("fills every mapping row with a live account", async () => {
      await apply(ORG_A, presetId as keyof typeof COA_PRESETS);

      // The headline guarantee: nothing is left unmappable.
      await withOrgContext(ORG_A, async (tx) => {
        for (const { mappingType, sourceKey } of allMappingKeys()) {
          const id = await resolveMappedAccountId(tx, ORG_A, mappingType, sourceKey);
          expect(id, `${mappingType}.${sourceKey} did not resolve`).toBeTruthy();
        }
      });
    });

    it("re-applies as a no-op", async () => {
      const first = await apply(ORG_A, presetId as keyof typeof COA_PRESETS);
      expect(first.created).toBeGreaterThan(0);

      const before = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_A));
      const second = await apply(ORG_A, presetId as keyof typeof COA_PRESETS);
      const after = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_A));

      expect(second.created).toBe(0);
      expect(after.length).toBe(before.length);
      expect(new Set(after.map((a: any) => a.id))).toEqual(new Set(before.map((a: any) => a.id)));

      await withOrgContext(ORG_A, async (tx) => {
        const snapshot = await loadCoaSnapshot(tx, ORG_A);
        expect(
          isNoopPlan(planCoaPreset(snapshot, COA_PRESETS[presetId as keyof typeof COA_PRESETS])),
        ).toBe(true);
      });
    });
  });

  it("marks exactly the 8 roots as system", async () => {
    await apply(ORG_A, "general_small_business");
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG_A), eq(accounts.isSystem, true)));
    expect(rows).toHaveLength(8);
    expect(rows.every((r: any) => r.parentId === null)).toBe(true);
  });

  it("links every child to a parent that exists", async () => {
    await apply(ORG_A, "general_small_business");
    const rows = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_A));
    const ids = new Set(rows.map((r: any) => r.id));
    for (const row of rows) {
      if (row.parentId)
        expect(ids.has(row.parentId), `${row.name} has a dangling parent`).toBe(true);
    }
  });

  it("does NOT touch another organization's chart", async () => {
    // The regression guard for the old `DELETE FROM accounts` with no org
    // predicate, which wiped every tenant.
    await apply(ORG_B, "general_small_business");
    const before = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_B));
    const beforeMappings = await db
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.organizationId, ORG_B));

    await apply(ORG_A, "retail_ecommerce");

    const after = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_B));
    const afterMappings = await db
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.organizationId, ORG_B));

    expect(after.length).toBe(before.length);
    expect(new Set(after.map((a: any) => a.id))).toEqual(new Set(before.map((a: any) => a.id)));
    expect(afterMappings.length).toBe(beforeMappings.length);
  });

  it("reuses a conflicting number's account and renumbers its own instead", async () => {
    // 11000 is Bank Accounts (asset) in the preset; give the org a liability there.
    const existingId = crypto.randomUUID();
    await db.insert(accounts).values({
      id: existingId,
      organizationId: ORG_A,
      name: "Legacy Loan",
      accountNumber: "11000",
      accountType: "liability",
      subtype: "long_term_debt",
    });

    const result = await apply(ORG_A, "general_small_business");
    expect(result.renumbered.length).toBeGreaterThan(0);

    const [existing] = await db.select().from(accounts).where(eq(accounts.id, existingId));
    // Untouched: not retyped, not renamed, not renumbered.
    expect(existing.accountType).toBe("liability");
    expect(existing.name).toBe("Legacy Loan");
    expect(existing.accountNumber).toBe("11000");

    await withOrgContext(ORG_A, async (tx) => {
      for (const { mappingType, sourceKey } of allMappingKeys()) {
        expect(await resolveMappedAccountId(tx, ORG_A, mappingType, sourceKey)).toBeTruthy();
      }
    });
  });

  it("applies a second preset additively without removing the first", async () => {
    await apply(ORG_A, "general_small_business");
    const before = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_A));

    await apply(ORG_A, "saas_startup");
    const after = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_A));

    expect(after.length).toBeGreaterThan(before.length);
    // Nothing from the first preset disappeared or changed type.
    for (const row of before) {
      const still = after.find((a: any) => a.id === row.id);
      expect(still, `${row.name} vanished`).toBeDefined();
      expect(still.accountType).toBe(row.accountType);
      expect(still.parentId).toBe(row.parentId);
    }
  });

  it("does not overwrite a mapping a human already set", async () => {
    await apply(ORG_A, "general_small_business");
    const [someExpense] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG_A), eq(accounts.accountNumber, "66000")));

    await withOrgContext(ORG_A, async (tx) => {
      await tx
        .insert(categoryMappings)
        .values({
          organizationId: ORG_A,
          mappingType: "bill",
          sourceKey: "default_expense",
          targetCategoryId: someExpense.id,
        })
        .onConflictDoUpdate({
          target: [
            categoryMappings.organizationId,
            categoryMappings.mappingType,
            categoryMappings.sourceKey,
          ],
          set: { targetCategoryId: someExpense.id },
        });
    });

    await apply(ORG_A, "general_small_business");

    const [mapping] = await db
      .select()
      .from(categoryMappings)
      .where(
        and(
          eq(categoryMappings.organizationId, ORG_A),
          eq(categoryMappings.mappingType, "bill"),
          eq(categoryMappings.sourceKey, "default_expense"),
        ),
      );
    expect(mapping.targetCategoryId).toBe(someExpense.id);
  });

  it("rolls back completely when the apply throws", async () => {
    await expect(
      withOrgContext(ORG_A, async (tx) => {
        const snapshot = await loadCoaSnapshot(tx, ORG_A);
        const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business);
        await executeCoaPlan(tx, ORG_A, plan, "test");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await db.select().from(accounts).where(eq(accounts.organizationId, ORG_A));
    expect(rows).toHaveLength(0);
  });

  it("refuses to run outside an org context", async () => {
    const snapshot = { accounts: [], mappings: [] };
    const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business);
    await expect(executeCoaPlan(db, ORG_A, plan, "test")).rejects.toThrow(/withOrgContext/);
  });
});

describeDb("resolveMappedAccountId", () => {
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

  it("honors the configured mapping over the subtype fallback", async () => {
    // THE test that would have caught the write-only-table bug: change a
    // mapping and assert the consumer actually picks the new account.
    const [alternative] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "66000")));

    await withOrgContext(ORG, async (tx) => {
      await tx
        .update(categoryMappings)
        .set({ targetCategoryId: alternative.id })
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.mappingType, "bill"),
            eq(categoryMappings.sourceKey, "default_expense"),
          ),
        );

      expect(await resolveMappedAccountId(tx, ORG, "bill", "default_expense")).toBe(alternative.id);
    });
  });

  it("falls through when the mapped account is soft-deleted", async () => {
    await withOrgContext(ORG, async (tx) => {
      const mappedId = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.id, mappedId!));

      const next = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      // Never returns the dead account.
      expect(next).not.toBe(mappedId);
    });
  });

  it("falls through when the mapped account has the wrong account type", async () => {
    await withOrgContext(ORG, async (tx) => {
      const [revenue] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "41000")));

      await tx
        .update(categoryMappings)
        .set({ targetCategoryId: revenue.id })
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.mappingType, "bill"),
            eq(categoryMappings.sourceKey, "default_expense"),
          ),
        );

      // A revenue account must never be handed back for an expense mapping —
      // it would unbalance every bill journal that used it.
      const resolved = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      expect(resolved).not.toBe(revenue.id);
    });
  });

  it("is deterministic across repeated calls", async () => {
    await withOrgContext(ORG, async (tx) => {
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await resolveMappedAccountId(tx, ORG, "invoice", "sales_tax_payable"));
      }
      expect(new Set(results).size).toBe(1);
    });
  });

  it("returns null rather than an arbitrary account when nothing resolves", async () => {
    const emptyOrg = crypto.randomUUID();
    await withOrgContext(emptyOrg, async (tx) => {
      expect(await resolveMappedAccountId(tx, emptyOrg, "bill", "default_expense")).toBeNull();
    });
  });
});
