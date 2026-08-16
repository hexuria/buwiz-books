import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { accounts } from "../../src/db/schema/accounts";
import { categoryMappings } from "../../src/db/schema/category-mappings";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { COA_PRESETS } from "../../src/lib/coa/presets";
import { planCoaPreset } from "../../src/lib/coa/plan-preset";
import { executeCoaPlan } from "../../src/lib/coa/execute-plan";
import { loadCoaSnapshot } from "../../src/lib/coa/snapshot";
import { allMappingKeys } from "../../src/lib/coa/mapping-registry";
import { resolveMappedAccountId } from "../../src/lib/coa/resolve-mapped-account";
import { coaAccountsApplier, categoryMappingApplier } from "../../src/lib/ai/proposal-appliers/coa";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * End-to-end cover for the AI write path.
 *
 * The applier is the ONLY place an approved model draft becomes rows, so this
 * asserts the properties the unit tests can only assert about the plan: that it
 * writes through the shared executor, stays additive, cannot create a system
 * account, and cannot re-point a posting default at an incompatible type.
 */
describeDb("AI chart-of-accounts appliers", () => {
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

  const ctx = (tx: any) => ({ orgId: ORG, userId: "test-user", role: "owner", db: tx });

  async function expenseParent(tx: any) {
    const [row] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "60000")));
    return row;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG = crypto.randomUUID();
    // The AI path extends an existing chart; the preset owns the roots.
    await withOrgContext(ORG, async (tx) => {
      const snapshot = await loadCoaSnapshot(tx, ORG);
      const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
        onConflict: "renumber",
      });
      await executeCoaPlan(tx, ORG, plan, "test");
    });
  });

  it("creates the approved accounts under a real parent", async () => {
    await withOrgContext(ORG, async (tx) => {
      const parent = await expenseParent(tx);
      const result: any = await coaAccountsApplier.apply(ctx(tx), {
        accounts: [
          {
            key: "coffee_beans",
            name: "Coffee Beans & Tea",
            accountType: "expense",
            subtype: "supplies_and_materials",
            parentAccountId: parent.id,
          },
        ],
      });
      expect(result.created).toBe(1);

      const [created] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.name, "Coffee Beans & Tea")));
      expect(created).toBeDefined();
      expect(created.parentId).toBe(parent.id);
      expect(created.accountType).toBe("expense");
      // An AI-created account must never be undeletable.
      expect(created.isSystem).toBe(false);
      // Numbering is TypeScript's job — the model never supplies one.
      expect(created.accountNumber).toMatch(/^6\d{4}$/);
    });
  });

  it("honors excludedKeys and never touches an existing account", async () => {
    await withOrgContext(ORG, async (tx) => {
      const parent = await expenseParent(tx);
      const before = await tx.select().from(accounts).where(eq(accounts.organizationId, ORG));

      const result: any = await coaAccountsApplier.apply(ctx(tx), {
        accounts: [
          {
            key: "keep_me",
            name: "Kept Category",
            accountType: "expense",
            subtype: "general_operations",
            parentAccountId: parent.id,
          },
          {
            key: "drop_me",
            name: "Dropped Category",
            accountType: "expense",
            subtype: "general_operations",
            parentAccountId: parent.id,
          },
        ],
        excludedKeys: ["drop_me"],
      });
      expect(result.created).toBe(1);

      const after = await tx.select().from(accounts).where(eq(accounts.organizationId, ORG));
      expect(after.length).toBe(before.length + 1);
      expect(after.some((a: any) => a.name === "Dropped Category")).toBe(false);
      // Every pre-existing account is byte-identical.
      for (const row of before) {
        const still = after.find((a: any) => a.id === row.id);
        expect(still.name).toBe(row.name);
        expect(still.accountType).toBe(row.accountType);
        expect(still.subtype).toBe(row.subtype);
        expect(still.parentId).toBe(row.parentId);
      }
    });
  });

  it("does not synthesize accounts for unrelated mapping gaps", async () => {
    await withOrgContext(ORG, async (tx) => {
      // Open a gap the reviewer never saw.
      await tx
        .delete(categoryMappings)
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.sourceKey, "hosting_fees"),
          ),
        );
      const [hosting] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "54000")));
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.id, hosting.id));

      const parent = await expenseParent(tx);
      const before = await tx.select().from(accounts).where(eq(accounts.organizationId, ORG));

      // Approving must succeed and add exactly one account — not fail on the
      // gap, and not quietly close it with accounts nobody reviewed.
      const result: any = await coaAccountsApplier.apply(ctx(tx), {
        accounts: [
          {
            key: "only_this",
            name: "Only This One",
            accountType: "expense",
            subtype: "general_operations",
            parentAccountId: parent.id,
          },
        ],
      });
      expect(result.created).toBe(1);

      const after = await tx.select().from(accounts).where(eq(accounts.organizationId, ORG));
      expect(after.length).toBe(before.length + 1);
    });
  });

  it("re-points a posting default only to a compatible account type", async () => {
    await withOrgContext(ORG, async (tx) => {
      const [facilities] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "66000")));
      const [revenue] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "41000")));

      const result: any = await categoryMappingApplier.apply(ctx(tx), {
        assignments: [
          // Legitimate: expense row -> expense account.
          {
            mappingType: "bill",
            sourceKey: "default_expense",
            targetAccountId: facilities.id,
            targetAccountType: "expense",
          },
          // The injection case: expense row -> revenue account. Must be inert.
          {
            mappingType: "bill",
            sourceKey: "other_miscellaneous_expenses",
            targetAccountId: revenue.id,
            targetAccountType: "revenue",
          },
        ],
      });

      expect(result.written).toBe(1);
      expect(result.skipped).toBe(1);

      expect(await resolveMappedAccountId(tx, ORG, "bill", "default_expense")).toBe(facilities.id);
      const misc = await resolveMappedAccountId(tx, ORG, "bill", "other_miscellaneous_expenses");
      expect(misc).not.toBe(revenue.id);
    });
  });

  it("leaves the chart fully mapped after an AI apply", async () => {
    await withOrgContext(ORG, async (tx) => {
      const parent = await expenseParent(tx);
      await coaAccountsApplier.apply(ctx(tx), {
        accounts: [
          {
            key: "extra",
            name: "Extra Category",
            accountType: "expense",
            subtype: "general_operations",
            parentAccountId: parent.id,
          },
        ],
      });

      for (const { mappingType, sourceKey } of allMappingKeys()) {
        expect(
          await resolveMappedAccountId(tx, ORG, mappingType, sourceKey),
          `${mappingType}.${sourceKey} stopped resolving`,
        ).toBeTruthy();
      }
    });
  });

  it("declares only additive permissions", () => {
    const perms = coaAccountsApplier.requiredPermissions({ accounts: [] });
    // account:create and nothing else — no update, no delete.
    expect(perms).toEqual([{ resource: "account", action: "create" }]);
  });
});
