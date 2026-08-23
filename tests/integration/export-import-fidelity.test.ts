import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { accounts } from "../../src/db/schema/accounts";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { parties } from "../../src/db/schema/parties";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Program 2 P4 — export/import fidelity, pinned at the data layer the route
 * now uses. The audit found: banks exported a raw ledgerAccountId that the
 * import silently dropped; party exports omitted taxId/bank/mailing/default
 * account; and executeImport never applied the row schemas at all. The
 * route logic is inline server-fn code, so this suite drives the exact
 * resolvable-reference semantics (number-then-name, org-scoped) the import
 * uses, and the wiring test pins the route shapes.
 */
describeDb("export/import fidelity", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `exp-fid-${randomUUID()}`;
  const FOREIGN = `exp-fid-f-${randomUUID()}`;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    for (const [id, name] of [
      [ORG, "Fidelity Org"],
      [FOREIGN, "Fidelity Foreign"],
    ] as const) {
      await db.insert(organization).values({ id, name, slug: `ef-${randomUUID().slice(0, 10)}` });
    }
  });
  afterAll(async () => {
    await sql.end();
  });

  it("resolves account references by number then name, org-scoped only", async () => {
    const [own] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Fidelity Checking Ledger",
        accountNumber: "11250",
        accountType: "asset",
        subtype: "bank_accounts",
      })
      .returning({ id: accounts.id });
    // Same number in ANOTHER org must never satisfy this org's reference.
    await db.insert(accounts).values({
      organizationId: FOREIGN,
      name: "Their Checking Ledger",
      accountNumber: "11250",
      accountType: "asset",
      subtype: "bank_accounts",
    });

    // The exact resolver query shape the import uses: number first.
    const [byNumber] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG), eq(accounts.accountNumber, "11250")))
      .limit(1);
    expect(byNumber.id).toBe(own.id);

    const [byName] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, ORG), eq(accounts.name, "Fidelity Checking Ledger")))
      .limit(1);
    expect(byName.id).toBe(own.id);
  });

  it("bank wire fields and the ledger link survive a write/read round-trip", async () => {
    const [ledger] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Wire Ledger",
        accountNumber: "11260",
        accountType: "asset",
        subtype: "bank_accounts",
      })
      .returning({ id: accounts.id });

    await db.insert(financialAccounts).values({
      organizationId: ORG,
      accountName: "Fidelity Operating",
      accountType: "checking",
      isManual: true,
      connectionStatus: "disconnected",
      accountNumber: "000123456789",
      routingNumber: "021000021",
      swiftCode: "BOFAUS3N",
      iban: "PH12345678901234567890",
      ledgerAccountId: ledger.id,
    });

    // The export projection: wire fields + the RESOLVABLE pair via join.
    const [row] = await db
      .select({
        accountNumber: financialAccounts.accountNumber,
        routingNumber: financialAccounts.routingNumber,
        swiftCode: financialAccounts.swiftCode,
        iban: financialAccounts.iban,
        ledgerAccountNumber: accounts.accountNumber,
        ledgerAccountName: accounts.name,
      })
      .from(financialAccounts)
      .leftJoin(accounts, eq(financialAccounts.ledgerAccountId, accounts.id))
      .where(
        and(
          eq(financialAccounts.organizationId, ORG),
          eq(financialAccounts.accountName, "Fidelity Operating"),
        ),
      );
    expect(row).toMatchObject({
      accountNumber: "000123456789",
      routingNumber: "021000021",
      swiftCode: "BOFAUS3N",
      iban: "PH12345678901234567890",
      ledgerAccountNumber: "11260",
      ledgerAccountName: "Wire Ledger",
    });
  });

  it("party default-account references export as the resolvable pair", async () => {
    const [expense] = await db
      .insert(accounts)
      .values({
        organizationId: ORG,
        name: "Vendor Default Expense",
        accountNumber: "61250",
        accountType: "expense",
      })
      .returning({ id: accounts.id });
    await db.insert(parties).values({
      organizationId: ORG,
      name: "Fidelity Vendor",
      partyType: "vendor",
      taxId: "12-3456789",
      bankRoutingNumber: "021000021",
      bankAccountNumber: "987654321",
      creditLimit: "5000.00",
      defaultAccountId: expense.id,
    });

    const [row] = await db
      .select({
        taxId: parties.taxId,
        bankRoutingNumber: parties.bankRoutingNumber,
        creditLimit: parties.creditLimit,
        defaultAccountNumber: accounts.accountNumber,
        defaultAccountName: accounts.name,
      })
      .from(parties)
      .leftJoin(accounts, eq(parties.defaultAccountId, accounts.id))
      .where(and(eq(parties.organizationId, ORG), eq(parties.name, "Fidelity Vendor")));
    expect(row).toMatchObject({
      taxId: "12-3456789",
      creditLimit: "5000.00",
      defaultAccountNumber: "61250",
      defaultAccountName: "Vendor Default Expense",
    });
  });
});
