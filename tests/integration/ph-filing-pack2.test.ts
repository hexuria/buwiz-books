// ============================================================================
// Program 2 P13 — pack-2 M cluster, database-backed pieces:
//
//   • loadBrackets resolves OVERLAPPING dataset generations through
//     pickInForce — the most recent issuance wins per bracket, instead of
//     returning both generations' rows interleaved.
//   • EWT remittance stamps remittedAt on every covered payment, and a
//     payment captured AFTER its period was remitted rides along with the
//     NEXT remittance (it used to be owed forever and remitted never).
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { categoryMappings } from "../../src/db/schema/category-mappings";
import { journalHeaders } from "../../src/db/schema/journals";
import { taxReferenceDatasets, taxWithholdingTables } from "../../src/db/schema/tax-reference";
import { taxWithholdingPayments } from "../../src/db/schema/tax-stage-remainder";
import { loadBrackets } from "../../src/lib/tax/payroll-run-service";
import { postEwtRemittance } from "../../src/lib/tax/post-ewt-remittance";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("loadBrackets dataset-generation resolution", () => {
  let db: any;
  let sql: postgres.Sql;
  const GEN_A = `test-gen-a-${randomUUID().slice(0, 8)}`;
  const GEN_B = `test-gen-b-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(taxReferenceDatasets).values([
      { version: GEN_A, sourceNote: "test fixture", publishedAt: new Date("2020-01-01T00:00:00Z") },
      { version: GEN_B, sourceNote: "test fixture", publishedAt: new Date("2023-01-01T00:00:00Z") },
    ]);
    // Two generations of the same weekly table, BOTH in force (the old one
    // was never end-dated) — the exact overlap the fix resolves.
    await db.insert(taxWithholdingTables).values([
      ...[0, 1].map((bracketIndex) => ({
        datasetVersion: GEN_A,
        annex: "D",
        payrollPeriod: "weekly",
        bracketIndex,
        floorAmount: bracketIndex === 0 ? "0" : "10000",
        prescribedTax: "0",
        rateBps: 1000,
        effectiveFrom: "2020-01-01",
        effectiveTo: null,
        citation: "test fixture",
      })),
      ...[0, 1].map((bracketIndex) => ({
        datasetVersion: GEN_B,
        annex: "D",
        payrollPeriod: "weekly",
        bracketIndex,
        floorAmount: bracketIndex === 0 ? "0" : "10000",
        prescribedTax: "0",
        rateBps: 2000,
        effectiveFrom: "2023-01-01",
        effectiveTo: null,
        citation: "test fixture",
      })),
    ]);
  });

  afterAll(async () => {
    await db
      .delete(taxWithholdingTables)
      .where(inArray(taxWithholdingTables.datasetVersion, [GEN_A, GEN_B]));
    await db
      .delete(taxReferenceDatasets)
      .where(inArray(taxReferenceDatasets.version, [GEN_A, GEN_B]));
    await sql.end();
  });

  it("returns ONE row per bracket — the most recent in-force issuance", async () => {
    const brackets = await loadBrackets(db, "weekly", "2026-01-15");
    const mine = brackets.filter((b: any) => b.rateBps === 1000 || b.rateBps === 2000);
    expect(mine.length).toBe(2);
    for (const bracket of mine) expect(bracket.rateBps).toBe(2000);
  });

  it("an as-of before the newer generation still picks the old one", async () => {
    const brackets = await loadBrackets(db, "weekly", "2021-06-30");
    const mine = brackets.filter((b: any) => b.rateBps === 1000 || b.rateBps === 2000);
    expect(mine.length).toBe(2);
    for (const bracket of mine) expect(bracket.rateBps).toBe(1000);
  });
});

describeDb("EWT remittance covers late-captured payments", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `ewt-remit-${randomUUID()}`;
  const USER = "user-ewt-remit";

  async function seedPayment(periodStart: string, periodEnd: string, withheld: string) {
    const [row] = await db
      .insert(taxWithholdingPayments)
      .values({
        organizationId: ORG,
        payeeTin: "123456789",
        payeeRegisteredName: "SUPPLIER CORP",
        periodStart,
        periodEnd,
        atc: "WC010",
        incomePayment: "100000",
        taxWithheld: withheld,
      })
      .returning({ id: taxWithholdingPayments.id });
    return row.id as string;
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "EWT Remit Org",
      slug: `ewt-${randomUUID().slice(0, 8)}`,
    });
    const [ewt] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Expanded Withholding Tax Payable",
        accountNumber: "21600",
        accountType: "liability",
      })
      .returning({ id: accounts.id });
    void ewt;
    const [cash] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Checking",
        accountNumber: "11100",
        accountType: "asset",
        subtype: "bank_accounts",
      })
      .returning({ id: accounts.id });
    await db.insert(categoryMappings).values({
      organizationId: ORG,
      mappingType: "bank",
      sourceKey: "checking",
      targetCategoryId: cash.id,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("stamps covered payments and sweeps stragglers into the next remittance", async () => {
    // July payment, remitted by July's 0619-E.
    const julyId = await seedPayment("2026-07-01", "2026-07-31", "10000");
    const july = await db.transaction((tx: any) =>
      postEwtRemittance(tx, { organizationId: ORG, userId: USER, month: 7, year: 2026 }),
    );
    expect(Number(july.taxWithheld)).toBeCloseTo(10000, 2);

    const [julyRow] = await db
      .select({ remittedAt: taxWithholdingPayments.remittedAt })
      .from(taxWithholdingPayments)
      .where(eq(taxWithholdingPayments.id, julyId));
    expect(julyRow.remittedAt).not.toBeNull();

    // A July payment captured AFTER the July remittance — the old code never
    // remitted it. It must ride along with August's 0619-E.
    const lateJulyId = await seedPayment("2026-07-01", "2026-07-31", "2500");
    const augustId = await seedPayment("2026-08-01", "2026-08-31", "5000");

    const august = await db.transaction((tx: any) =>
      postEwtRemittance(tx, { organizationId: ORG, userId: USER, month: 8, year: 2026 }),
    );
    expect(Number(august.taxWithheld)).toBeCloseTo(7500, 2);

    const rows = await db
      .select({ id: taxWithholdingPayments.id, remittedAt: taxWithholdingPayments.remittedAt })
      .from(taxWithholdingPayments)
      .where(inArray(taxWithholdingPayments.id, [lateJulyId, augustId]));
    for (const row of rows) expect(row.remittedAt).not.toBeNull();

    const [header] = await db
      .select({ memo: journalHeaders.memo, totalAmount: journalHeaders.totalAmount })
      .from(journalHeaders)
      .where(eq(journalHeaders.id, august.journalHeaderId));
    expect(header.memo).toMatch(/late-captured/);
    expect(Number(header.totalAmount)).toBeCloseTo(7500, 2);
  });
});
