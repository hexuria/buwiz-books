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
import {
  ALL_MAPPING_CONFIGS,
  allMappingKeys,
  mappingRowFor,
} from "../../src/lib/coa/mapping-registry";
import {
  UnmappedAccountError,
  mappedAccountFamilyIds,
  requireMappedAccountId,
  resolveMappedAccountId,
  resolveMappedAccountIds,
} from "../../src/lib/coa/resolve-mapped-account";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Direct cover for the mapping resolver, which had none.
 *
 * These live in integration rather than unit deliberately: the tier 2 tie-break
 * is a Postgres ORDER BY over a nullable varchar under the cluster's collation,
 * with NULLS LAST. A fake would be asserting against a JS re-implementation of
 * exactly the semantics that must not drift.
 */
describeDb("chart-of-accounts mapping resolver", () => {
  let ORG: string;
  let db: any;
  let sql: postgres.Sql;

  /** Statements sent to Postgres, so round trips can be asserted, not assumed. */
  const seenQueries: string[] = [];

  async function withOrgContext<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  }

  async function seedPreset(orgId: string) {
    await withOrgContext(orgId, async (tx) => {
      const snapshot = await loadCoaSnapshot(tx, orgId);
      const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
        onConflict: "renumber",
      });
      await executeCoaPlan(tx, orgId, plan, "test");
    });
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb({ onQuery: (q) => seenQueries.push(q) }));
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG = crypto.randomUUID();
    await seedPreset(ORG);
  });

  // ---- Tier 1: the configured mapping ------------------------------------

  it("honors a configured mapping over the subtype fallback", async () => {
    await withOrgContext(ORG, async (tx) => {
      const row = mappingRowFor("bill", "default_expense")!;
      const fallback = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");

      const [target] = await tx
        .insert(accounts)
        .values({
          organizationId: ORG,
          name: "Deliberately Chosen Expense",
          accountType: row.ledgerType,
          subtype: "general_operations",
          accountNumber: "69991",
        })
        .returning({ id: accounts.id });

      await tx
        .update(categoryMappings)
        .set({ targetCategoryId: target.id })
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.mappingType, "bill"),
            eq(categoryMappings.sourceKey, "default_expense"),
          ),
        );

      const resolved = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      expect(resolved).toBe(target.id);
      expect(resolved).not.toBe(fallback);
    });
  });

  it("ignores a mapping whose target was soft-deleted, and falls through to tier 2", async () => {
    await withOrgContext(ORG, async (tx) => {
      const before = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      expect(before).toBeTruthy();

      await tx
        .update(accounts)
        .set({ isActive: false })
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, before!)));

      const after = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      // Must not return the dead account, and must not return null while a live
      // subtype candidate still exists.
      expect(after).not.toBe(before);
    });
  });

  it("ignores a mapping pointed at the wrong account type", async () => {
    await withOrgContext(ORG, async (tx) => {
      const row = mappingRowFor("bill", "accounts_payable")!;
      expect(row.ledgerType).toBe("liability");

      const [wrongType] = await tx
        .insert(accounts)
        .values({
          organizationId: ORG,
          name: "Not A Liability",
          accountType: "asset",
          subtype: "other_current_assets",
          accountNumber: "19991",
        })
        .returning({ id: accounts.id });

      await tx
        .update(categoryMappings)
        .set({ targetCategoryId: wrongType.id })
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.mappingType, "bill"),
            eq(categoryMappings.sourceKey, "accounts_payable"),
          ),
        );

      const resolved = await resolveMappedAccountId(tx, ORG, "bill", "accounts_payable");
      expect(resolved).not.toBe(wrongType.id);

      // Whatever it returned must actually be a liability.
      const [account] = await tx
        .select({ accountType: accounts.accountType })
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, resolved!)));
      expect(account.accountType).toBe("liability");
    });
  });

  it("does not honor a mapping owned by another organization", async () => {
    const OTHER = crypto.randomUUID();
    await seedPreset(OTHER);

    await withOrgContext(OTHER, async (tx) => {
      const foreign = await resolveMappedAccountId(tx, OTHER, "bill", "default_expense");
      expect(foreign).toBeTruthy();

      const mine = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      expect(mine).not.toBe(foreign);
    });
  });

  // ---- Tier 2: the subtype fallback --------------------------------------

  it("prefers the default account number and sorts unnumbered candidates last", async () => {
    await withOrgContext(ORG, async (tx) => {
      const row = mappingRowFor("bill", "default_expense")!;

      // Force tier 2 by removing the configured mapping.
      await tx
        .delete(categoryMappings)
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.mappingType, "bill"),
            eq(categoryMappings.sourceKey, "default_expense"),
          ),
        );

      // A decoy sharing the exact (accountType, subtype) but with no number.
      // NULLS LAST must keep it from winning.
      const [decoy] = await tx
        .insert(accounts)
        .values({
          organizationId: ORG,
          name: "Unnumbered Decoy",
          accountType: row.ledgerType,
          subtype: row.defaultSubtype,
          accountNumber: null,
        })
        .returning({ id: accounts.id });

      const resolved = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      expect(resolved).not.toBe(decoy.id);

      const [account] = await tx
        .select({ accountNumber: accounts.accountNumber, subtype: accounts.subtype })
        .from(accounts)
        .where(and(eq(accounts.organizationId, ORG), eq(accounts.id, resolved!)));
      expect(account.subtype).toBe(row.defaultSubtype);
      expect(account.accountNumber).toBe(row.defaultNumber);
    });
  });

  it("is stable across repeated calls once tier 2 is doing the work", async () => {
    await withOrgContext(ORG, async (tx) => {
      await tx.delete(categoryMappings).where(eq(categoryMappings.organizationId, ORG));

      const first = await resolveMappedAccountId(tx, ORG, "bill", "default_expense");
      for (let i = 0; i < 5; i++) {
        expect(await resolveMappedAccountId(tx, ORG, "bill", "default_expense")).toBe(first);
      }
    });
  });

  // ---- The property that keeps the two paths honest ----------------------

  it("resolves every key identically one-at-a-time and in batch", async () => {
    await withOrgContext(ORG, async (tx) => {
      for (const config of ALL_MAPPING_CONFIGS) {
        const keys = config.rows.map((r) => r.type);
        const batch = await resolveMappedAccountIds(tx, ORG, config.mappingType, keys);

        for (const key of keys) {
          const single = await resolveMappedAccountId(tx, ORG, config.mappingType, key);
          expect(batch[key]).toBe(single);
        }
      }
    });
  });

  it("returns an entry for every requested key, including unknown ones", async () => {
    await withOrgContext(ORG, async (tx) => {
      const out = await resolveMappedAccountIds(tx, ORG, "bill", [
        "default_expense",
        "no_such_key",
      ]);
      expect(Object.keys(out).sort()).toEqual(["default_expense", "no_such_key"]);
      expect(out.no_such_key).toBeNull();
      expect(out.default_expense).toBeTruthy();
    });
  });

  // ---- Round trips, not just results -------------------------------------

  it("batches every key into at most two round trips", async () => {
    await withOrgContext(ORG, async (tx) => {
      const keys = ALL_MAPPING_CONFIGS.find((c) => c.mappingType === "bill")!.rows.map(
        (r) => r.type,
      );
      expect(keys.length).toBeGreaterThan(10);

      // Everything is mapped by the preset, so tier 1 answers all of it.
      seenQueries.length = 0;
      await resolveMappedAccountIds(tx, ORG, "bill", keys);
      expect(seenQueries.length).toBe(1);

      // Drop one mapping so tier 2 has to run — still one extra query total,
      // not one per key.
      await tx
        .delete(categoryMappings)
        .where(
          and(
            eq(categoryMappings.organizationId, ORG),
            eq(categoryMappings.mappingType, "bill"),
            eq(categoryMappings.sourceKey, "default_expense"),
          ),
        );

      seenQueries.length = 0;
      await resolveMappedAccountIds(tx, ORG, "bill", keys);
      expect(seenQueries.length).toBe(2);
    });
  });

  // ---- Posting paths and reporting ---------------------------------------

  it("throws an actionable error when a posting path cannot resolve", async () => {
    const EMPTY = crypto.randomUUID();
    await withOrgContext(EMPTY, async (tx) => {
      const row = mappingRowFor("bill", "accounts_payable")!;
      await expect(requireMappedAccountId(tx, EMPTY, "bill", "accounts_payable")).rejects.toThrow(
        UnmappedAccountError,
      );
      await expect(requireMappedAccountId(tx, EMPTY, "bill", "accounts_payable")).rejects.toThrow(
        row.label,
      );
    });
  });

  it("returns the mapped account plus its descendants for reporting", async () => {
    await withOrgContext(ORG, async (tx) => {
      const apId = await resolveMappedAccountId(tx, ORG, "bill", "accounts_payable");
      expect(apId).toBeTruthy();

      const [child] = await tx
        .insert(accounts)
        .values({
          organizationId: ORG,
          name: "Payables Sub-account",
          accountType: "liability",
          subtype: "accounts_payable",
          parentId: apId,
          accountNumber: "20991",
        })
        .returning({ id: accounts.id });

      const family = await mappedAccountFamilyIds(tx, ORG, "bill", "accounts_payable");
      expect(family).toContain(apId);
      expect(family).toContain(child.id);
    });
  });

  it("returns an empty family rather than a wrong one when nothing resolves", async () => {
    const EMPTY = crypto.randomUUID();
    await withOrgContext(EMPTY, async (tx) => {
      expect(await mappedAccountFamilyIds(tx, EMPTY, "bill", "accounts_payable")).toEqual([]);
    });
  });

  it("covers every registered mapping key after a preset apply", async () => {
    await withOrgContext(ORG, async (tx) => {
      for (const { mappingType, sourceKey } of allMappingKeys()) {
        expect(await resolveMappedAccountId(tx, ORG, mappingType, sourceKey)).toBeTruthy();
      }
    });
  });
});
