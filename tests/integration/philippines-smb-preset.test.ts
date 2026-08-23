import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { COA_PRESETS } from "../../src/lib/coa/presets";
import { planCoaPreset } from "../../src/lib/coa/plan-preset";
import { executeCoaPlan } from "../../src/lib/coa/execute-plan";
import { loadCoaSnapshot } from "../../src/lib/coa/snapshot";
import { allMappingKeys } from "../../src/lib/coa/mapping-registry";
import { resolveMappedAccountId } from "../../src/lib/coa/resolve-mapped-account";
import { PH_CHART } from "../../src/lib/tax/ph-chart";
import { requirePhAccount, requirePhAccounts } from "../../src/lib/tax/ph-account-resolver";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The audit's first critical finding: PH_CHART froze 20 control accounts and
 * requirePhAccount resolved them by number, but NO preset created them — the
 * error message even named a `philippines_smb` preset that did not exist, and
 * every PH posting path (payroll, CWT receivable, EWT remittance, the 1601-C
 * reconciliation) was dead on arrival.
 *
 * This pins the preset end to end: applying it makes every frozen account
 * resolvable, the payroll posting key set resolves as a batch, and the
 * bank/bill/invoice mapping contract every preset must satisfy still holds.
 */
describeDb("philippines_smb preset", () => {
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
    ORG = randomUUID();
    await withOrgContext(ORG, async (tx) => {
      const snapshot = await loadCoaSnapshot(tx, ORG);
      const plan = planCoaPreset(snapshot, COA_PRESETS.philippines_smb, {
        onConflict: "renumber",
      });
      await executeCoaPlan(tx, ORG, plan, "test");
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("makes every frozen PH control account resolvable by its chart key", async () => {
    await withOrgContext(ORG, async (tx) => {
      for (const entry of PH_CHART) {
        // requirePhAccount returns the account ID (throws when absent) — the
        // resolver looks the row up BY the frozen number, so a non-throwing
        // resolve IS the number assertion.
        const accountId = await requirePhAccount(tx, ORG, entry.key);
        expect(accountId, entry.key).toBeTruthy();
      }
    });
  });

  it("resolves the payroll posting key set in one batch", async () => {
    await withOrgContext(ORG, async (tx) => {
      const accounts = await requirePhAccounts(tx, ORG, [
        "salaries",
        "employer_payroll_taxes",
        "ph_wtc_payable",
        "ph_sss_payable",
        "ph_philhealth_payable",
        "ph_pagibig_payable",
        "payroll_liabilities",
        "ph_net_pay_payable",
      ]);
      for (const [key, account] of Object.entries(accounts)) {
        expect(account, key).toBeTruthy();
      }
    });
  });

  it("resolves the CWT and EWT posting accounts", async () => {
    await withOrgContext(ORG, async (tx) => {
      expect(await requirePhAccount(tx, ORG, "ph_cwt_receivable")).toBeTruthy();
      expect(await requirePhAccount(tx, ORG, "ph_ewt_payable")).toBeTruthy();
    });
  });

  it("still satisfies the bank/bill/invoice mapping contract every preset owes", async () => {
    await withOrgContext(ORG, async (tx) => {
      for (const { mappingType, sourceKey } of allMappingKeys()) {
        expect(
          await resolveMappedAccountId(tx, ORG, mappingType, sourceKey),
          `${mappingType}:${sourceKey}`,
        ).toBeTruthy();
      }
    });
  });
});
