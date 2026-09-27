/**
 * A Bills-editor bill is saved for review and its accrual waits in the Inbox. A reviewer may
 * correct that entry before approving it — and approval used to post the corrected accrual while
 * leaving the bill with its original amount, balance, lines and vendor. Approval now accrues the
 * bill through the bill core, which brings the bill in line with what posts, or refuses with
 * nothing written.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { activityLogs } from "@/db/schema/activity-logs";
import { member, organization, user } from "@/db/schema/auth";
import { billLineItems, bills } from "@/db/schema/bills";
import { dimensions } from "@/db/schema/dimensions";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { parseMoneyToScaled, sumMoney } from "@/lib/inbox/money";
import {
  correctInboxCandidate,
  type CandidateCorrectionLineInput,
  type CorrectInboxCandidateInput,
} from "@/lib/inbox/candidate-correction";
import { approveInboxItem, BILL_PAID_MESSAGE, type ApproveInboxResult } from "@/lib/inbox/service";
import { submitBillForReviewCore } from "@/lib/posting/bill-submission";
import { BILL_ACCRUAL_SHAPE_MESSAGE, BILL_SUB_CENT_MESSAGE } from "@/lib/posting/posting-lines";

const BILL_DATE = "2026-07-20";

async function setupOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Bill Sync Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Bill Sync Organization",
    slug: `${prefix}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId,
    organizationId: orgId,
    role: "owner",
  });
  const [bank, supplies, postage, ap] = await db
    .insert(accounts)
    .values([
      {
        organizationId: orgId,
        accountNumber: "10000",
        name: "Operating Bank",
        accountType: "asset",
        subtype: "checking",
      },
      {
        organizationId: orgId,
        accountNumber: "61000",
        name: "Office Supplies",
        accountType: "expense",
        subtype: "office_supplies",
      },
      {
        organizationId: orgId,
        accountNumber: "61500",
        name: "Postage",
        accountType: "expense",
        subtype: "office_supplies",
      },
      {
        organizationId: orgId,
        accountNumber: "21000",
        name: "Accounts Payable",
        accountType: "liability",
        subtype: "accounts_payable",
      },
    ])
    .returning();
  const [department, location] = await db
    .insert(dimensions)
    .values([
      { organizationId: orgId, dimensionType: "department", name: "Operations" },
      { organizationId: orgId, dimensionType: "location", name: "Main Office" },
    ])
    .returning();
  const [vendor, correctedVendor] = await db
    .insert(parties)
    .values([
      { organizationId: orgId, name: "Paper Supply Co", partyType: "vendor" },
      { organizationId: orgId, name: "Paper Supply Co (Manila)", partyType: "vendor" },
    ])
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
    missingReceiptThreshold: "100000",
  });
  // An editor bill has no invoice document yet; that rule is not what these tests are about.
  const [missingInvoice] = await db
    .select({ id: reviewRuleDefinitions.id })
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, "missing_invoice"));
  await db.insert(reviewRuleConfigs).values({
    organizationId: orgId,
    definitionId: missingInvoice.id,
    enabled: false,
    impact: "blocking",
    updatedBy: userId,
  });
  return {
    orgId,
    userId,
    bank,
    supplies,
    postage,
    ap,
    department,
    location,
    vendor,
    correctedVendor,
  };
}

type Fixture = Awaited<ReturnType<typeof setupOrganization>>;

/** The Bills editor's save: a bill in review plus its accrual waiting in the Inbox. */
async function submitEditorBill(fixture: Fixture) {
  const submitted = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    submitBillForReviewCore(
      tx,
      fixture.orgId,
      { type: "user", userId: fixture.userId },
      {
        idempotencyKey: randomUUID(),
        vendorId: fixture.vendor.id,
        billNumber: "PSC-88",
        billDate: BILL_DATE,
        dueDate: "2026-08-19",
        memo: "Toner and stamps",
        status: "in_review",
        lineItems: [
          {
            description: "Toner cartridges",
            amount: "45.50",
            accountId: fixture.supplies.id,
            departmentId: fixture.department.id,
            locationId: fixture.location.id,
          },
          { description: "Stamps", amount: "20.00", accountId: fixture.postage.id },
        ],
      },
    ),
  );
  if (submitted.deduplicated) throw new Error("A first submission cannot be a replay.");
  return submitted;
}

async function inboxItem(itemId: string) {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, itemId));
  return item;
}

