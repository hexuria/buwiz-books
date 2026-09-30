/**
 * Missing Receipt compares in the functional currency.
 *
 * The book rule used to compare the candidate's ORIGINAL-currency expense
 * total with a threshold expressed in the functional currency: a EUR 70
 * receipt at 1.10 (USD 77) slipped under a USD 75 threshold, and a JPY
 * 10,000 one (about USD 67) tripped it. Both the submission path and a
 * reviewer's correction must now convert through the candidate's own rate,
 * in exact decimals, before comparing.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withOrgContext, type DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { organization, user } from "@/db/schema/auth";
import { organizationAccountingSettings, reviewFindings } from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { createTransactionCandidate } from "@/lib/inbox/service";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

interface Tenant {
  orgId: string;
  userId: string;
  bankId: string;
  expenseId: string;
  vendorId: string;
}

async function createTenant(): Promise<Tenant> {
  const suffix = randomUUID();
  const orgId = `receipt-fx-org-${suffix}`;
  const userId = `receipt-fx-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Receipt FX Owner",
    email: `${suffix}@receipt-fx.test`,
    emailVerified: true,
  });
  await db.insert(organization).values({ id: orgId, name: "Receipt FX Co", slug: suffix });
  // USD books, and the default USD 75 receipt threshold from the settings row.
  await db.insert(organizationAccountingSettings).values({ organizationId: orgId });
  const [bank, expense] = await db
    .insert(accounts)
    .values([
      {
        organizationId: orgId,
        accountNumber: "10992",
        name: "Receipt FX Bank",
        accountType: "asset",
        subtype: "bank_accounts",
      },
      {
        organizationId: orgId,
        accountNumber: "61992",
        name: "Receipt FX Travel",
        accountType: "expense",
        subtype: "travel",
      },
    ])
    .returning();
  const [vendor] = await db
    .insert(parties)
    .values({ organizationId: orgId, name: "Receipt FX Vendor", partyType: "vendor" })
    .returning();
  return { orgId, userId, bankId: bank.id, expenseId: expense.id, vendorId: vendor.id };
}

function asTenant<T>(tenant: Tenant, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return withOrgContext(tenant.orgId, tenant.userId, "owner", fn);
}

async function submit(tenant: Tenant, amount: string, currency: string, rate: string) {
  return asTenant(tenant, (tx) =>
    createTransactionCandidate(
      { db: tx, orgId: tenant.orgId, userId: tenant.userId, role: "owner" },
      {
        transactionDate: "2026-09-14",
        transactionType: "pay_out",
        partyId: tenant.vendorId,
        originalCurrency: currency,
        exchangeRate: rate,
        lines: [
          { accountId: tenant.expenseId, debit: amount },
          { accountId: tenant.bankId, credit: amount },
        ],
      },
    ),
  );
}

async function receiptFindings(inboxItemId: string) {
  return db
    .select()
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.inboxItemId, inboxItemId),
        eq(reviewFindings.ruleKey, "missing_receipt"),
        eq(reviewFindings.state, "open"),
      ),
    );
}

describeDb("Missing Receipt in the functional currency", () => {
  it("flags EUR 70 at 1.10 (USD 77) and passes JPY 10,000 at 0.0067 (USD 67)", async () => {
    const tenant = await createTenant();

    const eur = await submit(tenant, "70.00", "EUR", "1.1");
    const [eurFinding] = await receiptFindings(eur.inboxItem.id);
    expect(eurFinding).toMatchObject({
      impact: "blocking",
      message: "Attach a receipt for expenses over USD 75.00.",
      evidence: {
        expenseTotal: "77",
        threshold: "75.00000000",
        thresholdCurrency: "USD",
        originalExpenseTotal: "70",
        originalCurrency: "EUR",
        // The rate as stored with the paper (decimal(20,10)).
        exchangeRate: "1.1000000000",
      },
    });

    const jpy = await submit(tenant, "10000", "JPY", "0.0067");
    expect(await receiptFindings(jpy.inboxItem.id)).toEqual([]);

    // Same-currency papers are compared exactly as before.
    const usd = await submit(tenant, "75.01", "USD", "1");
    const [usdFinding] = await receiptFindings(usd.inboxItem.id);
    expect(usdFinding.evidence).toEqual({
      expenseTotal: "75.01",
      threshold: "75.00000000",
      thresholdCurrency: "USD",
      ruleSet: { source: "live", snapshotId: null, routineId: null },
    });
  });

  it("re-evaluates a reviewer's switch to a foreign currency the same way", async () => {
    const tenant = await createTenant();
    // USD 70: under the threshold, so nothing to attach yet.
    const submitted = await submit(tenant, "70.00", "USD", "1");
    expect(await receiptFindings(submitted.inboxItem.id)).toEqual([]);

    // The reviewer notices the paper was in euros.
    await asTenant(tenant, (tx) =>
      correctInboxCandidate(
        { db: tx, orgId: tenant.orgId, userId: tenant.userId, role: "owner" },
        {
          inboxItemId: submitted.inboxItem.id,
          expectedRevision: submitted.inboxItem.candidateRevision,
          expectedLockVersion: submitted.inboxItem.lockVersion,
          transactionDate: "2026-09-14",
          transactionType: "pay_out",
          partyId: tenant.vendorId,
          originalCurrency: "EUR",
          exchangeRate: "1.1",
          lines: [
            { accountId: tenant.expenseId, debit: "70.00" },
            { accountId: tenant.bankId, credit: "70.00" },
          ],
        },
      ),
    );
    const [finding] = await receiptFindings(submitted.inboxItem.id);
    expect(finding).toMatchObject({
      impact: "blocking",
      evidence: { expenseTotal: "77", originalExpenseTotal: "70", originalCurrency: "EUR" },
    });
  });
});
