/**
 * A correction replaces every candidate line. It used to write none of their parties back, so
 * saving any edit in the Inbox dropped the vendor from a bill's Accounts Payable line — and the
 * posted accrual carried a payable with no counterparty. These pin that a corrected entry keeps
 * its line parties through approval.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { bills } from "@/db/schema/bills";
import { dimensions } from "@/db/schema/dimensions";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import {
  correctInboxCandidate,
  type CandidateCorrectionLineInput,
  type CorrectInboxCandidateInput,
} from "@/lib/inbox/candidate-correction";
import {
  approveInboxItem,
  createTransactionCandidate,
  type ApproveInboxResult,
} from "@/lib/inbox/service";
import { submitBillForReviewCore } from "@/lib/posting/bill-submission";

const BILL_DATE = "2026-07-21";

async function setupOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Line Party Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Line Party Organization",
    slug: `${prefix}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId,
    organizationId: orgId,
    role: "owner",
  });
  const [bank, expense, ap] = await db
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
  const [vendor, otherVendor] = await db
    .insert(parties)
    .values([
      { organizationId: orgId, name: "Paper Supply Co", partyType: "vendor" },
      { organizationId: orgId, name: "Courier Co", partyType: "vendor" },
    ])
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
    missingReceiptThreshold: "100000",
  });
  // A fresh bill has no invoice document yet; that rule is not what these tests are about.
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
  return { orgId, userId, bank, expense, ap, department, location, vendor, otherVendor };
}

type Fixture = Awaited<ReturnType<typeof setupOrganization>>;

async function inboxItem(itemId: string) {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, itemId));
  return item;
}

async function candidateLines(candidateId: string) {
  return db
    .select()
    .from(transactionCandidateLines)
    .where(eq(transactionCandidateLines.candidateId, candidateId))
    .orderBy(asc(transactionCandidateLines.sortOrder));
}

/** A classic-Inbox correction: it sends no line parties at all. */
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
        memo: "Toner",
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

async function postedLines(journalHeaderId: string) {
  return db
    .select()
    .from(journalLines)
    .where(eq(journalLines.journalHeaderId, journalHeaderId))
    .orderBy(asc(journalLines.sortOrder));
}