/** A reviewer's correction in the Inbox. */
async function correct(
  fixture: Fixture,
  itemId: string,
  lines: CandidateCorrectionLineInput[],
  overrides: Partial<CorrectInboxCandidateInput> = {},
) {
  const item = await inboxItem(itemId);
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    correctInboxCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        inboxItemId: itemId,
        expectedRevision: item.candidateRevision,
        expectedLockVersion: item.lockVersion,
        transactionDate: BILL_DATE,
        transactionType: "journal",
        memo: "Toner and stamps",
        referenceNumber: "PSC-88",
        partyId: fixture.vendor.id,
        originalCurrency: "USD",
        exchangeRate: "1",
        lines,
        ...overrides,
      },
    ),
  );
}

async function approve(fixture: Fixture, itemId: string): Promise<ApproveInboxResult> {
  const item = await inboxItem(itemId);
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    approveInboxItem(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        inboxItemId: itemId,
        expectedRevision: item.candidateRevision,
        expectedLockVersion: item.lockVersion,
      },
    ),
  );
}

function assertApproved(
  result: ApproveInboxResult,
): asserts result is Extract<ApproveInboxResult, { approvalOutcome: "approved" }> {
  if (result.approvalOutcome !== "approved") throw new Error(result.message);
}

async function billRow(billId: string) {
  const [bill] = await db.select().from(bills).where(eq(bills.id, billId));
  return bill;
}

async function billLines(billId: string) {
  return db
    .select()
    .from(billLineItems)
    .where(eq(billLineItems.billId, billId))
    .orderBy(asc(billLineItems.sortOrder));
}

async function orgJournals(orgId: string) {
  return db.select().from(journalHeaders).where(eq(journalHeaders.organizationId, orgId));
}

/**
 * What A/P aging reads for one bill: the payable balance on the bill's own posted journals (found
 * through the source-document pair) and the bill's vendor.
 */
async function agingBalance(fixture: Fixture, billId: string) {
  const [row] = await db
    .select({
      vendorId: bills.vendorId,
      balance: sql<string>`(coalesce(sum(${journalLines.credit}), 0) - coalesce(sum(${journalLines.debit}), 0))::text`,
    })
    .from(bills)
    .innerJoin(
      journalHeaders,
      and(
        eq(journalHeaders.sourceDocumentId, bills.id),
        eq(journalHeaders.sourceDocumentType, "bill"),
        eq(journalHeaders.status, "posted"),
      ),
    )
    .innerJoin(journalLines, eq(journalLines.journalHeaderId, journalHeaders.id))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(bills.id, billId),
        eq(bills.organizationId, fixture.orgId),
        eq(accounts.subtype, "accounts_payable"),
      ),
    )
    .groupBy(bills.vendorId);
  return row;
}

/** Exact, at the ledger's 8-decimal scale. */
const exact = (amount: string) => parseMoneyToScaled(amount);

