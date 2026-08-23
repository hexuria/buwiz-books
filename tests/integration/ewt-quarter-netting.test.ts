import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { taxWithholdingPayments } from "../../src/db/schema/tax-stage-remainder";
import { COA_PRESETS } from "../../src/lib/coa/presets";
import { planCoaPreset } from "../../src/lib/coa/plan-preset";
import { executeCoaPlan } from "../../src/lib/coa/execute-plan";
import { loadCoaSnapshot } from "../../src/lib/coa/snapshot";
import { requirePhAccount } from "../../src/lib/tax/ph-account-resolver";
import { postEwtRemittance } from "../../src/lib/tax/post-ewt-remittance";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The quarterly 1601-EQ covers the WHOLE quarter, but months 1 and 2 were
 * already remitted on their own 0619-E journals. Before the netting, the
 * month-3 posting debited the full quarter AGAIN: ₱10k+₱10k on 0619-E, then
 * ₱30k on the EQ — EWT payable ended at −₱20k and cash was credited ₱50k for
 * ₱30k of liability. reconcileQuarter nets against what was ACTUALLY posted,
 * so a skipped monthly remittance is still correctly owed on the quarterly
 * return.
 */
describeDb("EWT quarter netting", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `ewt-net-${randomUUID()}`;
  const USER = randomUUID();

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "EWT Netting Org",
      slug: `ewt-net-${randomUUID().slice(0, 8)}`,
    });
    // philippines_smb provides ph_ewt_payable and the bank mapping the poster
    // resolves.
    await db.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(drizzleSql`SELECT set_config('app.current_organization_id', ${ORG}, true)`);
      const snapshot = await loadCoaSnapshot(tx, ORG);
      const plan = planCoaPreset(snapshot, COA_PRESETS.philippines_smb, {
        onConflict: "renumber",
      });
      await executeCoaPlan(tx, ORG, plan, "test");
    });

    // ₱10,000 withheld in each month of Q1 2026.
    for (const [start, end] of [
      ["2026-01-01", "2026-01-31"],
      ["2026-02-01", "2026-02-28"],
      ["2026-03-01", "2026-03-31"],
    ]) {
      await db.insert(taxWithholdingPayments).values({
        organizationId: ORG,
        payeeTin: "123456789",
        payeeRegisteredName: "SUPPLIER CORP",
        periodStart: start,
        periodEnd: end,
        atc: "WC160",
        incomePayment: "200000.00",
        taxWithheld: "10000.00",
      });
    }
  });

  afterAll(async () => {
    await sql.end();
  });

  it("the 1601-EQ posts only what the 0619-Es left unremitted, and the payable nets to zero", async () => {
    const jan = await db.transaction((tx: any) =>
      postEwtRemittance(tx, { organizationId: ORG, userId: USER, month: 1, year: 2026 }),
    );
    expect(jan.formCode).toBe("0619E");
    expect(Number(jan.taxWithheld)).toBe(10000);

    const feb = await db.transaction((tx: any) =>
      postEwtRemittance(tx, { organizationId: ORG, userId: USER, month: 2, year: 2026 }),
    );
    expect(Number(feb.taxWithheld)).toBe(10000);

    const eq1601 = await db.transaction((tx: any) =>
      postEwtRemittance(tx, { organizationId: ORG, userId: USER, month: 3, year: 2026 }),
    );
    expect(eq1601.formCode).toBe("1601EQ");
    // The quarter withheld ₱30,000; ₱20,000 was already remitted monthly.
    expect(Number(eq1601.taxWithheld)).toBe(10000);

    // The ledger proof: EWT payable was credited ₱30k by withholding and is
    // debited ₱10k+₱10k+₱10k by the three remittances — net zero, where the
    // old behavior left it at −₱20,000.
    const ewtAccountId = await requirePhAccount(db, ORG, "ph_ewt_payable");
    const [movement] = await db
      .select({
        debits: drizzleSql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .where(eq(journalLines.accountId, ewtAccountId));
    expect(Number(movement.debits)).toBe(30000);
  });

  it("replaying the quarterly posting is refused by idempotency, not double-posted", async () => {
    await expect(
      db.transaction((tx: any) =>
        postEwtRemittance(tx, { organizationId: ORG, userId: USER, month: 3, year: 2026 }),
      ),
    ).rejects.toThrow();
  });
});