describe("Inbox corrections keep line parties", () => {
  it("keeps the vendor on a corrected bill's A/P line, through approval", async () => {
    const fixture = await setupOrganization("line-party-bill");
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
          dueDate: "2026-08-20",
          memo: "Toner",
          status: "in_review",
          lineItems: [
            {
              description: "Toner cartridges",
              amount: "45.50",
              accountId: fixture.expense.id,
              departmentId: fixture.department.id,
              locationId: fixture.location.id,
            },
          ],
        },
      ),
    );
    if (submitted.deduplicated) throw new Error("A first submission cannot be a replay.");
    const [candidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.organizationId, fixture.orgId));
    // The Bills editor writes the vendor on the payable line.
    expect((await candidateLines(candidate.id)).map((line) => line.partyId)).toEqual([
      null,
      fixture.vendor.id,
    ]);

    // A reviewer edits the entry in the Inbox. The correction sends no line parties.
    await correct(fixture, submitted.inboxItemId, [
      {
        accountId: fixture.expense.id,
        debit: "45.50",
        lineDescription: "Toner cartridges (black)",
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.ap.id, credit: "45.50", lineDescription: "A/P: PSC-88" },
    ]);
    const corrected = await candidateLines(candidate.id);
    expect(corrected.map((line) => [line.accountId, line.partyId])).toEqual([
      [fixture.expense.id, null],
      [fixture.ap.id, fixture.vendor.id],
    ]);

    const approval = await approve(fixture, submitted.inboxItemId);
    assertApproved(approval);
    expect(approval.billId).toBe(submitted.id);

    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, approval.journalHeaderId));
    expect(journal).toMatchObject({ partyId: fixture.vendor.id, sourceDocumentType: "bill" });
    const posted = await postedLines(approval.journalHeaderId);
    const payable = posted.find((line) => line.accountId === fixture.ap.id);
    expect(payable).toMatchObject({ credit: "45.50000000", partyId: fixture.vendor.id });
    const [bill] = await db.select().from(bills).where(eq(bills.id, submitted.id));
    expect(bill).toMatchObject({
      vendorId: fixture.vendor.id,
      status: "awaiting_payment",
      journalHeaderId: approval.journalHeaderId,
    });
  });

  it("gives an emailed bill's A/P line the entry's vendor, so the bill and its payable agree", async () => {
    const fixture = await setupOrganization("line-party-email");
    const token = randomUUID();
    const [origin] = await db
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        recordType: "email_attachment",
        externalId: `attachment:${token}`,
        transactionDate: BILL_DATE,
        description: "Courier invoice",
        economicEventClass: "bill_accrual",
        direction: "outflow",
      })
      .returning();
    const [candidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: fixture.orgId,
        sourceRecordId: origin.id,
        candidateType: "email_transaction",
        transactionDate: BILL_DATE,
        transactionType: "journal",
        memo: "Courier invoice",
        originalCurrency: "USD",
        functionalCurrency: "USD",
        exchangeRate: "1",
        submittedBy: fixture.userId,
      })
      .returning();
    await db.insert(transactionCandidateSources).values({
      organizationId: fixture.orgId,
      candidateId: candidate.id,
      sourceRecordId: origin.id,
      relationship: "origin",
      isPrimary: true,
    });
    const [item] = await db
      .insert(inboxItems)
      .values({
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        sourceRecordId: origin.id,
        itemType: "classify_source_record",
        state: "needs_information",
        title: "Courier invoice",
        submittedBy: fixture.userId,
      })
      .returning();

    await correct(
      fixture,
      item.id,
      [
        {
          accountId: fixture.expense.id,
          debit: "18.75",
          departmentId: fixture.department.id,
          locationId: fixture.location.id,
        },
        { accountId: fixture.ap.id, credit: "18.75" },
      ],
      {
        economicEventClass: "bill_accrual",
        memo: "Courier invoice",
        referenceNumber: "CC-19",
        partyId: fixture.otherVendor.id,
      },
    );
    expect((await candidateLines(candidate.id)).map((line) => line.partyId)).toEqual([
      null,
      fixture.otherVendor.id,
    ]);

    const approval = await approve(fixture, item.id);
    assertApproved(approval);
    const [bill] = await db.select().from(bills).where(eq(bills.id, approval.billId!));
    expect(bill.vendorId).toBe(fixture.otherVendor.id);
    const payable = (await postedLines(approval.journalHeaderId)).find(
      (line) => line.accountId === fixture.ap.id,
    );
    expect(payable?.partyId).toBe(fixture.otherVendor.id);
  });

  it("keeps a per-line party the correction does not mention, honors an explicit one, and refuses another org's", async () => {
    const fixture = await setupOrganization("line-party-journal");
    const other = await setupOrganization("line-party-other");
    const { inboxItem: item, candidate } = await withOrgContext(
      fixture.orgId,
      fixture.userId,
      "owner",
      (tx) =>
        createTransactionCandidate(
          { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
          {
            transactionDate: BILL_DATE,
            transactionType: "journal",
            memo: "Courier reimbursement",
            partyId: fixture.vendor.id,
            lines: [
              {
                accountId: fixture.expense.id,
                debit: "12.40",
                partyId: fixture.otherVendor.id,
                departmentId: fixture.department.id,
                locationId: fixture.location.id,
              },
              { accountId: fixture.bank.id, credit: "12.40" },
            ],
          },
        ),
    );

    // Amounts change, parties are not mentioned: each line keeps the party it had.
    await correct(fixture, item.id, [
      {
        accountId: fixture.expense.id,
        debit: "12.45",
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.bank.id, credit: "12.45" },
    ]);
    expect((await candidateLines(candidate.id)).map((line) => line.partyId)).toEqual([
      fixture.otherVendor.id,
      null,
    ]);

    // An explicit value wins, null included.
    await correct(fixture, item.id, [
      {
        accountId: fixture.expense.id,
        debit: "12.45",
        partyId: null,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.bank.id, credit: "12.45", partyId: fixture.vendor.id },
    ]);
    expect((await candidateLines(candidate.id)).map((line) => line.partyId)).toEqual([
      null,
      fixture.vendor.id,
    ]);

    await expect(
      correct(fixture, item.id, [
        {
          accountId: fixture.expense.id,
          debit: "12.45",
          partyId: other.vendor.id,
          departmentId: fixture.department.id,
          locationId: fixture.location.id,
        },
        { accountId: fixture.bank.id, credit: "12.45" },
      ]),
    ).rejects.toThrow("Every line's vendor or customer must belong to this organization.");
    const [unchanged] = await db
      .select({ revision: transactionCandidates.revision })
      .from(transactionCandidates)
      .where(
        and(
          eq(transactionCandidates.organizationId, fixture.orgId),
          eq(transactionCandidates.id, candidate.id),
        ),
      );
    expect(unchanged.revision).toBe(3);
  });
});