describe("approving a Bills-editor bill corrected in the Inbox", () => {
  it("posts the corrected accrual and brings the bill in line with it, to the cent", async () => {
    const fixture = await setupOrganization("bill-sync");
    const submitted = await submitEditorBill(fixture);
    expect(await billRow(submitted.id)).toMatchObject({ amount: "65.50", balanceDue: "65.50" });

    await correct(
      fixture,
      submitted.inboxItemId,
      [
        {
          accountId: fixture.supplies.id,
          debit: "47.25",
          lineDescription: "Toner cartridges (2 packs)",
          departmentId: fixture.department.id,
          locationId: fixture.location.id,
        },
        { accountId: fixture.postage.id, debit: "12.10", lineDescription: "Stamps" },
        { accountId: fixture.ap.id, credit: "59.35", lineDescription: "A/P: PSC-90" },
      ],
      {
        partyId: fixture.correctedVendor.id,
        referenceNumber: "PSC-90",
        transactionDate: "2026-07-22",
      },
    );

    const approval = await approve(fixture, submitted.inboxItemId);
    assertApproved(approval);
    expect(approval.billId).toBe(submitted.id);

    const bill = await billRow(submitted.id);
    expect(bill).toMatchObject({
      amount: "59.35",
      balanceDue: "59.35",
      vendorId: fixture.correctedVendor.id,
      billNumber: "PSC-90",
      billDate: "2026-07-22",
      // Terms stay as set in the Bills editor.
      dueDate: "2026-08-19",
      status: "awaiting_payment",
      journalHeaderId: approval.journalHeaderId,
      approverId: fixture.userId,
    });
    const lines = await billLines(submitted.id);
    expect(lines).toEqual([
      expect.objectContaining({
        description: "Toner cartridges (2 packs)",
        amount: "47.25",
        accountId: fixture.supplies.id,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
        sortOrder: 0,
      }),
      expect.objectContaining({
        description: "Stamps",
        amount: "12.10",
        accountId: fixture.postage.id,
        sortOrder: 1,
      }),
    ]);

    const journals = await orgJournals(fixture.orgId);
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      id: approval.journalHeaderId,
      status: "posted",
      transactionDate: "2026-07-22",
      partyId: fixture.correctedVendor.id,
      referenceNumber: "PSC-90",
      sourceDocumentType: "bill",
      sourceDocumentId: bill.id,
      totalAmount: "59.35000000",
    });
    const posted = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, approval.journalHeaderId))
      .orderBy(asc(journalLines.sortOrder));
    const payable = posted.find((line) => line.accountId === fixture.ap.id)!;
    expect(payable).toMatchObject({ credit: "59.35000000", partyId: fixture.correctedVendor.id });
    const debitLines = posted.filter((line) => line.debit !== null);

    // Bill amount, balance, bill lines and the accrual all agree to the cent.
    const payableCredit = exact(payable.credit!);
    expect(exact(bill.amount)).toBe(payableCredit);
    expect(exact(bill.balanceDue)).toBe(payableCredit);
    expect(exact(sumMoney(lines.map((line) => line.amount)))).toBe(payableCredit);
    expect(exact(sumMoney(debitLines.map((line) => line.debit)))).toBe(payableCredit);

    // A/P aging reads the corrected payable, under the corrected vendor.
    expect(await agingBalance(fixture, bill.id)).toEqual({
      vendorId: fixture.correctedVendor.id,
      balance: "59.35000000",
    });

    const [activity] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.organizationId, fixture.orgId),
          eq(activityLogs.entityType, "bill"),
          eq(activityLogs.action, "accrued"),
        ),
      );
    expect(activity.changes).toMatchObject({
      journalHeaderId: approval.journalHeaderId,
      before: { amount: "65.50", vendorId: fixture.vendor.id, billNumber: "PSC-88" },
      after: { amount: "59.35", vendorId: fixture.correctedVendor.id, billNumber: "PSC-90" },
      source: "inbox",
    });
  });

  // Each case gets its own organization: identical editor bills in one org would (rightly) be
  // held as possible duplicates before approval ever reached the bill. A bill deleted, voided or
  // already accrued in Bills is refused the same way; inbox-bill-posting.test.ts covers those.
  it("refuses to accrue a bill with payments recorded, and writes nothing", async () => {
    const fixture = await setupOrganization("bill-sync-paid");
    // Paying a bill in Bills posts its accrual first, so that bill is refused as already accrued.
    // This is the shape that check cannot see: payments on a bill with no accrual linked (an
    // imported or legacy row). Rewriting its amount would strand what was already paid.
    const paid = await submitEditorBill(fixture);
    await db
      .update(bills)
      .set({ amountPaid: "10.00", balanceDue: "55.50" })
      .where(eq(bills.id, paid.id));
    await expect(approve(fixture, paid.inboxItemId)).rejects.toThrow(BILL_PAID_MESSAGE);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
    expect(await billRow(paid.id)).toMatchObject({
      amount: "65.50",
      amountPaid: "10.00",
      balanceDue: "55.50",
      status: "in_review",
      journalHeaderId: null,
    });
    expect(await billLines(paid.id)).toHaveLength(2);
    expect((await inboxItem(paid.inboxItemId)).state).toBe("ready_for_review");
  });

  it("refuses a sub-cent correction instead of rounding it into the bill", async () => {
    const fixture = await setupOrganization("bill-sync-subcent");
    const subCent = await submitEditorBill(fixture);
    await correct(fixture, subCent.inboxItemId, [
      {
        accountId: fixture.supplies.id,
        debit: "45.505",
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.postage.id, debit: "20" },
      { accountId: fixture.ap.id, credit: "65.505" },
    ]);
    await expect(approve(fixture, subCent.inboxItemId)).rejects.toThrow(BILL_SUB_CENT_MESSAGE);
    expect(await billRow(subCent.id)).toMatchObject({ amount: "65.50", journalHeaderId: null });
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
  });

  it("refuses a correction that is no longer a bill instead of detaching the bill", async () => {
    const fixture = await setupOrganization("bill-sync-shape");
    // Booked against the bank it is not a payable any more: a bill would say "owed" while the
    // ledger said "paid". Refused, and the bill keeps its lines.
    const paidInstead = await submitEditorBill(fixture);
    await correct(fixture, paidInstead.inboxItemId, [
      {
        accountId: fixture.supplies.id,
        debit: "45.50",
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.postage.id, debit: "20.00" },
      { accountId: fixture.bank.id, credit: "65.50" },
    ]);
    await expect(approve(fixture, paidInstead.inboxItemId)).rejects.toThrow(
      BILL_ACCRUAL_SHAPE_MESSAGE,
    );
    expect(await billRow(paidInstead.id)).toMatchObject({
      amount: "65.50",
      status: "in_review",
      journalHeaderId: null,
    });
    expect(await billLines(paidInstead.id)).toHaveLength(2);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
  });
});
